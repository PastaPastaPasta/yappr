/**
 * Reposts as quotes (v10). Social v10 has no `repost` doctype: a repost is a
 * `post` that names its target in `quotedPostId` (a post) or `quotedReplyId` (a
 * reply) and carries nothing of its own. The unique `ownerAndQuotedPost` and
 * `ownerAndQuotedReply` indexes allow one quote OR repost per author and target,
 * so the viewer's "repost" of a target and their "quote" of it are the same slot.
 *
 * These helpers are pure: they classify posts that are already loaded.
 */

import type { Post } from '@/lib/types'
import { repostsAreQuotes } from '@/lib/contract-topology'

/** The viewer's own quote or repost of a target. At most one exists per target on v10. */
export interface OwnQuote {
  /** The quote post's document id. */
  id: string
  /** True for a bare repost; false for a quote with text, media or an embed of its own. */
  bare: boolean
}

/** The parts of a post that decide whether it is a bare repost. */
export type QuoteBody = Pick<Post, 'content' | 'encryptedContent' | 'media' | 'embedId' | 'quotedPostId' | 'quotedReplyId'>

/**
 * True when a post quotes something and carries nothing of its own: no text,
 * no ciphertext, no media and no embed. On v10 that is a repost. The chain's
 * `notEmpty` rule only lets a post through with no content when it quotes (or
 * has media, an embed or ciphertext), so no other post is empty.
 */
export function isQuoteOnly(post: QuoteBody): boolean {
  if (!post.quotedPostId && !post.quotedReplyId) return false
  return !post.content?.trim() && !post.encryptedContent?.length && !post.media?.length && !post.embedId
}

/**
 * True for a post the feed renders as a repost of its target ("X reposted"
 * over the target's own card) instead of as an empty quote card. v10 only:
 * elsewhere a repost is a separate `repost` document.
 */
export function isBareRepost(post: QuoteBody & { deleted?: boolean }): boolean {
  return repostsAreQuotes() && !post.deleted && isQuoteOnly(post)
}

/** The viewer's quote or repost described as an {@link OwnQuote}. */
export function ownQuoteOf(post: QuoteBody & { id: string }): OwnQuote {
  return { id: post.id, bare: isQuoteOnly(post) }
}

/**
 * The author a v10 bare repost is SHOWN as (its target's author), or null for
 * any other post. Block and hide filters that look at `post.author` must also
 * look at this, or a blocked author resurfaces through someone's repost.
 */
export function repostedAuthorIdOf(post: QuoteBody & Pick<Post, 'quotedPostOwnerId' | 'quotedPost'> & { deleted?: boolean }): string | null {
  if (!isBareRepost(post)) return null
  return post.quotedPostOwnerId ?? post.quotedPost?.author.id ?? null
}

/** The id of the post or reply a quote post points at, if any. */
export function quotedTargetIdOf(post: Pick<Post, 'quotedPostId' | 'quotedReplyId'>): string | undefined {
  return post.quotedPostId ?? post.quotedReplyId
}

/**
 * One card per reposted target in a newest-first feed (v10). The global
 * timeline holds every bare repost as a post of its own, so a popular post
 * would otherwise appear once per reposter plus once as itself. The first
 * card for a target stays where it is (the newest activity on it); later
 * bare reposts of the same target and the target itself are dropped, and a
 * kept repost card counts the other reposters in `repostedByOthers`.
 * Quotes with text are posts in their own right and always stay.
 */
export function collapseReposts<T extends QuoteBody & { id: string; deleted?: boolean }>(posts: readonly T[]): Array<T & { repostedByOthers?: number }> {
  const keptAt = new Map<string, number>()
  const others = new Map<number, number>()
  const kept: T[] = []
  for (const post of posts) {
    const bare = isBareRepost(post)
    const key = bare ? quotedTargetIdOf(post) ?? post.id : post.id
    const at = keptAt.get(key)
    if (at === undefined) {
      keptAt.set(key, kept.length)
      kept.push(post)
      continue
    }
    if (bare && isBareRepost(kept[at])) others.set(at, (others.get(at) ?? 0) + 1)
  }
  return kept.map((post, at) => (others.has(at) ? { ...post, repostedByOthers: others.get(at) } : post))
}

/**
 * A target's quote list split into bare reposts and quotes with text (v10's
 * engagements page: the Reposts tab and the Quotes tab read the same list).
 * Order is preserved within each half.
 */
export function splitRepostsAndQuotes<T extends QuoteBody>(posts: readonly T[]): { reposts: T[]; quotes: T[] } {
  const reposts: T[] = []
  const quotes: T[] = []
  for (const post of posts) (isQuoteOnly(post) ? reposts : quotes).push(post)
  return { reposts, quotes }
}

/**
 * What a post quoting the viewer's post or reply notifies as: a bare repost is
 * "reposted your post", anything with text "quoted your post".
 */
export function quoteNotificationType(post: QuoteBody): 'repost' | 'quote' {
  return isQuoteOnly(post) ? 'repost' : 'quote'
}
