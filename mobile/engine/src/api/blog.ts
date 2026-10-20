import { BLOG_POST_SIZE_LIMIT, YAPPR_BLOG_CONTRACT_ID, blogIsV7, blogIsV9 } from '@/lib/constants'
import {
  BlogFieldError,
  blogPostDate,
  commentsAreEnabled,
  decodeSummary,
  encodeSummary,
  estimateReadingTime,
  getPostExcerpt,
  isBlogPostTombstone,
  isPublishedBlogPost,
  LABEL_LIMITS,
  storedImageUrl,
  storedLabels,
} from '@/lib/blog/content-utils'
import {
  BLOG_FONT_OPTIONS,
  BLOG_THEME_PRESETS,
  normalizeBlogThemeConfig,
  type BlogHeaderStyle,
  type BlogLayoutMode,
  type BlogThemeColors,
  type BlogThemeConfig,
} from '@/lib/blog/theme-types'
import { fieldLimits } from '@/lib/field-limits'
import { moderatedContract } from '@/lib/moderated-contracts'
import { isReportResolvedError, reportStatusLabel, withdrawFailureMessage } from '@/lib/reports'
import { ListLimitError } from '@/lib/typed-array-codecs'
import { compressContent } from '@/lib/utils/compression'
import { generateSlug, titleSlug } from '@/lib/utils/slug'
import { blogCommentService, COMMENTS_OFF_MESSAGE } from '@/lib/services/blog-comment-service'
import { blogFollowService } from '@/lib/services/blog-follow-service'
import { blogPostService, PrePublishRateLimitError, type UpdateBlogPostData } from '@/lib/services/blog-post-service'
import { blogService, type CreateBlogData, type UpdateBlogData } from '@/lib/services/blog-service'
import { contractReportProblem, contractReportService, type ContractReport, type ContractReportTarget } from '@/lib/services/contract-report-service'
import { moderationServiceFor } from '@/lib/services/moderation-service'
import { badRequest, loadUserSummaries, readFailure, requireViewer, viewerId } from '../dto/hydrate'
import { onePage, pageAfter } from '../dto/paging'
import { assertId, characters, relationProbe, signer } from '../writes/handler-kit'
import { fromDeleteBoolean, fromTransitionResult, wasConfirmed, createdDocument } from '../writes/lib-results'
import { NotSentError, type TicketStore, type WriteHandler, type WriteResult, type WriteRunContext } from '../writes/tickets'
import { RpcError } from '../protocol/envelope'
import type { BlogTargetRef, TicketDocument, WriteTicket } from '../writes/types'
import type { AuthorDTO, Page } from './dto'

/**
 * Blogs (`app/blog/page.tsx`, `components/blog/**`) on the configured blog
 * cut, through web's own services: reads answer DTOs, every write is a
 * ticket (ENGINE.md §7). Post content stays the web's BlockNote JSON, passed
 * through untouched so a post edited on either client round-trips.
 */

const BLOG_PAGE = 20
const POST_PAGE = 20
const COMMENT_LIMIT = 100

/** The parts of a blog's theme a native screen can show: no custom CSS, no gradient. */
export interface BlogThemeDTO {
  colors: BlogThemeColors
  /** Font ids (`BLOG_FONT_OPTIONS`); `fontKinds` says how each renders natively. */
  fonts: { body: string; heading: string }
  layout: BlogLayoutMode
  headerStyle: BlogHeaderStyle
}

export interface BlogThemePresetDTO {
  id: string
  name: string
  description: string
  theme: BlogThemeDTO
}

/** How a font id renders natively: the app has no web fonts, so each maps to a system family. */
export type BlogFontKind = 'sans' | 'serif' | 'mono'

export interface BlogInfoDTO {
  /** A blog contract is configured on this network. */
  available: boolean
  /** Authors can delete a whole blog (v9). */
  canDeleteBlog: boolean
  /** Authors can delete a post (v7: a tombstone). */
  canDeletePost: boolean
  /** "Your posts" lists an author's posts across blogs (v9). */
  ownerPosts: boolean
  /** Blogs, posts and comments take reports (v9). */
  reports: boolean
  limits: {
    name: number; description: number; title: number; summary: number; comment: number; image: number
    blogLabels: number; postLabels: number; labelLength: number; reportNote: number
  }
  presets: BlogThemePresetDTO[]
  fonts: { id: string; label: string; kind: BlogFontKind }[]
}

export interface BlogDTO {
  id: string
  ownerId: string
  owner: AuthorDTO | null
  createdAt: Date
  name: string
  description: string | null
  avatar: string | null
  headerImage: string | null
  theme: BlogThemeDTO
  /** The author kept the default look (no theme stored). */
  defaultTheme: boolean
  commentsEnabledDefault: boolean
  labels: string[]
}

export interface BlogPostSummaryDTO {
  id: string
  ownerId: string
  blogId: string
  /** Set on cross-blog lists (discovery, your posts). */
  blogName: string | null
  slug: string
  title: string
  /** The author's summary, `null` when none or hidden from the post view. */
  summary: string | null
  /** The summary, else the first paragraph: what a card shows. */
  excerpt: string
  coverImage: string | null
  labels: string[]
  /** When it was published, `null` for a draft. */
  publishedAt: Date | null
  /** The date a reader sees (`blogPostDate`). */
  date: Date
  createdAt: Date
  edited: boolean
  readingMinutes: number
  commentsEnabled: boolean
  /** The author deleted it (a tombstone). */
  deleted: boolean
}

