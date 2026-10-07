import { blogIsV7, blogLabelsAreTyped } from '@/lib/constants'
import { LIST_LIMITS, ListLimitError, assertListLimits, decodeLabelList, encodeLabelList, uniqueStrings } from '@/lib/typed-array-codecs'
import { truncateId } from '@/lib/utils/common'
import { extractErrorMessage } from '@/lib/error-utils'

/** Zero-width space used to flag a summary as hidden from the post view. */
export const SUMMARY_HIDDEN_PREFIX = '\u200B'

/** Encode a summary string, prepending the hidden sentinel when `hidden` is true. */
export function encodeSummary(text: string, hidden: boolean): string {
  return hidden ? `${SUMMARY_HIDDEN_PREFIX}${text}` : text
}

/** Decode a raw subtitle/summary, stripping any hidden prefix. */
export function decodeSummary(raw?: string): { text: string; hidden: boolean } {
  if (!raw) return { text: '', hidden: false }
  if (raw.startsWith(SUMMARY_HIDDEN_PREFIX)) {
    return { text: raw.slice(SUMMARY_HIDDEN_PREFIX.length), hidden: true }
  }
  return { text: raw, hidden: false }
}

/**
 * Extract text from only the first text-bearing block (paragraph or heading).
 * Skips image, video, audio, file, and other non-text blocks.
 */
export function extractFirstTextBlock(content: unknown): string {
  if (!Array.isArray(content)) return ''

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const node = block as Record<string, unknown>
    const type = node.type as string | undefined
    if (type === 'paragraph' || type === 'heading') {
      const text = extractInlineText(node.content).trim()
      if (text) return text
    }
  }
  return ''
}

/**
 * Unified excerpt for listing cards: uses decoded summary if present,
 * otherwise falls back to extractFirstTextBlock. Truncates at maxLength.
 */
export function getPostExcerpt(
  post: { subtitle?: string; content?: unknown; blogContent?: unknown },
  maxLength = 200,
): string {
  const { text: summary } = decodeSummary(post.subtitle)
  const source = summary || extractFirstTextBlock(post.blogContent ?? post.content)
  if (!source) return ''
  const clean = source.replace(/\s+/g, ' ').trim()
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => extractText(item)).filter(Boolean).join(' ')
  }
  if (content && typeof content === 'object') {
    const node = content as Record<string, unknown>
    const textParts: string[] = []
    if (typeof node.text === 'string') textParts.push(node.text)
    if (Array.isArray(node.content)) textParts.push(extractText(node.content))
    const props = node.props as Record<string, unknown> | undefined
    if (typeof props?.code === 'string' && props.code) textParts.push(props.code)
    if (Array.isArray(node.children)) textParts.push(extractText(node.children))
    return textParts.filter(Boolean).join(' ')
  }
  return ''
}

/** Extract text from a BlockNote inline content array (flat, no recursion into children). */
export function extractInlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const maybeText = (item as { text?: unknown }).text
        return typeof maybeText === 'string' ? maybeText : ''
      }
      return ''
    })
    .join('')
}

/** A blog's home page path. */
export function getBlogUrl(blogId: string): string {
  return `/blog?blog=${encodeURIComponent(blogId)}`
}

/** Build a blog post URL path from blogId and slug. */
export function getBlogPostUrl(blogId: string, slug: string): string {
  return `${getBlogUrl(blogId)}&post=${encodeURIComponent(slug)}`
}

/**
 * Labels as the configured blog cut stores them; undefined when there are
 * none (the field is then omitted). The app models labels as a list; blog v4
 * stores that list (docs/SOCIAL_V9.md), v1–v3 a comma-separated string. On v4
 * the contract caps the list (64 on a blog, 16 on a post, 40 characters each)
 * and a longer one is refused after signing, so it throws a
 * {@link ListLimitError} with a user-facing message first. v1–v3 keep their
 * own byte cap, but a label holding a comma cannot survive their encoding (it
 * would read back as two), so it is refused the same way.
 */
export function storedLabels(labels: readonly string[] | undefined, of: 'blog' | 'post'): string | string[] | undefined {
  const list = uniqueStrings(labels ?? [])
  const typed = blogLabelsAreTyped()
  if (typed) assertListLimits(list, of === 'blog' ? LIST_LIMITS.blogLabels : LIST_LIMITS.postLabels)
  const problem = list.map(labelProblem).find((message) => message !== null)
  if (problem) throw new ListLimitError(problem)
  return encodeLabelList(list, typed)
}

/** Why one label cannot be stored on the configured cut, or null. v1–v3 separate labels with commas. */
export function labelProblem(label: string): string | null {
  return !blogLabelsAreTyped() && label.includes(',') ? 'Labels can\'t contain a comma on this network.' : null
}

/** Stored labels (a v4 list or a v1–v3 comma-separated string) as the app's list; undefined when there are none. */
export function labelsFromStored(stored: unknown): string[] | undefined {
  const labels = decodeLabelList(stored)
  return labels.length > 0 ? labels : undefined
}

