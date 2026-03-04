import { BaseDocumentService, type QueryOptions } from './document-service'
import { BLOG_CHUNK_SIZE, BLOG_MAX_CHUNKS, BLOG_POST_SIZE_LIMIT, YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants'
import type { BlogPost } from '@/lib/types'
import { identifierToBase58, normalizeBytes, requireIdentifierBytes } from './sdk-helpers'
import { compressContent, decompressContent, joinChunks, splitIntoChunks } from '@/lib/utils/compression'
import { generateSlug } from '@/lib/utils/slug'

export interface BlogPostQueryOptions {
  limit?: number
  startAfter?: string
}

export interface CreateBlogPostData {
  blogId: string
  title: string
  subtitle?: string
  content: unknown
  coverImage?: string
  labels?: string
  commentsEnabled?: boolean
  slug?: string
  publishedAt?: number
}

export interface UpdateBlogPostData {
  title?: string
  subtitle?: string
  content?: unknown
  coverImage?: string
  labels?: string
  commentsEnabled?: boolean
  slug?: string
  publishedAt?: number
}

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
      labels: (data.labels ?? doc.labels) as string | undefined,
      commentsEnabled: (data.commentsEnabled ?? doc.commentsEnabled) as boolean | undefined,
      slug: (data.slug || doc.slug || '') as string,
      publishedAt: (data.publishedAt ?? doc.publishedAt) as number | undefined,
    }
  }

  async createPost(ownerId: string, data: CreateBlogPostData): Promise<BlogPost> {
    const compressed = compressContent(data.content)
    if (compressed.byteLength > BLOG_POST_SIZE_LIMIT) {
      throw new Error(`Compressed content exceeds ${BLOG_POST_SIZE_LIMIT} bytes`)
    }

    let slug = data.slug || generateSlug(data.title)
    // Check for collision and append suffix if needed
    const existing = await this.getPostBySlug(data.blogId, slug)
    if (existing) {
      slug = appendTimestampSuffix(slug)
    }

    const chunks = splitIntoChunks(compressed, BLOG_CHUNK_SIZE)
    const buildPayload = (finalSlug: string): Record<string, unknown> => {
      const payload: Record<string, unknown> = {
        blogId: requireIdentifierBytes(data.blogId, 'blogId'),
        title: data.title,
        data0: chunks[0],
        slug: finalSlug,
        publishedAt: data.publishedAt ?? Date.now(),
      }
      for (let i = 1; i < chunks.length; i++) {
        payload[`data${i}`] = chunks[i]
      }
      if (data.subtitle !== undefined) payload.subtitle = data.subtitle
      if (data.coverImage !== undefined) payload.coverImage = data.coverImage
      if (data.labels !== undefined) payload.labels = data.labels
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
    if (data.coverImage !== undefined) payload.coverImage = data.coverImage
    if (data.labels !== undefined) payload.labels = data.labels
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

  async getPostsByOwner(ownerId: string, options: BlogPostQueryOptions = {}): Promise<BlogPost[]> {
    const queryOptions: QueryOptions = {
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }

  /**
   * Get recent blog posts across all blogs for discovery.
   * Fetches latest posts per blog and merges client-side.
   */
  async getRecentPosts(blogIds: string[], limit = 20): Promise<BlogPost[]> {
    if (blogIds.length === 0) return []

    // Fetch a small number of posts per blog — we only need the global top N
    const perBlogLimit = Math.min(5, limit)
    const results = await Promise.all(
      blogIds.map(blogId =>
        this.getPostsByBlog(blogId, { limit: perBlogLimit }).catch(() => [])
      )
    )

    // Merge, sort by createdAt desc, and take top N
    return results
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
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
    const results = await Promise.all(
      blogIds.map(blogId =>
        this.getPostsByBlog(blogId, { limit: 20 }).catch(() => [])
      )
    )

    // Filter by title, subtitle, or labels matching the query
    return results
      .flat()
      .filter(post => {
        const titleMatch = post.title?.toLowerCase().includes(lowerQuery)
        const subtitleMatch = post.subtitle?.toLowerCase().includes(lowerQuery)
        const labelsMatch = post.labels?.toLowerCase().includes(lowerQuery)
        return titleMatch || subtitleMatch || labelsMatch
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }
}

export const blogPostService = new BlogPostService()
