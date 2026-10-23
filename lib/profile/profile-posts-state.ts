import type { Post } from '@/lib/types'
import { byNewestActivity } from '@/lib/feed/resolve-user-reposts'

/**
 * The posts tab of one profile view: the posts, where the next page starts and
 * whether there is one. It belongs to one `scope` (a profile, the viewer and a
 * load generation), and every transition names the scope its caller started
 * under. A result that lands after the view moved on (another profile, another
 * viewer, a reload) therefore finds a different scope and changes nothing.
 */
export interface ProfilePostsState {
  scope: string
  posts: Post[]
  /** Where the next page of original posts starts; null until a page has some. */
  lastPostId: string | null
  hasMore: boolean
  /** The first page could not be read. Distinct from a profile with no posts. */
  failed: boolean
}

export function profilePostsScope(userId: string, viewerId: string | undefined, generation: number): string {
  return `${userId}:${viewerId ?? ''}:${generation}`
}

/** A view that has not read its first page yet. */
export function emptyProfilePosts(scope: string): ProfilePostsState {
  return { scope, posts: [], lastPostId: null, hasMore: true, failed: false }
}

/**
 * Replace the view with its first page. A successful empty page is committed
 * like any other, so the previous profile's posts never survive it.
 */
export function commitProfileFirstPage(
  current: ProfilePostsState,
  scope: string,
  page: { posts: Post[]; originals: Post[]; failed: boolean },
  pageSize: number,
): ProfilePostsState {
  if (current.scope !== scope) return current
  const { originals } = page
  return {
    scope,
    posts: page.posts,
    lastPostId: originals.length > 0 ? originals[originals.length - 1].id : null,
    hasMore: !page.failed && originals.length >= pageSize,
    failed: page.failed,
  }
}

/** Add a later page, unless the view it was read for has been replaced. */
export function appendProfilePostsPage(
  current: ProfilePostsState,
  scope: string,
  page: { posts: Post[]; documents: Post[] },
  pageSize: number,
): ProfilePostsState {
  if (current.scope !== scope) return current
  const seen = new Set(current.posts.map((post) => post.id))
  const { documents } = page
  return {
    ...current,
    posts: [...current.posts, ...page.posts.filter((post) => !seen.has(post.id))].sort(byNewestActivity),
    lastPostId: documents.length > 0 ? documents[documents.length - 1].id : current.lastPostId,
    hasMore: documents.length >= pageSize,
  }
}
