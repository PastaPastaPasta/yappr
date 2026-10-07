import { BaseDocumentService, type QueryOptions } from './document-service'
import type { Blog } from '@/lib/types'
import type { BlogThemeConfig } from '@/lib/blog/theme-types'
import { normalizeBlogThemeConfig } from '@/lib/blog/theme-types'
import { YAPPR_BLOG_CONTRACT_ID, blogIsV7 } from '@/lib/constants'
import { labelsFromStored, storedImageUrl, storedLabels } from '@/lib/blog/content-utils'
import { normalizeBytes } from './sdk-helpers'
import { compressContent, decompressContent } from '@/lib/utils/compression'

const newestFirst = (blogs: Blog[]) => [...blogs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

export interface CreateBlogData {
  name: string
  description?: string
  headerImage?: string
  avatar?: string
  themeConfig?: BlogThemeConfig
  commentsEnabledDefault?: boolean
  labels?: string[]
}

export interface UpdateBlogData extends Partial<CreateBlogData> {}

/** One page of blogs, newest first (blog v7 `blog.timeline`). */
export interface BlogTimelinePage {
  blogs: Blog[]
  /** Where the next page starts, or undefined at the end. */
  nextCursor?: string
}

/** The most blogs one timeline query returns. */
const BLOG_PAGE_SIZE = 100

function deserializeThemeConfig(raw: unknown): BlogThemeConfig | undefined {
  if (!raw) return undefined

  const bytes = normalizeBytes(raw)
  if (bytes) {
    const decompressed = decompressContent(bytes)
    if (decompressed && typeof decompressed === 'object') {
      return normalizeBlogThemeConfig(decompressed as Partial<BlogThemeConfig>)
    }
  }

  // Uncompressed JSON string, the shape before compression was added.
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

  // Deployments without a provisioned blog contract blank the id (see
  // .env.devnet); reads fail closed as "no blogs" instead of erroring.
  isConfigured(): boolean {
    return Boolean(YAPPR_BLOG_CONTRACT_ID)
  }

  protected extractContentFields(doc: Blog): Record<string, unknown> {
    const fields = super.extractContentFields(doc)
    // Serialize themeConfig back to compressed bytes for platform
    if (fields.themeConfig && typeof fields.themeConfig === 'object' && !(fields.themeConfig instanceof Uint8Array)) {
      fields.themeConfig = serializeThemeConfig(fields.themeConfig as BlogThemeConfig)
    }
    // Store the app's label list as the configured cut does.
    if ('labels' in fields) fields.labels = storedLabels(doc.labels, 'blog')
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
      labels: labelsFromStored(data.labels ?? doc.labels),
    }
  }

  private prepareData(data: UpdateBlogData): Record<string, unknown> {
    const result: Record<string, unknown> = { ...data }
    if (result.themeConfig && typeof result.themeConfig === 'object' && !(result.themeConfig instanceof Uint8Array)) {
      result.themeConfig = serializeThemeConfig(result.themeConfig as BlogThemeConfig)
    }
    // An explicit `undefined` clears labels during the replace merge; keep it.
    if (data.labels !== undefined) result.labels = storedLabels(data.labels, 'blog')
    // Likewise for the images; an empty URL clears one (v7 refuses '' outright).
    if ('avatar' in data) result.avatar = storedImageUrl(data.avatar, 'avatar')
    if ('headerImage' in data) result.headerImage = storedImageUrl(data.headerImage, 'header image')
    return result
  }

  async createBlog(ownerId: string, data: CreateBlogData): Promise<Blog> {
    const cleaned = Object.fromEntries(
      Object.entries(this.prepareData(data)).filter(([, v]) => v !== undefined)
    )
    return this.create(ownerId, cleaned)
  }

  async updateBlog(blogId: string, ownerId: string, data: UpdateBlogData): Promise<Blog> {
    // Explicit undefined values clear optional fields during the replacement merge.
    // Omitted fields stay untouched; do not discard that distinction here.
    return this.update(blogId, ownerId, this.prepareData(data))
  }

  async getBlog(blogId: string): Promise<Blog | null> {
    if (!this.isConfigured()) return null
    return this.get(blogId)
  }

  async getBlogsByOwner(ownerId: string): Promise<Blog[]> {
    if (!this.isConfigured()) return []
    const options: QueryOptions = {
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
    }
    const result = await this.query(options)
    return result.documents
  }

  /**
   * One page of every blog, newest first, on blog v7's `timeline
   * [$createdAt]`: a single query per page, paged with `nextCursor`.
   */
  async getBlogTimelinePage(options: { limit?: number; startAfter?: string } = {}): Promise<BlogTimelinePage> {
    if (!this.isConfigured()) return { blogs: [] }
    const { documents, nextCursor } = await this.newestFirstPage(Math.min(options.limit ?? BLOG_PAGE_SIZE, BLOG_PAGE_SIZE), options.startAfter)
    return { blogs: documents, nextCursor }
  }

  /**
   * The newest `limit` blogs on the platform (for discovery). On v7 that is
   * the head of `blog.timeline`. Earlier cuts index blogs only by
   * `[$ownerId, $createdAt]`, so they page in owner order and sort
   * client-side by createdAt desc, which only orders the blogs read.
   */
  async getAllBlogs(limit = 100): Promise<Blog[]> {
    if (!this.isConfigured()) return []
    const timeline = blogIsV7()
    const blogs: Blog[] = []
    let startAfter: string | undefined
    while (blogs.length < limit) {
      const pageLimit = Math.min(BLOG_PAGE_SIZE, limit - blogs.length)
      const page = timeline
        ? await this.newestFirstPage(pageLimit, startAfter)
        : await this.cursorPage({ orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: pageLimit, startAfter })
      blogs.push(...page.documents)
      startAfter = page.nextCursor
      if (!startAfter) break
    }
    return timeline ? blogs : newestFirst(blogs)
  }
}

export const blogService = new BlogService()
