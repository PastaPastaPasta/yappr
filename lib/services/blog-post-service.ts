import { BaseDocumentService, type QueryOptions } from './document-service'
import { BLOG_POST_SIZE_LIMIT, YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants'
import type { BlogPost } from '@/lib/types'
import { base58ToBytes, identifierToBase58, normalizeBytes } from './sdk-helpers'
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

function requireIdentifierBytes(id: string, fieldName: string): Uint8Array {
  const bytes = base58ToBytes(id)
  if (!bytes || bytes.length !== 32) {
    throw new Error(`Invalid ${fieldName}: expected base58 identifier`)
  }
  return bytes
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

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt || Date.now()) as number),
      updatedAt: (doc.$updatedAt || doc.updatedAt) ? new Date((doc.$updatedAt || doc.updatedAt) as number) : undefined,
      $revision: (doc.$revision || doc.revision) as number | undefined,
      blogId: identifierToBase58(rawBlogId) || '',
      title: (data.title || doc.title || '') as string,
      subtitle: (data.subtitle || doc.subtitle) as string | undefined,
      content: contentBytes ? decompressContent(contentBytes) : [],
      compressedContent: contentBytes || undefined,
      coverImage: (data.coverImage || doc.coverImage) as string | undefined,
      labels: (data.labels || doc.labels) as string | undefined,
      commentsEnabled: (data.commentsEnabled ?? doc.commentsEnabled) as boolean | undefined,
      slug: (data.slug || doc.slug || '') as string,
      publishedAt: (data.publishedAt ?? doc.publishedAt) as number | undefined,
    }
  }

  async createPost(ownerId: string, data: CreateBlogPostData): Promise<BlogPost> {
    if (data.content == null || (Array.isArray(data.content) && data.content.length === 0)) {
      throw new Error('Content cannot be empty')
    }

    const compressed = compressContent(data.content)
    if (compressed.byteLength > BLOG_POST_SIZE_LIMIT) {
      throw new Error(`Compressed content exceeds ${BLOG_POST_SIZE_LIMIT} bytes`)
    }

    const payload: Record<string, unknown> = {
      blogId: requireIdentifierBytes(data.blogId, 'blogId'),
      title: data.title,
      content: compressed,
      slug: data.slug || generateSlug(data.title),
      subtitle: data.subtitle,
      coverImage: data.coverImage,
      labels: data.labels,
      commentsEnabled: data.commentsEnabled,
      publishedAt: data.publishedAt ?? Date.now(),
    }

    return this.create(ownerId, payload)
  }

  async updatePost(postId: string, ownerId: string, data: UpdateBlogPostData): Promise<BlogPost> {
    const payload: Record<string, unknown> = {
      title: data.title,
      subtitle: data.subtitle,
      coverImage: data.coverImage,
      labels: data.labels,
      commentsEnabled: data.commentsEnabled,
      slug: data.slug,
      publishedAt: data.publishedAt,
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
    const blogIdBytes = requireIdentifierBytes(blogId, 'blogId')
    const result = await this.query({
      where: [['blogId', '==', blogIdBytes], ['slug', '==', slug]],
      // orderBy required by Dash Platform query engine to match the blogAndSlug index
      orderBy: [['blogId', 'asc'], ['slug', 'asc']],
      limit: 1,
    })
    return result.documents[0] || null
  }

  async getPostsByBlog(blogId: string, options: BlogPostQueryOptions = {}): Promise<BlogPost[]> {
    const blogIdBytes = requireIdentifierBytes(blogId, 'blogId')
    const queryOptions: QueryOptions = {
      where: [['blogId', '==', blogIdBytes]],
      orderBy: [['$createdAt', 'desc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }

  async getPostsByOwner(ownerId: string, options: BlogPostQueryOptions = {}): Promise<BlogPost[]> {
    const queryOptions: QueryOptions = {
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$createdAt', 'desc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }
}

export const blogPostService = new BlogPostService()