export interface BlogPostDTO extends BlogPostSummaryDTO {
  /** BlockNote blocks, exactly as stored. */
  content: Record<string, unknown>[]
  /** The summary as the author wrote it, even when hidden from the post view. */
  summaryText: string
  summaryHidden: boolean
  revision: number
}

export interface BlogCommentDTO {
  id: string
  ownerId: string
  author: AuthorDTO | null
  postId: string
  createdAt: Date
  content: string
}

export interface BlogFollowDTO {
  /** `null` signed out. */
  following: boolean | null
  followers: number
}

export type BlogReportDocType = 'blog' | 'blogPost' | 'blogComment'

export interface BlogReportTargetDTO {
  docType: BlogReportDocType
  targetId: string
  ownerId: string
}

export interface BlogOwnReportDTO {
  id: string
  reason: number
  note: string | null
  /** `null` while the moderators have not resolved it. */
  status: string | null
  resolution: string | null
}

/** A theme as the host edits it; the engine keeps the stored custom CSS and gradient. */
export type BlogThemeInput = BlogThemeDTO

export interface BlogInput {
  name: string
  description?: string
  avatar?: string
  headerImage?: string
  labels?: string[]
  commentsEnabledDefault?: boolean
  theme?: BlogThemeInput
}

export interface BlogPostInput {
  title: string
  summary?: string
  summaryHidden?: boolean
  content: Record<string, unknown>[]
  coverImage?: string
  labels?: string[]
  commentsEnabled?: boolean
}


// ---- reads --------------------------------------------------------------

const SERIF = new Set(['lora', 'merriweather', 'playfair', 'source-serif-4'])
const fontKind = (id: string): BlogFontKind => (id === 'jetbrains-mono' ? 'mono' : SERIF.has(id) ? 'serif' : 'sans')

function themeDTO(config: BlogThemeConfig | undefined): BlogThemeDTO {
  const { colors, fonts, layout, headerStyle } = normalizeBlogThemeConfig(config)
  return { colors, fonts, layout, headerStyle }
}

type LibBlog = NonNullable<Awaited<ReturnType<typeof blogService.getBlog>>>
type LibPost = NonNullable<Awaited<ReturnType<typeof blogPostService.getPost>>>
type LibComment = Awaited<ReturnType<typeof blogCommentService.getCommentsByPost>>[number]

async function authorsOf(ids: string[]): Promise<Map<string, AuthorDTO>> {
  try {
    return await loadUserSummaries(ids, { viewerFollows: false })
  } catch {
    // A name that did not load is shown as the shortened id; the content is what was asked for.
    return new Map()
  }
}

async function toBlogDTOs(blogs: LibBlog[]): Promise<BlogDTO[]> {
  const owners = await authorsOf(blogs.map(blog => blog.ownerId))
  return blogs.map(blog => ({
    id: blog.id,
    ownerId: blog.ownerId,
    owner: owners.get(blog.ownerId) ?? null,
    createdAt: blog.createdAt,
    name: blog.name,
    description: blog.description || null,
    avatar: blog.avatar || null,
    headerImage: blog.headerImage || null,
    theme: themeDTO(blog.themeConfig),
    defaultTheme: !blog.themeConfig,
    commentsEnabledDefault: blog.commentsEnabledDefault ?? true,
    labels: blog.labels ?? [],
  }))
}

function toSummary(post: LibPost, blogName: string | null = null): BlogPostSummaryDTO {
  const { text, hidden } = decodeSummary(post.subtitle)
  return {
    id: post.id,
    ownerId: post.ownerId,
    blogId: post.blogId,
    blogName,
    slug: post.slug,
    title: post.title,
    summary: text && !hidden ? text : null,
    excerpt: getPostExcerpt(post),
    coverImage: post.coverImage || null,
    labels: post.labels ?? [],
    publishedAt: post.publishedAt !== undefined ? new Date(post.publishedAt) : null,
    date: blogPostDate(post),
    createdAt: post.createdAt,
    edited: (post.$revision ?? 1) > 1,
    readingMinutes: estimateReadingTime(post.content),
    commentsEnabled: commentsAreEnabled(post),
    deleted: isBlogPostTombstone(post),
  }
}

function toPostDTO(post: LibPost): BlogPostDTO {
  const { text, hidden } = decodeSummary(post.subtitle)
  return { ...toSummary(post), content: post.content, summaryText: text, summaryHidden: hidden, revision: post.$revision ?? 1 }
}

async function toCommentDTOs(comments: LibComment[]): Promise<BlogCommentDTO[]> {
  const authors = await authorsOf(comments.map(comment => comment.ownerId))
  return comments.map(comment => ({
    id: comment.id,
    ownerId: comment.ownerId,
    author: authors.get(comment.ownerId) ?? null,
    postId: comment.blogPostId,
    createdAt: comment.createdAt,
    content: comment.content,
  }))
}