/** The v4 caps a UI should hold labels to (it also holds them on older cuts, which is harmless). */
export const LABEL_LIMITS = { blog: LIST_LIMITS.blogLabels.maxItems, post: LIST_LIMITS.postLabels.maxItems, length: LIST_LIMITS.postLabels.maxLength } as const

/** Labels for display as one line of text. */
export function formatLabels(labels?: readonly string[]): string {
  return (labels ?? []).join(', ')
}

/**
 * A post an author deleted (blog v7): `deleted` is set, comments are off and
 * every content field is gone; only `blogId`, `slug` and `publishedAt`
 * survive. Its URL still resolves (the slug stays taken), so a reader is told
 * it was deleted rather than that it never existed.
 */
export function isBlogPostTombstone(post: { deleted?: boolean }): boolean {
  return post.deleted === true
}

/**
 * True for a post the public may read: published (`publishedAt` set) and not
 * deleted. A post with no `publishedAt` is a draft. The app always sets it on
 * create, but other clients (and the seeder) can write drafts, and nothing on
 * chain hides them: every public surface has to filter them out itself, and
 * tombstones with them (a tombstone keeps its `publishedAt`).
 */
export function isPublishedBlogPost(post: { publishedAt?: number; deleted?: boolean }): boolean {
  return post.publishedAt !== undefined && !isBlogPostTombstone(post)
}

/**
 * How far past the document's own time `publishedAt` may run: blog v7 refuses
 * more than this past `$updatedAt` (`publishedNotAhead`), and the reader
 * allows the same on a post that stores `$updatedAt`.
 */
export const PUBLISHED_AT_MAX_AHEAD_MS = 10 * 60 * 1000

type DatedBlogPost = { publishedAt?: number; createdAt: Date; updatedAt?: Date; $revision?: number; deleted?: boolean }

/**
 * The date a reader should see: when the post was published, else when it was
 * created. `publishedAt` is author-supplied, so it may backdate a post (an
 * import) but not date it after the network recorded it; a future value would
 * otherwise pin the post to the top of every listing, so it falls back to the
 * creation time. On blog v7 the latest acceptable value is the post's
 * `$updatedAt` plus {@link PUBLISHED_AT_MAX_AHEAD_MS}, which is what the
 * contract enforces. Older cuts store no `$updatedAt`, and a draft can be
 * published by a later revision (the contract allows setting `publishedAt`
 * once), so a revised post there may be dated up to now rather than up to its
 * creation.
 */
export function blogPostDate(post: DatedBlogPost, now = Date.now()): Date {
  if (post.publishedAt === undefined) return post.createdAt
  const latest = post.updatedAt
    ? post.updatedAt.getTime() + PUBLISHED_AT_MAX_AHEAD_MS
    : (post.$revision ?? 1) > 1 ? now : post.createdAt.getTime()
  return post.publishedAt <= latest ? new Date(post.publishedAt) : post.createdAt
}

/** A blog's public listing: drafts dropped, newest publication first. */
export function publishedPostsNewestFirst<T extends DatedBlogPost>(posts: readonly T[]): T[] {
  return posts.filter(isPublishedBlogPost).sort((a, b) => blogPostDate(b).getTime() - blogPostDate(a).getTime())
}

/** A post's comments are on unless it explicitly turned them off (a tombstone always has). */
export function commentsAreEnabled(post: { commentsEnabled?: boolean; deleted?: boolean }): boolean {
  return post.commentsEnabled !== false && !isBlogPostTombstone(post)
}

/**
 * What an author's delete writes over a v7 post (`tombstoneIsBlank`): the
 * `deleted` flag and comments off. Every content field is left out, and the
 * fields the contract freezes or keys on (`blogId`, `slug`, `publishedAt`) are
 * carried over from the stored post by the tombstone writer.
 */
export const BLOG_POST_TOMBSTONE = { deleted: true, commentsEnabled: false } as const

/** The stored fields a v7 tombstone keeps: the reference and frozen date, and the slug its URL needs. */
export const BLOG_POST_TOMBSTONE_KEEPS = { identifiers: ['blogId'], scalars: ['slug', 'publishedAt'] } as const

/**
 * True when the network refused a post because its `publishedAt` runs more
 * than {@link PUBLISHED_AT_MAX_AHEAD_MS} past the block time (blog v7
 * `publishedNotAhead`, 10422): the device clock is ahead. The app writes
 * `publishedAt` from that clock.
 */
export function isPublishedAheadRefusal(error: unknown): boolean {
  return /publishedNotAhead/.test(extractErrorMessage(error))
}

/** A blog field the configured cut would refuse, caught before signing; its message is for the user. */
export class BlogFieldError extends Error {}

/** The image URL schemes blog v7 accepts on avatars, headers and covers. */
const V7_IMAGE_URL = /^(https|ipfs):\/\/.+$/

/**
 * An image URL as the configured cut stores it: undefined for none (an empty
 * string is left out, which every cut reads as "no image"). Blog v7 accepts
 * only https:// and ipfs:// URLs, and a write carrying another is refused
 * after signing, so one is refused here first with a {@link BlogFieldError}
 * a person can act on. Older cuts take any string.
 */
