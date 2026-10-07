import { queryDocumentBundle } from './document-query-bundle'
import { mapLimit } from './pagination-utils'
import { BaseDocumentService, type QueryOptions } from './document-service'
import { BLOG_CHUNK_SIZE, BLOG_MAX_CHUNKS, BLOG_POST_SIZE_LIMIT, YAPPR_BLOG_CONTRACT_ID, blogIsV7 } from '@/lib/constants'
import type { BlogPost } from '@/lib/types'
import { identifierToBase58, normalizeBytes, requireDocumentIdentifierBytes } from './sdk-helpers'
import { compressContent, decompressContent, joinChunks, splitIntoChunks } from '@/lib/utils/compression'
import { generateSlug } from '@/lib/utils/slug'
import { retryAsync } from '@/lib/retry-utils'
import { extractErrorMessage, isRateLimitedError } from '@/lib/error-utils'
import { BLOG_POST_TOMBSTONE, BLOG_POST_TOMBSTONE_KEEPS, isPublishedBlogPost, labelsFromStored, publishedPostsNewestFirst, storedImageUrl, storedLabels } from '@/lib/blog/content-utils'
import { logger } from '@/lib/logger'
import { tombstoneDocument } from './tombstone-helpers'

export interface BlogPostQueryOptions {
  limit?: number
  startAfter?: string
}

/** One page of the cross-blog "latest posts" feed (blog v7 `timeline`). */
export interface LatestBlogPostsPage {
  /** The page's published posts, newest first (drafts and tombstones dropped). */
  posts: BlogPost[]
  /** Where the next page starts (the last post READ, shown or not), or undefined at the end. */
  nextCursor?: string
}

export interface CreateBlogPostData {
  blogId: string
  title: string
  subtitle?: string
  content: unknown
  coverImage?: string
  labels?: string[]
  commentsEnabled?: boolean
  slug?: string
  publishedAt?: number
}

export interface UpdateBlogPostData {
  title?: string
  subtitle?: string
  content?: unknown
  coverImage?: string
  labels?: string[]
  commentsEnabled?: boolean
  slug?: string
  publishedAt?: number
}

/**
 * The pre-publish slug lookup stayed rate-limited, so the publish stopped
 * before anything was broadcast. Only this failure can promise that nothing
 * was published: a rate limit on the write's own wait may follow a broadcast
 * that landed.
 */
export class PrePublishRateLimitError extends Error {}

// Reading on to fill a blog's public slots past drafts: page size, and a cap so
// a blog of nothing but drafts cannot hold discovery up indefinitely.
const PUBLISHED_REFILL_PAGE = 20
const PUBLISHED_REFILL_MAX_PAGES = 3

function appendTimestampSuffix(slug: string): string {
  return `${slug}-${Date.now().toString(36)}`.slice(0, 63).replace(/-+$/, '')
}

class BlogPostService extends BaseDocumentService<BlogPost> {
  constructor() {
    super('blogPost', YAPPR_BLOG_CONTRACT_ID)
  }

  protected extractContentFields(doc: BlogPost): Record<string, unknown> {
    const fields = super.extractContentFields(doc)
    delete fields.content
    // `update()` merges this back into a full replace, and the transform hands
    // identifiers back as base58 — restore the raw-byte form the create path
    // writes so an edit keeps blogId byte-identical. It has to be: v2 freezes
    // blogId (`immutable`), so a replace carrying a re-encoded value would be
    // rejected outright (40128) rather than silently rewriting the reference.
    // An empty string is how the transform reports a field it could not decode;
    // drop it rather than throwing, so the required-field error describes the
    // real problem.
    if (typeof fields.blogId === 'string') {
      fields.blogId = fields.blogId ? requireDocumentIdentifierBytes(fields.blogId, 'blogId') : undefined
    }
    // Store the app's label list as the configured cut does.
    if ('labels' in fields) fields.labels = storedLabels(doc.labels, 'post')
    // Re-compress and chunk content into data0–data3 (only set chunks that exist)
    if (doc.content && Array.isArray(doc.content) && doc.content.length > 0) {
      const compressed = compressContent(doc.content)
      const chunks = splitIntoChunks(compressed, BLOG_CHUNK_SIZE)
      for (let i = 0; i < chunks.length; i++) {
        fields[`data${i}`] = chunks[i]
      }
    }
    return fields
  }