/** A draft is readable by its owner only, as on web. */
const readable = (post: LibPost | null): post is LibPost =>
  post !== null && (isPublishedBlogPost(post) || isBlogPostTombstone(post) || post.ownerId === viewerId())

/** Each blog's name, for posts listed across blogs; a post whose blog is gone is dropped (web's `enrichBlogPostsWithBlogNames`). */
async function withBlogNames(posts: LibPost[], keepOrphans = false): Promise<BlogPostSummaryDTO[]> {
  if (posts.length === 0) return []
  const blogs = new Map((await blogService.getMany([...new Set(posts.map(post => post.blogId))], { throwOnError: true })).map(blog => [blog.id, blog.name]))
  return posts.flatMap(post => {
    const name = blogs.get(post.blogId)
    return name !== undefined || keepOrphans ? [toSummary(post, name ?? null)] : []
  })
}

async function read<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw readFailure(error)
  }
}

const reportsOn = () => blogIsV9() && moderatedContract('blog').reportTargets().length > 0

const blogLimit = (document: string, field: string, fallback: number) => fieldLimits('blog', document, field).maxLength ?? fallback

export const blogReads = {
  /** What this network's blog cut supports, its limits and the theme presets. */
  async info(): Promise<BlogInfoDTO> {
    return {
      available: blogService.isConfigured(),
      canDeleteBlog: blogIsV9(),
      canDeletePost: blogIsV7(),
      ownerPosts: blogIsV9(),
      reports: reportsOn(),
      limits: {
        name: blogLimit('blog', 'name', 64),
        description: blogLimit('blog', 'description', 256),
        title: blogLimit('blogPost', 'title', 128),
        summary: blogLimit('blogPost', 'subtitle', 256) - 1,
        comment: blogLimit('blogComment', 'content', 500),
        image: blogLimit('blogPost', 'coverImage', 256),
        blogLabels: LABEL_LIMITS.blog,
        postLabels: LABEL_LIMITS.post,
        labelLength: LABEL_LIMITS.length,
        reportNote: blogLimit('report', 'note', 500),
      },
      presets: BLOG_THEME_PRESETS.map(preset => ({ id: preset.id, name: preset.name, description: preset.description, theme: themeDTO(preset.config) })),
      fonts: BLOG_FONT_OPTIONS.map(font => ({ id: font.id, label: font.label, kind: fontKind(font.id) })),
    }
  },

  /** Every blog, newest first (`blog.timeline` on v7+; a bounded scan before). */
  async discover(cursor?: string | null): Promise<Page<BlogDTO>> {
    if (!blogService.isConfigured()) return onePage([])
    if (!blogIsV7()) {
      if (cursor) return onePage([])
      return onePage(await toBlogDTOs((await read(() => blogService.getNewestBlogs(100))).blogs))
    }
    return pageAfter('blogs', cursor, after => read(() => blogService.getBlogTimelinePage({ limit: BLOG_PAGE, startAfter: after })), async page => ({
      items: await toBlogDTOs(page.blogs),
      next: page.nextCursor,
    }))
  },

  /** The newest published posts across every blog (v7 `timeline`), with their blog's name. */
  async latestPosts(cursor?: string | null): Promise<Page<BlogPostSummaryDTO>> {
    if (!blogService.isConfigured() || !blogIsV7()) return onePage([])
    return pageAfter('blogPosts', cursor, after => read(() => blogPostService.getLatestPublishedPosts({ want: POST_PAGE, startAfter: after })), async page => ({
      items: await read(() => withBlogNames(page.posts)),
      next: page.nextCursor,
    }))
  },

  /** The blogs the viewer follows. */
  async followed(): Promise<BlogDTO[]> {
    const viewer = requireViewer('Blogs you follow')
    const ids = await read(() => blogFollowService.getFollowedBlogIds(viewer))
    if (ids.length === 0) return []
    return toBlogDTOs(await read(() => blogService.getMany(ids, { throwOnError: true })))
  },

  /** The viewer's own blogs. */
  async mine(): Promise<BlogDTO[]> {
    const viewer = requireViewer('Your blogs')
    return toBlogDTOs(await read(() => blogService.getBlogsByOwner(viewer)))
  },

  /** One blog, or `null` when it does not exist or was deleted. */
  async get(id: string): Promise<BlogDTO | null> {
    assertId(id, 'id')
    const blog = await read(() => blogService.getBlog(id, { throwOnError: true }))
    return blog ? (await toBlogDTOs([blog]))[0] : null
  },

  /**
   * A blog's posts, newest first. Readers see published posts; the owner
   * also sees drafts (as web's dashboard does). Pages continue after the
   * last post read, shown or not.
   */
  async posts(blogId: string, cursor?: string | null): Promise<Page<BlogPostSummaryDTO>> {
    assertId(blogId, 'blogId')
    const viewer = viewerId()
    return pageAfter('blogPosts', cursor, after => read(() => blogPostService.getPostsByBlog(blogId, { limit: POST_PAGE, startAfter: after })), async posts => ({
      items: posts.filter(post => !isBlogPostTombstone(post) && (isPublishedBlogPost(post) || post.ownerId === viewer)).map(post => toSummary(post)),
      next: posts.length >= POST_PAGE ? posts[posts.length - 1].id : null,
    }))
  },

  /** One post with its content; `null` when it does not exist, or is someone else's draft. */
  async post(id: string): Promise<BlogPostDTO | null> {
    assertId(id, 'id')
    const post = await read(() => blogPostService.getOrThrow(id))
    return readable(post) ? toPostDTO(post) : null
  },

  /** A post by its web address (`/blog?blog=<id>&post=<slug>`). */
  /**
   * Whether the viewer's publish of `title` to `blogId`, sent at `since`
   * (epoch ms), landed, by the address it takes (`titleSlug`; the slug is
   * unique per blog, tombstones keep it). `absent`: nothing has that address,
   * so it never landed. `unknown`: someone else's or an older post holds it
   * (this one would then carry a suffix), or the title gives no address of its
   * own (lib then stamps one with the send time, which can't be recomputed),
   * so the address proves nothing. A failed read rejects.
   */
  async publishOutcome(blogId: string, title: string, since: number): Promise<'published' | 'absent' | 'unknown'> {
    assertId(blogId, 'blogId')
    const viewer = requireViewer('Your post')
    const slug = titleSlug(String(title).trim())
    if (!slug) return 'unknown'
    blogPostService.clearCache()
    const post = await read(() => blogPostService.getPostBySlug(blogId, slug))
    if (!post) return 'absent'
    return post.ownerId === viewer && post.createdAt.getTime() >= since - 5 * 60_000 ? 'published' : 'unknown'
  },

  async postBySlug(blogId: string, slug: string): Promise<BlogPostDTO | null> {
    assertId(blogId, 'blogId')
    if (typeof slug !== 'string' || !slug || slug.length > 63) throw badRequest('slug must be a post address')
    const post = await read(() => blogPostService.getPostBySlug(blogId, slug))
    return readable(post) ? toPostDTO(post) : null
  },

  /** A post's comments, oldest first (up to 100, as web reads them). */
  async comments(postId: string): Promise<BlogCommentDTO[]> {
    assertId(postId, 'postId')
    return toCommentDTOs(await read(() => blogCommentService.getCommentsByPost(postId, { limit: COMMENT_LIMIT })))
  },

  /** Whether the viewer follows a blog, and its follower count. */
  async followState(blogId: string): Promise<BlogFollowDTO> {
    assertId(blogId, 'blogId')
    const viewer = viewerId()
    const [following, followers] = await Promise.all([
      viewer ? read(() => blogFollowService.isFollowingBlog(viewer, blogId)) : Promise.resolve(null),
      blogFollowService.countBlogFollowers(blogId).catch(() => 0),
    ])
    return { following, followers }
  },

  /** The viewer's posts across their blogs, drafts included (v9's owner index; reachable after a blog is deleted). */
  async myPosts(cursor?: string | null): Promise<Page<BlogPostSummaryDTO>> {
    const viewer = requireViewer('Your posts')
    if (!blogIsV9()) return onePage([])
    return pageAfter('myBlogPosts', cursor, after => read(() => blogPostService.getOwnerPostsPage(viewer, { limit: POST_PAGE, startAfter: after })), async page => ({
      items: await read(() => withBlogNames(page.posts, true)),
      next: page.nextCursor,
    }))
  },

  /** Whether reports can be filed now (a `notYetUsable` interim waits for its first team). */
  async reportsOpen(): Promise<boolean> {
    if (!reportsOn()) return false
    return read(() => moderationServiceFor('blog').moderatedTypeOpen('report'))
  },

  /** The viewer's own report on a blog, post or comment, or `null`. */
  async ownReport(target: BlogReportTargetDTO): Promise<BlogOwnReportDTO | null> {
    const viewer = requireViewer('Your report')
    if (!reportsOn()) return null
    const report = await read(() => contractReportService.own(viewer, reportTarget(target)))
    return report ? ownReportDTO(report) : null
  },
}

