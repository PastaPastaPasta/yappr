import type { Post } from '@/lib/types'
import type { FollowingFeedWindow } from './load-following-feed'

/**
 * What continues a feed after its current page: For You reads on from the last
 * post's id, Following from a time window.
 */
export type FeedPageToken =
  | { kind: 'cursor'; cursor: string | null }
  | { kind: 'window'; window: FollowingFeedWindow | null }

/** A first page as cached: its posts and the way to its next page, saved and restored together. */
export interface CachedFeedPage {
  posts: Post[]
  hasMore: boolean
  token: FeedPageToken
}

function isWindow(value: unknown): value is FollowingFeedWindow {
  if (!value || typeof value !== 'object') return false
  const { start, end, windowHours } = value as Partial<FollowingFeedWindow>
  return start instanceof Date && !Number.isNaN(start.getTime())
    && end instanceof Date && !Number.isNaN(end.getTime())
    && typeof windowHours === 'number' && windowHours > 0
}

/**
 * The cached page if it is whole, else null (a miss, so the feed reloads).
 * Rejected: a record of an older shape, a token of the other feed kind, and a
 * page that claims more but has no way to reach it.
 */
export function readCachedFeedPage(value: unknown, kind: FeedPageToken['kind']): CachedFeedPage | null {
  if (!value || typeof value !== 'object') return null
  const { posts, hasMore, token } = value as Partial<CachedFeedPage>
  if (!Array.isArray(posts) || typeof hasMore !== 'boolean' || !token || token.kind !== kind) return null
  if (token.kind === 'cursor') {
    if (token.cursor !== null && typeof token.cursor !== 'string') return null
    if (hasMore && !token.cursor) return null
  } else {
    if (token.window !== null && !isWindow(token.window)) return null
    if (hasMore && !token.window) return null
  }
  return { posts, hasMore, token }
}
