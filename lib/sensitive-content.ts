import type { Post } from '@/lib/types'
import type { SensitiveContentMode } from '@/lib/store'

/**
 * Whether a post should be treated as author-flagged sensitive content.
 * Only `post` documents ever carry the flag (replies are never individually
 * flagged), and a tombstone has no content left to warn about.
 */
export function isSensitivePost(post: Post): boolean {
  return post.sensitive === true && post.deleted !== true
}

/** Whether the gate should cover this post's content for a viewer in `mode`. */
export function shouldGateSensitive(post: Post | undefined, mode: SensitiveContentMode): boolean {
  return post !== undefined && isSensitivePost(post) && mode !== 'show'
}

/**
 * Applies the 'hide' viewer preference to a list surface. Only browsing lists
 * filter — post detail, threads and bookmarks always render the gate instead,
 * so conversations and deliberate saves never grow holes. The viewer's own
 * sensitive posts are never hidden from them.
 */
export function filterHiddenSensitive(
  posts: Post[],
  mode: SensitiveContentMode,
  currentUserId?: string | null
): Post[] {
  if (mode !== 'hide') return posts
  return posts.filter((post) => !isSensitivePost(post) || post.author.id === currentUserId)
}