function ownReportDTO(report: ContractReport): BlogOwnReportDTO {
  return {
    id: report.id,
    reason: report.reason,
    note: report.note ?? null,
    status: report.status === null || report.status === undefined ? null : reportStatusLabel(report.status),
    resolution: report.resolution ?? null,
  }
}

const REPORT_DOC_TYPES: readonly BlogReportDocType[] = ['blog', 'blogPost', 'blogComment']

function reportTarget(target: BlogReportTargetDTO): ContractReportTarget {
  if (!target || !REPORT_DOC_TYPES.includes(target.docType)) throw badRequest('docType must be blog, blogPost or blogComment')
  assertId(target.targetId, 'targetId')
  assertId(target.ownerId, 'ownerId')
  return { contract: 'blog', docType: target.docType, targetId: target.targetId, ownerId: target.ownerId }
}

// ---- writes -------------------------------------------------------------

const blogDoc = (type: string, id: string, action: TicketDocument['action'], confirmed = false): TicketDocument =>
  ({ contractId: YAPPR_BLOG_CONTRACT_ID, type, id, action, confirmed })

const targetOf = (type: BlogTargetRef['blog']['type'], id: string): BlogTargetRef => ({ blog: { type, id } })

function blogTarget(ticket: WriteTicket): BlogTargetRef['blog'] {
  const target = ticket.target as Partial<BlogTargetRef> | null
  if (!target?.blog) throw new Error('This write names no blog')
  return target.blog
}

