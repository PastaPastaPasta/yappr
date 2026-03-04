import { BaseDocumentService, type QueryOptions } from './document-service'
import type { Blog } from '@/lib/types'
import type { BlogThemeConfig } from '@/lib/blog/theme-types'
import { normalizeBlogThemeConfig } from '@/lib/blog/theme-types'
import { YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants'
import { normalizeBytes } from './sdk-helpers'
import { compressContent, decompressContent } from '@/lib/utils/compression'

export interface CreateBlogData {
  name: string
  description?: string
  headerImage?: string
  avatar?: string
  themeConfig?: BlogThemeConfig
  commentsEnabledDefault?: boolean
  labels?: string
}

export interface UpdateBlogData extends Partial<CreateBlogData> {}

function deserializeThemeConfig(raw: unknown): BlogThemeConfig | undefined {
  if (!raw) return undefined

  const bytes = normalizeBytes(raw)
  if (bytes) {
    const decompressed = decompressContent(bytes)
    if (decompressed && typeof decompressed === 'object') {
      return normalizeBlogThemeConfig(decompressed as Partial<BlogThemeConfig>)
    }
  }

  // Fallback for legacy string format
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Partial<BlogThemeConfig>
      return normalizeBlogThemeConfig(parsed)
    } catch {
      return undefined
    }
  }

  return undefined
}

function serializeThemeConfig(config: BlogThemeConfig): Uint8Array {
  const normalized = normalizeBlogThemeConfig(config)
  return compressContent(normalized)
}

class BlogService extends BaseDocumentService<Blog> {
  constructor() {
    super('blog', YAPPR_BLOG_CONTRACT_ID)
  }

  protected extractContentFields(doc: Blog): Record<string, unknown> {
    const fields = super.extractContentFields(doc)
    // Serialize themeConfig back to compressed bytes for platform
    if (fields.themeConfig && typeof fields.themeConfig === 'object' && !(fields.themeConfig instanceof Uint8Array)) {
      fields.themeConfig = serializeThemeConfig(fields.themeConfig as BlogThemeConfig)
    }
    return fields
  }

  protected transformDocument(doc: Record<string, unknown>): Blog {
    const data = (doc.data || doc) as Record<string, unknown>

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt || Date.now()) as number),
      updatedAt: (doc.$updatedAt || doc.updatedAt) ? new Date((doc.$updatedAt || doc.updatedAt) as number) : undefined,
      $revision: (doc.$revision || doc.revision) as number | undefined,
      name: (data.name || doc.name || '') as string,
      description: (data.description || doc.description) as string | undefined,
      headerImage: (data.headerImage || doc.headerImage) as string | undefined,
      avatar: (data.avatar || doc.avatar) as string | undefined,
      themeConfig: deserializeThemeConfig(data.themeConfig || doc.themeConfig),
      commentsEnabledDefault: (data.commentsEnabledDefault ?? doc.commentsEnabledDefault) as boolean | undefined,
      labels: (data.labels || doc.labels) as string | undefined,
    }
  }

  private prepareData(data: Record<string, unknown>): Record<string, unknown> {
    const result = { ...data }
    if (result.themeConfig && typeof result.themeConfig === 'object' && !(result.themeConfig instanceof Uint8Array)) {
      result.themeConfig = serializeThemeConfig(result.themeConfig as BlogThemeConfig)
    }
    return result
  }

  async createBlog(ownerId: string, data: CreateBlogData): Promise<Blog> {
    const cleaned = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    )
    return this.create(ownerId, this.prepareData(cleaned))
  }

  async updateBlog(blogId: string, ownerId: string, data: UpdateBlogData): Promise<Blog> {
    const cleaned = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    )
    return this.update(blogId, ownerId, this.prepareData(cleaned))
  }

  async getBlog(blogId: string): Promise<Blog | null> {
    return this.get(blogId)
  }

  async getBlogsByOwner(ownerId: string): Promise<Blog[]> {
    const options: QueryOptions = {
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
    }
    const result = await this.query(options)
    return result.documents
  }

  /**
   * Get all blogs on the platform (for discovery).
   * Uses the ownerAndTime index [$ownerId, $createdAt] with cursor-based pagination,
   * then sorts client-side by createdAt desc for display.
   */
  async getAllBlogs(limit = 100): Promise<Blog[]> {
    const blogs: Blog[] = []
    const pageSize = Math.min(100, limit)
    let startAfter: string | undefined

    while (blogs.length < limit) {
      const remaining = limit - blogs.length
      const batchLimit = Math.min(pageSize, remaining)

      const queryOptions: QueryOptions = {
        orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
        limit: batchLimit,
        startAfter,
      }

      const result = await this.query(queryOptions)
      if (result.documents.length === 0) break

      blogs.push(...result.documents)
      startAfter = result.documents[result.documents.length - 1].id

      if (result.documents.length < batchLimit) break
    }

    // Sort client-side by newest first
    blogs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    return blogs.slice(0, limit)
  }
}

export const blogService = new BlogService()