export function storedImageUrl(url: string | undefined, what: string): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return undefined
  const problem = imageUrlProblem(trimmed, what)
  if (problem) throw new BlogFieldError(problem)
  return trimmed
}

/** Why `url` cannot be stored as the `what` image on the configured cut, or null (see {@link storedImageUrl}). */
export function imageUrlProblem(url: string, what: string): string | null {
  return blogIsV7() && !V7_IMAGE_URL.test(url.trim()) ? `The ${what} must be an https:// or ipfs:// link.` : null
}

/** A blog's default for new posts: on unless the blog explicitly turned it off (the field is optional). */
export function blogCommentsDefault(blog?: { commentsEnabledDefault?: boolean }): boolean {
  return blog?.commentsEnabledDefault ?? true
}

/** How to name a blog's author: `@username`, or a shortened identity id when they have no DPNS name. */
export function blogAuthorHandle(username: string | null | undefined, ownerId: string): string {
  return username ? `@${username}` : truncateId(ownerId, 8, 6)
}

/**
 * The comments to show: what the last read returned, plus comments this
 * client created that the read did not include yet (a node that has not
 * caught up with the write answers without them), oldest first.
 */
export function mergeComments<T extends { id: string; createdAt: Date }>(loaded: readonly T[], created: readonly T[]): T[] {
  const ids = new Set(loaded.map((comment) => comment.id))
  const missing = created.filter((comment) => !ids.has(comment.id))
  if (missing.length === 0) return [...loaded]
  return [...loaded, ...missing].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/**
 * A post's comment reads, reconciled with the comments this client created.
 * Reads can complete out of order (the first load is still pending when a
 * post-submit refresh starts), so only the latest read may apply: an older one
 * would retire a created comment and then drop it with its pre-write list.
 * A created comment is retired once a current read returns it; from then on
 * the network owns it (a moderator's removal then shows). A comment deleted
 * here stays hidden: a read begun before the delete, or answered by a node
 * that has not applied it, would otherwise bring it back.
 */
export function createCommentReads<T extends { id: string; createdAt: Date; blogPostId: string }>() {
  let generation = 0
  let created: T[] = []
  const deleted = new Set<string>()
  return {
    /** Starts a read, superseding any still in flight; returns its token. */
    begin: () => ++generation,
    isCurrent: (token: number) => token === generation,
    added: (comment: T) => { created = [...created, comment] },
    removed: (id: string) => {
      created = created.filter((comment) => comment.id !== id)
      deleted.add(id)
    },
    /**
     * The list to show once a read returns (`returned` is everything it read,
     * `shown` what survives filtering), or null when a newer read superseded it.
     */
    settle(token: number, postId: string, returned: readonly T[], shown: readonly T[]): T[] | null {
      if (token !== generation) return null
      const ids = new Set(returned.map((comment) => comment.id))
      created = created.filter((comment) => !ids.has(comment.id))
      return mergeComments(
        shown.filter((comment) => !deleted.has(comment.id)),
        created.filter((comment) => comment.blogPostId === postId)
      )
    },
  }
}

export function estimateReadingTime(content: unknown): number {
  const text = extractText(content)
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / 238))
}

/**
 * Resolve author usernames and display names for a list of blog posts.
 * Returns posts enriched with authorUsername, authorDisplayName, and blogName.
 */
export async function enrichBlogPostsWithAuthors<T extends { ownerId: string; blogId: string }>(
  posts: T[],
  blogMap: Map<string, { name: string }>,
): Promise<(T & { authorUsername?: string; authorDisplayName?: string; blogName?: string })[]> {
  if (posts.length === 0) return []

  const { loadIdentityBatch } = await import('@/lib/services/identity-batch')
  const { usernames: usernameMap, profiles } = await loadIdentityBatch(posts.map(post => post.ownerId))
  const profileMap = new Map(profiles.map(profile => [profile.$ownerId, profile]))

  return posts.map((post) => ({
    ...post,
    authorUsername: usernameMap.get(post.ownerId) || undefined,
    authorDisplayName: profileMap.get(post.ownerId)?.displayName || undefined,
    blogName: blogMap.get(post.blogId)?.name || undefined,
  }))
}

/**
 * {@link enrichBlogPostsWithAuthors} for posts from many blogs: the blogs are
 * read by id (one query per 100) for their names. A post whose blog does not
 * come back is dropped: a moderator may remove a blog while its posts stay
 * (they reference the removal record), and a post page needs its blog, so
 * such a card would only lead to "Blog not found".
 */
export async function enrichBlogPostsWithBlogNames<T extends { ownerId: string; blogId: string }>(posts: T[]) {
  if (posts.length === 0) return []
  const { blogService } = await import('@/lib/services/blog-service')
  const blogs = new Map((await blogService.getMany(Array.from(new Set(posts.map((post) => post.blogId))))).map((blog) => [blog.id, blog]))
  return enrichBlogPostsWithAuthors(posts.filter((post) => blogs.has(post.blogId)), blogs)
}
