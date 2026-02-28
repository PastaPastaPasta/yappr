import { BaseDocumentService, type QueryOptions } from './document-service'
import { BLOG_POST_SIZE_LIMIT, YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants'
import type { BlogPost } from '@/lib/types'
import { identifierToBase58, normalizeBytes, requireIdentifierBytes } from './sdk-helpers'
import { compressContent, decompressContent } from '@/lib/utils/compression'
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

class BlogPostService extends BaseDocumentService<BlogPost> {
  constructor() {
    super('blogPost', YAPPR_BLOG_CONTRACT_ID)
  }

  protected transformDocument(doc: Record<string, unknown>): BlogPost {
    const data = (doc.data || doc) as Record<string, unknown>
    const rawBlogId = data.blogId || doc.blogId
    const rawContent = data.content || doc.content
    const contentBytes = rawContent ? normalizeBytes(rawContent) : null
    let content: Record<string, unknown>[] = []
    if (contentBytes) {
      try {
        const decompressed = decompressContent(contentBytes)
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
      subtitle: (data.subtitle || doc.subtitle) as string | undefined,
      content,
      compressedContent: contentBytes || undefined,
      coverImage: (data.coverImage || doc.coverImage) as string | undefined,
      labels: (data.labels || doc.labels) as string | undefined,
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

    const payload: Record<string, unknown> = {
      blogId: requireIdentifierBytes(data.blogId, 'blogId'),
      title: data.title,
      content: compressed,
      slug: data.slug || generateSlug(data.title),
      publishedAt: data.publishedAt ?? Date.now(),
    }
    if (data.subtitle !== undefined) payload.subtitle = data.subtitle
    if (data.coverImage !== undefined) payload.coverImage = data.coverImage
    if (data.labels !== undefined) payload.labels = data.labels
    if (data.commentsEnabled !== undefined) payload.commentsEnabled = data.commentsEnabled

    return this.create(ownerId, payload)
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
    if (data.title !== undefined && data.slug === undefined) {
      payload.slug = generateSlug(data.title)
    }

    if (typeof data.content !== 'undefined') {
      const compressed = compressContent(data.content)
      if (compressed.byteLength > BLOG_POST_SIZE_LIMIT) {
        throw new Error(`Compressed content exceeds ${BLOG_POST_SIZE_LIMIT} bytes`)
      }
      payload.content = compressed
    }

    return this.update(postId, ownerId, payload)
  }

  async getPost(postId: string): Promise<BlogPost | null> {
    return this.get(postId)
  }

  async getPostBySlug(blogId: string, slug: string): Promise<BlogPost | null> {
    const blogIdBytes = Array.from(requireIdentifierBytes(blogId, 'blogId'))
    const result = await this.query({
      where: [['blogId', '==', blogIdBytes], ['slug', '==', slug]],
      orderBy: [['blogId', 'asc'], ['slug', 'asc']],
      limit: 1,
    })
    return result.documents[0] || null
  }

  async getPostsByBlog(blogId: string, options: BlogPostQueryOptions = {}): Promise<BlogPost[]> {
    const blogIdBytes = Array.from(requireIdentifierBytes(blogId, 'blogId'))
    const queryOptions: QueryOptions = {
      where: [['blogId', '==', blogIdBytes]],
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

    // Fetch `limit` posts per blog to avoid missing recent posts from active blogs
    const results = await Promise.all(
      blogIds.map(blogId =>
        this.getPostsByBlog(blogId, { limit }).catch(() => [])
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

    // Fetch all available posts per blog (no hard cap) so search is comprehensive
    const results = await Promise.all(
      blogIds.map(blogId =>
        this.getPostsByBlog(blogId, { limit: 100 }).catch(() => [])
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