/** A refusal lib raises before it signs anything: the write was not sent. */
const isPreSendError = (error: unknown) =>
  error instanceof BlogFieldError || error instanceof ListLimitError || error instanceof PrePublishRateLimitError

async function notSentOnPreSend<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isPreSendError(error)) throw new NotSentError(error instanceof PrePublishRateLimitError ? error : badRequest((error as Error).message))
    throw error
  }
}

/** Checks the host's input before a ticket is issued, with the message a person can act on. */
function validated<T>(check: () => T): T {
  try {
    return check()
  } catch (error) {
    if (error instanceof BlogFieldError || error instanceof ListLimitError) throw badRequest(error.message)
    throw error
  }
}

function checkText(value: string | undefined, max: number, what: string, required = false): void {
  if (required && !value?.trim()) throw badRequest(`${what} is required`)
  if (value !== undefined && characters(value) > max) throw badRequest(`${what} is too long`)
}

function checkContent(content: unknown): void {
  if (!Array.isArray(content)) throw badRequest('content must be a list of blocks')
  if (compressContent(content).byteLength > BLOG_POST_SIZE_LIMIT) throw badRequest('This post is too long. Shorten it and try again.')
}

/**
 * The stored theme with the host's edit applied: the author's custom CSS and
 * gradient are kept. Read strictly, before anything is signed: a failed read
 * (or a blog gone) stops the save, rather than overwrite the CSS with defaults.
 */
async function mergedTheme(blogId: string | null, input: BlogThemeInput): Promise<BlogThemeConfig> {
  let stored: BlogThemeConfig | undefined
  if (blogId) {
    blogService.clearCache(blogId)
    const blog = await blogService.getOrThrow(blogId).catch(error => { throw new NotSentError(readFailure(error)) })
    if (!blog) throw new NotSentError(badRequest('This blog is no longer available'))
    stored = blog.themeConfig
  }
  const base = normalizeBlogThemeConfig(stored)
  return normalizeBlogThemeConfig({ ...base, colors: input.colors, fonts: input.fonts, layout: input.layout, headerStyle: input.headerStyle })
}

function blogData(input: Partial<BlogInput>): UpdateBlogData {
  const data: UpdateBlogData = {}
  if (input.name !== undefined) data.name = input.name.trim()
  if (input.description !== undefined) data.description = input.description.trim() || undefined
  if (input.avatar !== undefined) data.avatar = input.avatar.trim()
  if (input.headerImage !== undefined) data.headerImage = input.headerImage.trim()
  if (input.labels !== undefined) data.labels = input.labels
  if (input.commentsEnabledDefault !== undefined) data.commentsEnabledDefault = input.commentsEnabledDefault
  return data
}

function checkBlogInput(input: Partial<BlogInput>, creating: boolean): void {
  checkText(input.name, blogLimit('blog', 'name', 64), 'A name', creating)
  if (!creating && input.name !== undefined && !input.name.trim()) throw badRequest('A name is required')
  checkText(input.description, blogLimit('blog', 'description', 256), 'The description')
  validated(() => {
    if (input.avatar !== undefined) storedImageUrl(input.avatar, 'avatar')
    if (input.headerImage !== undefined) storedImageUrl(input.headerImage, 'header image')
    if (input.labels !== undefined) storedLabels(input.labels, 'blog')
  })
}

function postData(input: Partial<BlogPostInput>): UpdateBlogPostData {
  const data: UpdateBlogPostData = {}
  if (input.title !== undefined) data.title = input.title.trim()
  if (input.summary !== undefined || input.summaryHidden !== undefined) {
    const text = (input.summary ?? '').trim()
    // An empty string clears a stored summary (lib leaves an undefined field as it was), as web's composer sends it.
    data.subtitle = text ? encodeSummary(text, input.summaryHidden === true) : ''
  }
  if (input.content !== undefined) data.content = input.content
  if (input.coverImage !== undefined) data.coverImage = input.coverImage.trim()
  if (input.labels !== undefined) data.labels = input.labels
  if (input.commentsEnabled !== undefined) data.commentsEnabled = input.commentsEnabled
  return data
}

function checkPostInput(input: Partial<BlogPostInput>, creating: boolean): void {
  checkText(input.title, blogLimit('blogPost', 'title', 128), 'A title', creating)
  if (!creating && input.title !== undefined && !input.title.trim()) throw badRequest('A title is required')
  checkText(input.summary, blogLimit('blogPost', 'subtitle', 256) - 1, 'The summary')
  if (creating || input.content !== undefined) checkContent(input.content)
  validated(() => {
    if (input.coverImage !== undefined) storedImageUrl(input.coverImage, 'cover image')
    if (input.labels !== undefined) storedLabels(input.labels, 'post')
  })
}

