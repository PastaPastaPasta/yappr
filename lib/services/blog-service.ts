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
   * Fetches in batches using cursor-based pagination.
   * Note: This queries by $ownerId index, so we page through all owners.
   */
  async getAllBlogs(limit = 100): Promise<Blog[]> {
    const blogs: Blog[] = []
    const pageSize = Math.min(100, limit)
    const seenBlogIds = new Set<string>()
    let lastCreatedAt: number | null = null

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining = limit - blogs.length
      if (remaining <= 0) break

      const queryOptions: QueryOptions = {
        orderBy: [['$createdAt', 'desc']],
        limit: Math.min(pageSize, remaining),
        ...(lastCreatedAt !== null ? { where: [['$createdAt', '<=', lastCreatedAt]] } : {}),
      }

      const result = await this.query(queryOptions)

      if (result.documents.length === 0) break

      const newBlogs = result.documents.filter((blog) => {
        if (seenBlogIds.has(blog.id)) return false
        seenBlogIds.add(blog.id)
        return true
      })

      if (newBlogs.length === 0) {
        break
      }

      const nextBlogs = newBlogs.slice(0, remaining)
      blogs.push(...nextBlogs)
      lastCreatedAt = result.documents[result.documents.length - 1].createdAt.getTime()

      // If we got fewer than requested, no more pages
      if (result.documents.length < Math.min(pageSize, remaining)) {
        break
      }

      if (remaining <= nextBlogs.length) {
        break
      }
    }

    return blogs
  }
}

export const blogService = new BlogService()
