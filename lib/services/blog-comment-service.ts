import { queryDocumentBundle } from './document-query-bundle'
import { documentCount, groupedDocumentCount, mapLimit, paginateCount } from './pagination-utils'
import { BaseDocumentService, type QueryOptions } from './document-service'
import { YAPPR_BLOG_CONTRACT_ID, blogCommentsCopyPostFlag, blogCommentsDerivePostOwner, blogIsV2, blogIsV8, blogModPin, lanePinOrderBy } from '@/lib/constants'
import { carryModerationIntoReplace, moderationFieldOf, withoutHidden } from './moderation-carry'
import type { BlogComment } from '@/lib/types'
import { identifierToBase58, requireDocumentIdentifierBytes } from './sdk-helpers'
import { isPropertyAgreementError } from '@/lib/error-utils'
import { getEvoSdk } from './evo-sdk-service'
import { blogStatsService } from './blog-stats-service'
import { isBlogPostTombstone } from '@/lib/blog/content-utils'

/** What a reader sees when the post takes no comments (turned off, or deleted on v8, where the tombstone has them off). */
export const COMMENTS_OFF_MESSAGE = 'Comments are turned off for this post'

export interface BlogCommentQueryOptions {
  limit?: number
  startAfter?: string
}

class BlogCommentService extends BaseDocumentService<BlogComment> {
  constructor() {
    super('blogComment', YAPPR_BLOG_CONTRACT_ID)
  }

  /** A replace (the client writes none today) sends a moderator's `mod`/`modLabel` back unchanged (41124 otherwise). */
  protected extractContentFields(doc: BlogComment): Record<string, unknown> {
    const fields = super.extractContentFields(doc)
    carryModerationIntoReplace(fields, doc)
    return fields
  }