interface BlogCreateArgs { input: BlogInput }
interface BlogUpdateArgs { blogId: string; input: Partial<BlogInput> }
interface BlogIdArgs { blogId: string }
interface PostPublishArgs { blogId: string; input: BlogPostInput }
interface PostUpdateArgs { postId: string; input: Partial<BlogPostInput> }
interface PostIdArgs { postId: string }
interface CommentArgs { postId: string; postOwnerId: string; content: string }
interface CommentIdArgs { commentId: string }
interface ReportArgs { target: BlogReportTargetDTO; reason: number; note: string }
interface WithdrawArgs { reportId: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const sameText = (stored: string | undefined, sent: string | undefined) => (stored ?? '') === (sent ?? '')

/**
 * Whether the stored blog shows every field an edit sent (`profileShows`'s
 * pattern), read past the cache. A failed read throws: it proves nothing.
 */
async function blogShows(blogId: string, input: Partial<BlogInput>): Promise<boolean> {
  blogService.clearCache(blogId)
  const blog = await blogService.getOrThrow(blogId)
  if (!blog) return false
  const data = blogData(input)
  return (data.name === undefined || blog.name === data.name) &&
    (!('description' in data) || sameText(blog.description, data.description)) &&
    (data.avatar === undefined || sameText(blog.avatar, data.avatar)) &&
    (data.headerImage === undefined || sameText(blog.headerImage, data.headerImage)) &&
    (data.labels === undefined || same(blog.labels ?? [], data.labels)) &&
    (data.commentsEnabledDefault === undefined || (blog.commentsEnabledDefault ?? true) === data.commentsEnabledDefault) &&
    (!input.theme || same(themeDTO(blog.themeConfig), themeDTO(normalizeBlogThemeConfig({ ...normalizeBlogThemeConfig(blog.themeConfig), ...input.theme }))))
}

/** Whether the stored post shows every field an edit sent. A failed read throws. */
async function postShows(postId: string, input: Partial<BlogPostInput>): Promise<boolean> {
  blogPostService.clearCache(postId)
  const post = await blogPostService.getOrThrow(postId)
  if (!post) return false
  const data = postData(input)
  return (data.title === undefined || post.title === data.title) &&
    (!('subtitle' in data) || sameText(post.subtitle, data.subtitle)) &&
    (data.content === undefined || same(post.content, data.content)) &&
    (data.coverImage === undefined || sameText(post.coverImage, data.coverImage)) &&
    (data.labels === undefined || same(post.labels ?? [], data.labels)) &&
    (data.commentsEnabled === undefined || commentsAreEnabled(post) === data.commentsEnabled)
}

/** A tombstoned post, or one gone (a moderator's removal). A failed read throws. */
async function postTombstoned(postId: string): Promise<boolean> {
  blogPostService.clearCache(postId)
  const post = await blogPostService.getOrThrow(postId)
  return post === null || isBlogPostTombstone(post)
}

/** The viewer follows the blog, read strictly (lib's `isFollowingBlog` answers a failed read "no"). */
async function followsBlog(viewer: string, blogId: string): Promise<boolean> {
  return (await blogFollowService.getFollowedBlogIds(viewer)).includes(blogId)
}

/**
 * A create proved by the document id its ticket recorded. With no id (the
 * call was cut short before lib answered) nothing identifies this write's
 * document among the author's others, so it stays unresolved: never guessed.
 */
const proveCreated: NonNullable<WriteHandler<unknown>['probe']> = async (ticket, _args, kit) =>
  ticket.documents.some(doc => doc.action === 'create')
    ? kit.proveDocuments(ticket.documents)
    : { state: 'unknown', error: new Error('This write did not record what it created') }

/** Messages lib's comment create raises before it signs anything (`blog-comment-service.ts`). */
const COMMENT_PRE_SEND = [/content is required/i, /exceeds 500/i, /Could not load this post/i, /was deleted/i, /Cannot resolve the post owner/i]

/** A follow or unfollow lib answered "done" without sending (it found nothing to change): proved by a strict read. */
async function settledWithoutSend(ctx: WriteRunContext): Promise<WriteResult> {
  const proof = await ctx.probe()
  if (proof.state === 'applied') return { state: 'confirmed' }
  if (proof.state === 'not-applied') throw new NotSentError(readFailure(new Error('Your follows could not be read')))
  return { state: 'unconfirmed' }
}

/** A created document lib answered with, for the ticket (its id proves it later). */
function created(document: { id: string }, type: string): WriteResult {
  const confirmed = wasConfirmed(document)
  return { state: confirmed ? 'confirmed' : 'unconfirmed', documents: [blogDoc(type, document.id, 'create', confirmed)] }
}

export function createBlogWrites(tickets: TicketStore) {
  tickets.register<BlogCreateArgs>('blog.create', {
    persistArgs: true,
    async run({ input }, ctx) {
      const owner = signer(ctx)
      const data: CreateBlogData = { ...blogData(input), name: input.name.trim() }
      if (input.theme) data.themeConfig = await mergedTheme(null, input.theme)
      return created(await notSentOnPreSend(() => blogService.createBlog(owner, data)), 'blog')
    },
    probe: proveCreated,
  })

  tickets.register<BlogUpdateArgs>('blog.update', {
    persistArgs: true,
    async run({ blogId, input }, ctx) {
      const owner = signer(ctx)
      const data = blogData(input)
      // A theme read that fails stops the save before anything is signed.
      if (input.theme) data.themeConfig = await mergedTheme(blogId, input.theme)
      await notSentOnPreSend(() => blogService.updateBlog(blogId, owner, data))
      blogService.clearCache()
      return { state: 'confirmed' }
    },
    probe: relationProbe<BlogUpdateArgs>(async ({ args }) => {
      if (!args) throw new Error('This edit can no longer be checked')
      return blogShows(args.blogId, args.input)
    }, true),
  })

  tickets.register<BlogIdArgs>('blog.delete', {
    persistArgs: true,
    async run({ blogId }, ctx) {
      const owner = signer(ctx)
      ctx.documents([blogDoc('blog', blogId, 'delete')])
      await blogService.deleteBlog(blogId, owner)
      return { state: 'confirmed', documents: [blogDoc('blog', blogId, 'delete', true)] }
    },
  })

  tickets.register<PostPublishArgs>('blogPost.publish', {
    persistArgs: true,
    async run({ blogId, input }, ctx) {
      const owner = signer(ctx)
      const data = postData(input)
      // lib reads the slug before it signs; read it here first, so a failed read is "not sent", never "may have landed".
      await blogPostService.getPostBySlug(blogId, generateSlug(input.title.trim())).catch(error => { throw new NotSentError(readFailure(error)) })
      const post = await notSentOnPreSend(() => blogPostService.createPost(owner, {
        ...data,
        subtitle: data.subtitle || undefined,
        blogId,
        title: input.title.trim(),
        content: input.content,
      }))
      return created(post, 'blogPost')
    },
    probe: proveCreated,
  })

  tickets.register<PostUpdateArgs>('blogPost.update', {
    persistArgs: true,
    async run({ postId, input }, ctx) {
      const owner = signer(ctx)
      await notSentOnPreSend(() => blogPostService.updatePost(postId, owner, postData(input)))
      blogPostService.clearCache(postId)
      return { state: 'confirmed' }
    },
    probe: relationProbe<PostUpdateArgs>(async ({ args }) => {
      if (!args) throw new Error('This edit can no longer be checked')
      return postShows(args.postId, args.input)
    }, true),
  })

  const tombstoned = relationProbe<PostIdArgs>(async ({ ticket }) => postTombstoned(blogTarget(ticket).id), true)
  tickets.register<PostIdArgs>('blogPost.delete', {
    persistArgs: true,
    async run({ postId }, ctx) {
      const owner = signer(ctx)
      return fromDeleteBoolean(await blogPostService.deletePost(postId, owner), ctx.probe)
    },
    probe: tombstoned,
  })

  tickets.register<CommentArgs>('blogComment.create', {
    persistArgs: true,
    async run({ postId, postOwnerId, content }, ctx) {
      const owner = signer(ctx)
      try {
        return created(await blogCommentService.createComment(owner, postId, postOwnerId, content), 'blogComment')
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message === COMMENTS_OFF_MESSAGE) throw new RpcError('Comments are turned off for this post.', 'BAD_REQUEST')
        if (COMMENT_PRE_SEND.some(pattern => pattern.test(message))) throw new NotSentError(badRequest(message))
        throw error
      }
    },
    probe: proveCreated,
  })