  protected transformDocument(doc: Record<string, unknown>): BlogPost {
    const data = (doc.data || doc) as Record<string, unknown>
    const rawBlogId = data.blogId || doc.blogId

    // Reassemble chunked content from data0–data3
    const chunks = Array.from({ length: BLOG_MAX_CHUNKS }, (_, i) => i).map(i => {
      const raw = data[`data${i}`] || doc[`data${i}`]
      return raw ? normalizeBytes(raw) : null
    })
    const joined = joinChunks(chunks)

    let content: Record<string, unknown>[] = []
    if (joined.byteLength > 0) {
      try {
        const decompressed = decompressContent(joined)
        if (Array.isArray(decompressed)) {
          content = decompressed as Record<string, unknown>[]
        }
      } catch {
        // Keep content empty if a stored document is malformed.
      }
    }

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt || Date.now()) as number),
      updatedAt: (doc.$updatedAt || doc.updatedAt) ? new Date((doc.$updatedAt || doc.updatedAt) as number) : undefined,
      $revision: (doc.$revision || doc.revision) as number | undefined,
      blogId: identifierToBase58(rawBlogId) || '',
      title: (data.title || doc.title || '') as string,
      subtitle: (data.subtitle ?? doc.subtitle) as string | undefined,
      content,
      coverImage: (data.coverImage ?? doc.coverImage) as string | undefined,
      labels: labelsFromStored(data.labels ?? doc.labels),
      commentsEnabled: (data.commentsEnabled ?? doc.commentsEnabled) as boolean | undefined,
      slug: (data.slug || doc.slug || '') as string,
      publishedAt: (data.publishedAt ?? doc.publishedAt) as number | undefined,
      ...((data.deleted ?? doc.deleted) === true ? { deleted: true } : {}),
    }
  }

  async createPost(ownerId: string, data: CreateBlogPostData): Promise<BlogPost> {
    const compressed = compressContent(data.content)
    if (compressed.byteLength > BLOG_POST_SIZE_LIMIT) {
      throw new Error(`Compressed content exceeds ${BLOG_POST_SIZE_LIMIT} bytes`)
    }

    const coverImage = storedImageUrl(data.coverImage, 'cover image')
    let slug = data.slug || generateSlug(data.title)
    // Check for collision and append suffix if needed. This is a read, so a
    // rate-limited one is safe to repeat before giving up on the publish. The
    // SDK rejects with a WasmSdkError, not an Error; keep its message readable.
    const lookup = await retryAsync(
      () => this.getPostBySlug(data.blogId, slug).catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(extractErrorMessage(error))
      }),
      { initialDelayMs: 1500, retryCondition: isRateLimitedError }
    )
    if (!lookup.success) {
      const error = lookup.error ?? new Error('Slug lookup failed')
      throw isRateLimitedError(error) ? new PrePublishRateLimitError(error.message) : error
    }
    if (lookup.data) {
      slug = appendTimestampSuffix(slug)
    }

    const chunks = splitIntoChunks(compressed, BLOG_CHUNK_SIZE)
    const buildPayload = (finalSlug: string): Record<string, unknown> => {
      const payload: Record<string, unknown> = {
        blogId: requireDocumentIdentifierBytes(data.blogId, 'blogId'),
        title: data.title,
        data0: chunks[0],
        slug: finalSlug,
        publishedAt: data.publishedAt ?? Date.now(),
      }
      for (let i = 1; i < chunks.length; i++) {
        payload[`data${i}`] = chunks[i]
      }
      if (data.subtitle !== undefined) payload.subtitle = data.subtitle
      // No cover is no field (v7 refuses an empty string against its URL pattern).
      if (coverImage !== undefined) payload.coverImage = coverImage
      // Empty labels are omitted (the old compose path wrote '', which v4 refuses as a non-list).
      const labels = storedLabels(data.labels, 'post')
      if (labels !== undefined) payload.labels = labels
      if (data.commentsEnabled !== undefined) payload.commentsEnabled = data.commentsEnabled
      return payload
    }

    try {
      return await this.create(ownerId, buildPayload(slug))
    } catch (error) {
      // Retry once with a fresh timestamp suffix on duplicate slug rejection
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('duplicate') || message.includes('already exists') || message.includes('unique')) {
        slug = appendTimestampSuffix(slug)
        return this.create(ownerId, buildPayload(slug))
      }
      throw error
    }
  }

  async updatePost(postId: string, ownerId: string, data: UpdateBlogPostData): Promise<BlogPost> {
    const payload: Record<string, unknown> = {}
    if (data.title !== undefined) payload.title = data.title
    if (data.subtitle !== undefined) payload.subtitle = data.subtitle
    // An empty URL clears the cover, like an explicit undefined does.
    if (data.coverImage !== undefined) payload.coverImage = storedImageUrl(data.coverImage, 'cover image')
    // An empty set clears the field (undefined), exactly as an explicit clear does.
    if (data.labels !== undefined) payload.labels = storedLabels(data.labels, 'post')
    if (data.commentsEnabled !== undefined) payload.commentsEnabled = data.commentsEnabled
    if (data.slug !== undefined) payload.slug = data.slug
    if (data.publishedAt !== undefined) payload.publishedAt = data.publishedAt

    if (typeof data.content !== 'undefined') {
      const compressed = compressContent(data.content)
      if (compressed.byteLength > BLOG_POST_SIZE_LIMIT) {
        throw new Error(`Compressed content exceeds ${BLOG_POST_SIZE_LIMIT} bytes`)
      }
      const chunks = splitIntoChunks(compressed, BLOG_CHUNK_SIZE)
      // Set all chunk slots — undefined for missing ones clears stale chunks after merge
      for (let i = 0; i < BLOG_MAX_CHUNKS; i++) {
        payload[`data${i}`] = chunks[i]
      }
    }

    return this.update(postId, ownerId, payload)
  }

  /**
   * An author's delete (blog v7): the post becomes a TOMBSTONE, `deleted` and
   * comments off with every content field gone, keeping `blogId`, `slug` and
   * `publishedAt` (`tombstoneIsBlank`; the contract freezes `deleted` once
   * set, so it cannot be undone). Posts cannot be deleted outright on any
   * cut. A banned or suspended author may still write it (`retractedWhen`),
   * but no other edit. Resolves false when the replace is refused; throws a
   * bar the network reports for anything else.
   */
  async deletePost(postId: string, ownerId: string): Promise<boolean> {
    if (!blogIsV7()) throw new Error('Posts cannot be deleted on this network')
    const deleted = await tombstoneDocument({
      contractId: this.contractId,
      documentType: this.documentType,
      documentId: postId,
      ownerId,
      preserve: BLOG_POST_TOMBSTONE_KEEPS,
      base: BLOG_POST_TOMBSTONE,
    })
    this.clearCache(postId)
    return deleted
  }

  async getPost(postId: string): Promise<BlogPost | null> {
    return this.get(postId)
  }

  async getPostBySlug(blogId: string, slug: string): Promise<BlogPost | null> {
    const result = await this.query({
      where: [['blogId', '==', blogId], ['slug', '==', slug]],
      orderBy: [['blogId', 'asc'], ['slug', 'asc']],
      limit: 1,
    })
    return result.documents[0] || null
  }

  async getPostsByBlog(blogId: string, options: BlogPostQueryOptions = {}): Promise<BlogPost[]> {
    const queryOptions: QueryOptions = {
      where: [['blogId', '==', blogId]],
      orderBy: [['blogId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }

  /**
   * Each blog's newest `limit` posts. A blog whose read fails gets none, and
   * is reported to `onBlogReadFailure`.
   */
  async getPostsByBlogs(blogIds: string[], limit: number, onBlogReadFailure?: (error: unknown) => void): Promise<Map<string, BlogPost[]>> {
    const ids = Array.from(new Set(blogIds))
    const pages = await queryDocumentBundle(ids.map(blogId => ({
      dataContractId: this.contractId, documentTypeName: this.documentType,
      where: [['blogId', '==', blogId], ['$createdAt', '>', 0]],
      orderBy: [['blogId', 'asc'], ['$createdAt', 'desc']], limit,
    })), true, onBlogReadFailure)
    return new Map(ids.map((id, index) => [id, pages[index].map(doc => this.transformDocument(doc))]))
  }

  /**
   * Up to `perBlog` published posts per blog, newest publication first. Pages
   * come in creation order, so a blog is read on (by cursor) while drafts leave
   * its slots unfilled, up to PUBLISHED_REFILL_MAX_PAGES further pages; what was
   * read is then ranked by publication date. Reading stops once the slots are
   * filled, so a backdated import (published long before it was created) holds
   * its slot over an older-created, newer-published article until newer posts
   * push it out; ranking a blog's whole history would cost reads on every load.
   */
  private async getPublishedPostsByBlogs(blogIds: string[], perBlog: number): Promise<BlogPost[][]> {
    const firstPages = await this.getPostsByBlogs(blogIds, perBlog)
    return mapLimit(Array.from(firstPages.entries()), 3, async ([blogId, firstPage]) => {
      const published = firstPage.filter(isPublishedBlogPost)
      let page = firstPage
      let pageLimit = perBlog
      for (let refills = 0; refills < PUBLISHED_REFILL_MAX_PAGES && page.length >= pageLimit && published.length < perBlog; refills++) {
        pageLimit = PUBLISHED_REFILL_PAGE
        try {
          page = await this.getPostsByBlog(blogId, { limit: pageLimit, startAfter: page[page.length - 1].id })
        } catch (error) {
          // Tolerated like the first page: this blog contributes what it has.
          logger.warn(`Reading on for published posts failed for blog ${blogId}:`, error)
          break
        }
        published.push(...page.filter(isPublishedBlogPost))
      }
      // Creation order is not publication order, so rank before cutting.
      return publishedPostsNewestFirst(published).slice(0, perBlog)
    })
  }

  /**
   * The latest posts across every blog, newest first (blog v7
   * `timeline [$createdAt]`): one query per page, no per-blog fan-out.
   * Drafts and tombstones are read but not shown, so a page can come back
   * shorter than `limit` while more remain; page on with `nextCursor`.
   */
  async getLatestPosts(options: BlogPostQueryOptions = {}): Promise<LatestBlogPostsPage> {
    const { documents, nextCursor } = await this.newestFirstPage(options.limit ?? 20, options.startAfter)
    return { posts: documents.filter(isPublishedBlogPost), nextCursor }
  }

  /**
   * Get recent blog posts across all blogs for discovery.
   * Fetches latest posts per blog and merges client-side.
   */
  async getRecentPosts(blogIds: string[], limit = 20): Promise<BlogPost[]> {
    if (blogIds.length === 0) return []

    // Fetch enough posts per blog to fill the requested limit
    const perBlogLimit = Math.min(Math.ceil(limit / blogIds.length), limit)
    const results = await this.getPublishedPostsByBlogs(blogIds, perBlogLimit)

    // Merge, drop drafts, sort by publication date desc, and take top N
    return publishedPostsNewestFirst(results.flat()).slice(0, limit)
  }

  /**
   * Search blog posts by title or subtitle text.
   * Phase 1 limitation: this fetches up to 100 posts per blog and filters client-side.
   * Since Dash Platform doesn't support full-text search,
   * this fetches posts per blog and filters client-side.
   */
  async searchPosts(blogIds: string[], query: string, limit = 20): Promise<BlogPost[]> {
    if (blogIds.length === 0 || !query.trim()) return []

    const lowerQuery = query.toLowerCase()

    // Fetch a reasonable number of posts per blog for client-side filtering
    const results = await this.getPublishedPostsByBlogs(blogIds, 20)

    // Filter by title, subtitle, or labels matching the query
    return publishedPostsNewestFirst(results.flat())
      .filter(post => {
        const titleMatch = post.title?.toLowerCase().includes(lowerQuery)
        const subtitleMatch = post.subtitle?.toLowerCase().includes(lowerQuery)
        const labelsMatch = post.labels?.some(label => label.toLowerCase().includes(lowerQuery))
        return titleMatch || subtitleMatch || labelsMatch
      })
      .slice(0, limit)
  }
}

export const blogPostService = new BlogPostService()