  protected transformDocument(doc: Record<string, unknown>): BlogComment {
    const data = (doc.data || doc) as Record<string, unknown>

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt || Date.now()) as number),
      blogPostId: identifierToBase58(data.blogPostId || doc.blogPostId) || '',
      blogPostOwnerId: identifierToBase58(data.blogPostOwnerId || doc.blogPostOwnerId) || undefined,
      content: (data.content || doc.content || '') as string,
      ...moderationFieldOf(doc),
    }
  }

  /**
   * The value `blogPostOwnerId` must carry. On v2 consensus checks it against
   * the post's own `$ownerId` (a system-field propertyAgreement on
   * `blogPostId`), so a caller's idea of who owns the post is not good enough —
   * the post is fetched and its real owner used verbatim. On v1 nothing is
   * checked and the caller's value stands. On v5 the same read also supplies
   * the post's `commentsEnabled`, which the comment must copy. On v6 the owner
   * is derived through `blogPostId` and not written, but the read is still the
   * one that supplies `commentsEnabled`. On v8 neither is written (consensus
   * checks the flag through the `blogPostId` reference), so nothing is read.
   */
  private async resolvePostLinkage(blogPostId: string, fallback: string, fresh = false): Promise<{ ownerId: string; postFields: Record<string, boolean> }> {
    if (!blogIsV2() || blogIsV8()) return { ownerId: fallback, postFields: {} }
    const { blogPostService } = await import('./blog-post-service')
    if (fresh) blogPostService.clearCache(blogPostId)
    // `get()` swallows read failures and returns null, so an absent post is
    // indistinguishable from a timed-out node. Prefer the caller's value over
    // refusing to comment: consensus (40127) is the real arbiter, and a
    // rejected create charges nothing (no YAPP up to v6, no action fee on v7).
    const post = await blogPostService.getPost(blogPostId)
    const ownerId = post?.ownerId || fallback
    if (!ownerId) throw new Error('Cannot resolve the post owner for this comment')
    if (!blogCommentsCopyPostFlag()) return { ownerId, postFields: {} }
    // v5: `postCommentsEnabled` must equal the post's `commentsEnabled`, absence
    // included (40127), and `false` is refused (`commentsOpen`, 10422). Guessing
    // the flag would be refused for every post that stores one, so an unread
    // post stops the comment here instead.
    if (!post) throw new Error('Could not load this post to check that it takes comments. Try again.')
    // A tombstone stores comments off too (v7 `tombstoneIsBlank`); say why.
    if (isBlogPostTombstone(post)) throw new Error('This post was deleted, so it takes no comments')
    if (post.commentsEnabled === false) throw new Error(COMMENTS_OFF_MESSAGE)
    // Only a stored boolean is copied: an absent (or null) flag agrees with an absent copy.
    return { ownerId, postFields: typeof post.commentsEnabled === 'boolean' ? { postCommentsEnabled: post.commentsEnabled } : {} }
  }

  async createComment(
    ownerId: string,
    blogPostId: string,
    blogPostOwnerId: string,
    content: string
  ): Promise<BlogComment> {
    const trimmedContent = content.trim()
    if (!trimmedContent) {
      throw new Error('Comment content is required')
    }
    if (trimmedContent.length > 500) {
      throw new Error('Comment content exceeds 500 characters')
    }

    const write = async (fresh: boolean) => {
      const { ownerId: postOwnerId, postFields } = await this.resolvePostLinkage(blogPostId, blogPostOwnerId, fresh)
      return this.create(ownerId, {
        blogPostId: requireDocumentIdentifierBytes(blogPostId, 'blogPostId'),
        ...(blogCommentsDerivePostOwner() ? {} : { blogPostOwnerId: requireDocumentIdentifierBytes(postOwnerId, 'blogPostOwnerId') }),
        content: trimmedContent,
        ...postFields,
      })
    }
    let comment: BlogComment
    try {
      comment = await write(false)
    } catch (error) {
      if (!isPropertyAgreementError(error)) throw error
      // v8: the only agreement a comment carries is the `blogPostId` condition,
      // so a 40127 means the post takes no comments (turned off, or deleted).
      if (blogIsV8()) throw new Error(COMMENTS_OFF_MESSAGE)
      // v5-v7: the copied owner (up to v5) or commentsEnabled no longer agrees
      // with the post, most likely because a cached read went stale (the author just
      // turned comments off, say). A refused create charges nothing: re-read the
      // post past the cache and try once more; a post now closed stops there.
      if (!blogCommentsCopyPostFlag()) throw error
      comment = await write(true)
    }
    // The comment changed this post's count tree and the "most discussed" page.
    blogStatsService.invalidate()
    return comment
  }

  async deleteComment(commentId: string, ownerId: string): Promise<boolean> {
    const comment = await this.get(commentId)
    if (!comment || comment.ownerId !== ownerId) {
      return false
    }
    const deleted = await this.delete(commentId, ownerId)
    if (deleted) blogStatsService.invalidate()
    return deleted
  }

  async getCommentsByPost(blogPostId: string, options: BlogCommentQueryOptions = {}): Promise<BlogComment[]> {
    const queryOptions: QueryOptions = {
      where: [['blogPostId', '==', blogPostId], ...blogModPin()],
      orderBy: [['blogPostId', 'asc'], ...lanePinOrderBy(blogModPin()), ['$createdAt', 'asc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }

  /**
   * One proved count: v2–v6 read the `commentCount [blogPostId]` tree, v7 the
   * merged `postAndTime [blogPostId, $createdAt]` (rangeCountable: a
   * `blogPostId ==` pin is its prefix total; same query). A cursor scan on v1.
   */
  async countCommentsByPost(blogPostId: string): Promise<number> {
    try {
      const sdk = await getEvoSdk()
      if (blogIsV2()) {
        return await documentCount(sdk, {
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [['blogPostId', '==', blogPostId], ...blogModPin()],
        })
      }
      const { count } = await paginateCount(sdk, () => ({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['blogPostId', '==', blogPostId]],
        orderBy: [['blogPostId', 'asc'], ['$createdAt', 'asc']],
      }))
      return count
    } catch {
      return 0
    }
  }

  /**
   * Comment totals for a list of posts. On v2+ that is ONE grouped count over
   * the `commentCount` tree (v7: the merged `postAndTime`, read the same way:
   * `blogPostId in` + groupBy); on v1 no countable index is deployed, so first
   * pages are bundled and only posts with 100+ comments pay a full cursor scan.
   */
  async countCommentsByPostBatch(postIds: string[]): Promise<Map<string, number>> {
    const ids = Array.from(new Set(postIds))
    if (blogIsV2()) {
      const sdk = await getEvoSdk()
      return groupedDocumentCount(
        sdk,
        // v10: the listed lane, `mod == null`, is pinned beside the grouped `in` (index `[blogPostId, mod, $createdAt]`).
        { dataContractId: this.contractId, documentTypeName: this.documentType, groupField: 'blogPostId', where: blogModPin() },
        ids,
        (id) => this.countCommentsByPost(id)
      )
    }
    const pages = await queryDocumentBundle(ids.map(blogPostId => ({
      dataContractId: this.contractId, documentTypeName: this.documentType,
      where: [['blogPostId', '==', blogPostId], ['$createdAt', '>', 0]],
      orderBy: [['blogPostId', 'asc'], ['$createdAt', 'asc']], limit: 100,
    })), true)
    const counts = await mapLimit(ids, 3, async (id, index) => [
      id, pages[index].length === 100 ? await this.countCommentsByPost(id) : pages[index].length,
    ] as const)
    return new Map(counts)
  }

  /**
   * Comments other people left on MY posts since `since` (ms) — the v2
   * `postOwnerAndTime` index. One page, newest-relevant first by index order;
   * v1 has no such index and returns nothing. From v6 the index's first
   * property is the derived `blogPostId.$ownerId`; a query paging with a
   * cursor must pin it with `==`, and this one pins it anyway.
   */
  async getCommentsOnMyPosts(ownerId: string, since: number, limit = 50): Promise<BlogComment[]> {
    if (!blogIsV2() || !ownerId) return []
    const postOwner = blogCommentsDerivePostOwner() ? 'blogPostId.$ownerId' : 'blogPostOwnerId'
    const result = await this.query({
      where: [[postOwner, '==', ownerId], ['$createdAt', '>', since]],
      orderBy: [[postOwner, 'asc'], ['$createdAt', 'desc']],
      limit,
    })
    // `postOwnerAndTime` is not laned: a hidden comment is read too, and dropped here.
    return withoutHidden(result.documents).filter((comment) => comment.ownerId !== ownerId)
  }
}

export const blogCommentService = new BlogCommentService()