  tickets.register<CommentIdArgs>('blogComment.delete', {
    persistArgs: true,
    async run({ commentId }, ctx) {
      const owner = signer(ctx)
      ctx.documents([blogDoc('blogComment', commentId, 'delete')])
      const ok = await blogCommentService.deleteComment(commentId, owner)
      return fromDeleteBoolean(ok, ctx.probe)
    },
  })

  const follows = (expected: boolean) => relationProbe<BlogIdArgs>(async ({ viewer, ticket }) =>
    followsBlog(viewer, blogTarget(ticket).id), expected)
  for (const [op, follow] of [['blog.follow', true], ['blog.unfollow', false]] as const) {
    tickets.register<BlogIdArgs>(op, {
      persistArgs: true,
      async run({ blogId }, ctx) {
        const viewer = signer(ctx)
        const result = follow ? await blogFollowService.followBlog(viewer, blogId) : await blogFollowService.unfollowBlog(viewer, blogId)
        // lib answers "done" with nothing sent when its own read found nothing to change, a failed read included.
        if (result.success && !(result as { transactionHash?: string }).transactionHash) return settledWithoutSend(ctx)
        return fromTransitionResult(result)
      },
      probe: follows(follow),
    })
  }

  tickets.register<ReportArgs>('blog.report', {
    persistArgs: true,
    async run({ target, reason, note }, ctx) {
      const reporter = signer(ctx)
      const result = await contractReportService.file(reporter, reportTarget(target), reason, note)
      const reportsContract = moderatedContract('blog').contractId
      return fromTransitionResult(result, createdDocument(result, reportsContract, 'report'))
    },
    // The viewer's report on the target (one per reporter and target).
    probe: relationProbe<ReportArgs>(async ({ viewer, args }) => {
      if (!args) throw new Error('This report can no longer be checked')
      return (await contractReportService.own(viewer, reportTarget(args.target))) !== null
    }, true),
  })

  tickets.register<WithdrawArgs>('blog.report.withdraw', {
    persistArgs: true,
    async run({ reportId }, ctx) {
      const reporter = signer(ctx)
      ctx.documents([blogDoc('report', reportId, 'delete')])
      const result = await contractReportService.withdraw(reporter, 'blog', reportId)
      // The moderators resolved it, so the network keeps it (`safety.ts`): nothing was sent.
      if (!result.success && isReportResolvedError(result.error)) {
        return { state: 'failed', error: new RpcError(withdrawFailureMessage(result.error), 'REPORT_RESOLVED') }
      }
      return fromTransitionResult(result)
    },
  })

