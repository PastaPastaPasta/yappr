import { BaseDocumentService, type QueryOptions } from './document-service'
import type { Blog } from '@/lib/types'
import type { BlogThemeConfig } from '@/lib/blog/theme-types'
import { normalizeBlogThemeConfig } from '@/lib/blog/theme-types'
import { YAPPR_BLOG_CONTRACT_ID, blogIsV7 } from '@/lib/constants'
import { labelsFromStored, storedImageUrl, storedLabels } from '@/lib/blog/content-utils'
import { normalizeBytes } from './sdk-helpers'
import { compressContent, decompressContent } from '@/lib/utils/compression'
import { DISCOVERY_SCAN_LIMIT, DISCOVERY_SCAN_TTL_MS, newestFirst } from './pagination-utils'

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

  /** The newest `limit` blogs on v7's `blog.timeline`, page by page. */
  private async timelineHead(limit: number): Promise<Blog[]> {
    const blogs: Blog[] = []
    let startAfter: string | undefined
    while (blogs.length < limit) {
      const page = await this.newestFirstPage(Math.min(BLOG_PAGE_SIZE, limit - blogs.length), startAfter)
      blogs.push(...page.documents)
      startAfter = page.nextCursor
      if (!startAfter) break
    }
    return blogs
  }

  /**
   * The newest blogs for discovery, `limit` at most. On v7 that is the head
   * of `blog.timeline`, read newest first, so it is always `complete`. Earlier
   * cuts only index `[$ownerId, $createdAt]`, so there is no newest-first
   * query: this reads every blog in owner order (up to
   * {@link DISCOVERY_SCAN_LIMIT}) and sorts by creation time. `complete` is
   * false when that cap cut the read short, so the newest order only covers
   * the blogs read; callers say so.
   */
  async getNewestBlogs(limit = 100): Promise<{ blogs: Blog[]; complete: boolean }> {
    if (!this.isConfigured()) return { blogs: [], complete: true }
    if (blogIsV7()) return { blogs: await this.timelineHead(limit), complete: true }
    const { blogs, complete } = await this.scanNewestBlogs()
    return { blogs: blogs.slice(0, limit), complete }
  }

  /** A full clear (a create runs one) drops the discovery scan too, so a new one is listed. */
  clearCache(documentId?: string): void {
    super.clearCache(documentId)
    if (!documentId) this.newestScan = null
  }

  /** The full discovery scan, newest first, held for two minutes (it is up to 10 queries). */
  private newestScan: { at: number; result: Promise<{ blogs: Blog[]; complete: boolean }> } | null = null

  private scanNewestBlogs(): Promise<{ blogs: Blog[]; complete: boolean }> {
    if (this.newestScan && Date.now() - this.newestScan.at < DISCOVERY_SCAN_TTL_MS) return this.newestScan.result
    const result = this.queryAll(
      { orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']] },
      DISCOVERY_SCAN_LIMIT
    ).then(({ documents, reachedLimit }) => ({ blogs: newestFirst(documents), complete: !reachedLimit }))
    const scan = { at: Date.now(), result }
    this.newestScan = scan
    // A failed scan is not held.
    result.catch(() => {
      if (this.newestScan === scan) this.newestScan = null
    })
    return result
  }
}

export const blogService = new BlogService()
