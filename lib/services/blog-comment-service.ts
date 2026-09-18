import { queryDocumentBundle } from './document-query-bundle'
import { documentCount, groupedDocumentCount, mapLimit, paginateCount } from './pagination-utils'
import { BaseDocumentService, type QueryOptions } from './document-service'
import { YAPPR_BLOG_CONTRACT_ID, blogIsV2 } from '@/lib/constants'
import type { BlogComment } from '@/lib/types'
import { identifierToBase58, requireDocumentIdentifierBytes } from './sdk-helpers'
import { getEvoSdk } from './evo-sdk-service'
import { blogStatsService } from './blog-stats-service'

export interface BlogCommentQueryOptions {
  limit?: number
  startAfter?: string
}

class BlogCommentService extends BaseDocumentService<BlogComment> {
  constructor() {
    super('blogComment', YAPPR_BLOG_CONTRACT_ID)
  }

  protected transformDocument(doc: Record<string, unknown>): BlogComment {
    const data = (doc.data || doc) as Record<string, unknown>

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt || Date.now()) as number),
      blogPostId: identifierToBase58(data.blogPostId || doc.blogPostId) || '',
      blogPostOwnerId: identifierToBase58(data.blogPostOwnerId || doc.blogPostOwnerId) || '',
      content: (data.content || doc.content || '') as string,
    }
  }

  /**
   * The value `blogPostOwnerId` must carry. On v2 consensus checks it against
   * the post's own `$ownerId` (a system-field propertyAgreement on
   * `blogPostId`), so a caller's idea of who owns the post is not good enough —
   * the post is fetched and its real owner used verbatim. On v1 nothing is
   * checked and the caller's value stands.
   */
  private async resolvePostOwnerId(blogPostId: string, fallback: string): Promise<string> {
    if (!blogIsV2()) return fallback
    const { blogPostService } = await import('./blog-post-service')
    // `get()` swallows read failures and returns null, so an absent post is
    // indistinguishable from a timed-out node. Prefer the caller's value over
    // refusing to comment: consensus (40127) is the real arbiter, and a
    // rejected create charges no YAPP.
    const post = await blogPostService.getPost(blogPostId)
    const owner = post?.ownerId || fallback
    if (!owner) throw new Error('Cannot resolve the post owner for this comment')
    return owner
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

    const postOwnerId = await this.resolvePostOwnerId(blogPostId, blogPostOwnerId)
    const comment = await this.create(ownerId, {
      blogPostId: requireDocumentIdentifierBytes(blogPostId, 'blogPostId'),
      blogPostOwnerId: requireDocumentIdentifierBytes(postOwnerId, 'blogPostOwnerId'),
      content: trimmedContent,
    })
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
      where: [['blogPostId', '==', blogPostId]],
      orderBy: [['blogPostId', 'asc'], ['$createdAt', 'asc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }

  /** One proved count on v2's `commentCount` tree; a cursor scan on v1. */
  async countCommentsByPost(blogPostId: string): Promise<number> {
    try {
      const sdk = await getEvoSdk()
      if (blogIsV2()) {
        return await documentCount(sdk, {
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [['blogPostId', '==', blogPostId]],
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
   * Comment totals for a list of posts. On v2 that is ONE grouped count over
   * the `commentCount` tree; on v1 no countable index is deployed, so first
   * pages are bundled and only posts with 100+ comments pay a full cursor scan.
   */
  async countCommentsByPostBatch(postIds: string[]): Promise<Map<string, number>> {
    const ids = Array.from(new Set(postIds))
    if (blogIsV2()) {
      const sdk = await getEvoSdk()
      return groupedDocumentCount(
        sdk,
        { dataContractId: this.contractId, documentTypeName: this.documentType, groupField: 'blogPostId' },
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

  async getCommentsByOwner(ownerId: string, options: BlogCommentQueryOptions = {}): Promise<BlogComment[]> {
    const queryOptions: QueryOptions = {
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }

  /**
   * Comments other people left on MY posts since `since` (ms) — the v2
   * `postOwnerAndTime` index. One page, newest-relevant first by index order;
   * v1 has no such index and returns nothing.
   */
  async getCommentsOnMyPosts(ownerId: string, since: number, limit = 50): Promise<BlogComment[]> {
    if (!blogIsV2() || !ownerId) return []
    const result = await this.query({
      where: [['blogPostOwnerId', '==', ownerId], ['$createdAt', '>', since]],
      orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']],
      limit,
    })
    return result.documents.filter((comment) => comment.ownerId !== ownerId)
  }
}

export const blogCommentService = new BlogCommentService()