  return {
    /** Create a blog. */
    async create(input: BlogInput): Promise<WriteTicket> {
      requireViewer('Creating a blog')
      checkBlogInput(input, true)
      return tickets.submit<BlogCreateArgs>({ op: 'blog.create', args: { input }, target: null })
    },

    /** Edit a blog's details or look: only the fields given change. */
    async update(blogId: string, input: Partial<BlogInput>): Promise<WriteTicket> {
      assertId(blogId, 'blogId')
      requireViewer('Editing a blog')
      checkBlogInput(input, false)
      return tickets.submit<BlogUpdateArgs>({ op: 'blog.update', args: { blogId, input }, target: targetOf('blog', blogId) })
    },

    /** Delete a blog (v9). Its posts stay stored but leave the blog page and discovery. */
    async remove(blogId: string): Promise<WriteTicket> {
      assertId(blogId, 'blogId')
      requireViewer('Deleting a blog')
      if (!blogIsV9()) throw badRequest('Blogs cannot be deleted on this network')
      return tickets.submit<BlogIdArgs>({ op: 'blog.delete', args: { blogId }, target: targetOf('blog', blogId) })
    },

    /** Publish a post on one of the viewer's blogs. */
    async publish(blogId: string, input: BlogPostInput): Promise<WriteTicket> {
      assertId(blogId, 'blogId')
      requireViewer('Publishing a post')
      checkPostInput(input, true)
      return tickets.submit<PostPublishArgs>({ op: 'blogPost.publish', args: { blogId, input }, target: targetOf('blog', blogId) })
    },

    /** Edit a post: only the fields given change. */
    async edit(postId: string, input: Partial<BlogPostInput>): Promise<WriteTicket> {
      assertId(postId, 'postId')
      requireViewer('Editing a post')
      checkPostInput(input, false)
      return tickets.submit<PostUpdateArgs>({ op: 'blogPost.update', args: { postId, input }, target: targetOf('blogPost', postId) })
    },

    /** Delete a post (v7: it becomes a blank tombstone; it cannot be undone). */
    async deletePost(postId: string): Promise<WriteTicket> {
      assertId(postId, 'postId')
      requireViewer('Deleting a post')
      if (!blogIsV7()) throw badRequest('Posts cannot be deleted on this network')
      return tickets.submit<PostIdArgs>({ op: 'blogPost.delete', args: { postId }, target: targetOf('blogPost', postId) })
    },

    async comment(postId: string, postOwnerId: string, content: string): Promise<WriteTicket> {
      assertId(postId, 'postId')
      assertId(postOwnerId, 'postOwnerId')
      requireViewer('Commenting')
      checkText(content, blogLimit('blogComment', 'content', 500), 'A comment', true)
      // lib counts UTF-16 units (`content.length`), which an emoji counts twice.
      if (content.trim().length > blogLimit('blogComment', 'content', 500)) throw badRequest('A comment is too long')
      return tickets.submit<CommentArgs>({ op: 'blogComment.create', args: { postId, postOwnerId, content: content.trim() }, target: targetOf('blogPost', postId) })
    },

    async deleteComment(commentId: string): Promise<WriteTicket> {
      assertId(commentId, 'commentId')
      requireViewer('Deleting a comment')
      return tickets.submit<CommentIdArgs>({ op: 'blogComment.delete', args: { commentId }, target: targetOf('blogComment', commentId) })
    },

    async follow(blogId: string): Promise<WriteTicket> {
      assertId(blogId, 'blogId')
      requireViewer('Following a blog')
      return tickets.submit<BlogIdArgs>({ op: 'blog.follow', args: { blogId }, target: targetOf('blog', blogId) })
    },

    async unfollow(blogId: string): Promise<WriteTicket> {
      assertId(blogId, 'blogId')
      requireViewer('Unfollowing a blog')
      return tickets.submit<BlogIdArgs>({ op: 'blog.unfollow', args: { blogId }, target: targetOf('blog', blogId) })
    },

    /** Report a blog, a post or a comment to the blog contract's moderators (v9). */
    async report(target: BlogReportTargetDTO, reason: number, note = ''): Promise<WriteTicket> {
      const viewer = requireViewer('Reporting')
      const libTarget = reportTarget(target)
      if (!reportsOn()) throw badRequest('Reports are not available on this network')
      if (viewer === libTarget.ownerId) throw badRequest('You cannot report your own content')
      const problem = contractReportProblem('blog', Number.isInteger(reason) ? reason : null, note)
      if (problem) throw badRequest(problem)
      return tickets.submit<ReportArgs>({ op: 'blog.report', args: { target, reason, note }, target: targetOf(target.docType, target.targetId) })
    },

    async withdrawReport(reportId: string): Promise<WriteTicket> {
      assertId(reportId, 'reportId')
      requireViewer('Withdrawing a report')
      return tickets.submit<WithdrawArgs>({ op: 'blog.report.withdraw', args: { reportId }, target: targetOf('report', reportId) })
    },
  }
}
