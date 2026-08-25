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

/** Build a blog post URL path from blogId and slug. */
export function getBlogPostUrl(blogId: string, slug: string): string {
  return `/blog?blog=${encodeURIComponent(blogId)}&post=${encodeURIComponent(slug)}`
}

export function parseLabels(value?: string): string[] {
  if (!value) return []
  return Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)))
}

export function labelsToCsv(items: string[]): string {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).join(',')
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

  const { dpnsService } = await import('@/lib/services/dpns-service')
  const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

  const ownerIds = Array.from(new Set(posts.map((p) => p.ownerId)))
  const [usernameMap, profileEntries] = await Promise.all([
    dpnsService.resolveUsernamesBatch(ownerIds),
    Promise.all(
      ownerIds.map(async (id) => {
        const profile = await unifiedProfileService.getProfile(id).catch(() => null)
        return [id, profile] as const
      }),
    ),
  ])

  const profileMap = new Map(profileEntries)

  return posts.map((post) => ({
    ...post,
    authorUsername: usernameMap.get(post.ownerId) || undefined,
    authorDisplayName: profileMap.get(post.ownerId)?.displayName || undefined,
    blogName: blogMap.get(post.blogId)?.name || undefined,
  }))
}
