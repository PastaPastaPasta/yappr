import { describe, expect, it } from 'vitest'
import type { Post } from '@/lib/types'
import {
  appendProfilePostsPage,
  commitProfileFirstPage,
  emptyProfilePosts,
  profilePostsScope,
  type ProfilePostsState,
} from './profile-posts-state'

const PAGE_SIZE = 2

function post(id: string, createdAt: number): Post {
  return { id, createdAt: new Date(createdAt) } as Post
}

const ids = (state: ProfilePostsState) => state.posts.map((p) => p.id)

/** A view's state cell, updated through functional updaters the way React applies them. */
function cell(initial: ProfilePostsState) {
  let state = initial
  return {
    get: () => state,
    set: (update: (current: ProfilePostsState) => ProfilePostsState) => { state = update(state) },
  }
}

describe('profile posts state', () => {
  const scopeA = profilePostsScope('A', 'viewer', 1)
  const scopeB = profilePostsScope('B', 'viewer', 2)

  it('scopes a view by profile, viewer and load generation', () => {
    expect(new Set([
      profilePostsScope('A', 'viewer', 1),
      profilePostsScope('B', 'viewer', 1),
      profilePostsScope('A', undefined, 1),
      profilePostsScope('A', 'viewer', 2),
    ]).size).toBe(4)
  })

  it('replaces a populated profile with the next profile\'s empty first page', () => {
    const view = cell(emptyProfilePosts(scopeA))
    const aPosts = [post('a1', 2000), post('a2', 1000)]
    view.set((c) => commitProfileFirstPage(c, scopeA, { posts: aPosts, originals: aPosts, failed: false }, PAGE_SIZE))
    expect(ids(view.get())).toEqual(['a1', 'a2'])

    // Navigate to B: the view starts over, and B's page is a successful empty one.
    view.set(() => emptyProfilePosts(scopeB))
    view.set((c) => commitProfileFirstPage(c, scopeB, { posts: [], originals: [], failed: false }, PAGE_SIZE))
    expect(view.get()).toEqual({ scope: scopeB, posts: [], lastPostId: null, hasMore: false, failed: false })
  })

  it('commits an empty first page over posts already in the same view', () => {
    const view = cell(emptyProfilePosts(scopeA))
    view.set((c) => commitProfileFirstPage(c, scopeA, { posts: [post('a1', 1)], originals: [post('a1', 1)], failed: false }, PAGE_SIZE))
    view.set((c) => commitProfileFirstPage(c, scopeA, { posts: [], originals: [], failed: false }, PAGE_SIZE))
    expect(ids(view.get())).toEqual([])
    expect(view.get().lastPostId).toBeNull()
  })

  it('keeps a failed first page distinct from an empty one', () => {
    const empty = commitProfileFirstPage(emptyProfilePosts(scopeA), scopeA, { posts: [], originals: [], failed: false }, PAGE_SIZE)
    const failed = commitProfileFirstPage(emptyProfilePosts(scopeA), scopeA, { posts: [], originals: [], failed: true }, PAGE_SIZE)
    expect(empty.failed).toBe(false)
    expect(failed.failed).toBe(true)
    expect(failed).not.toEqual(empty)
    expect(failed.hasMore).toBe(false)
  })

  it('pages from the last original post and stops on a short page', () => {
    const first = [post('a1', 4000), post('a2', 3000)]
    let state = commitProfileFirstPage(emptyProfilePosts(scopeA), scopeA, { posts: first, originals: first, failed: false }, PAGE_SIZE)
    expect(state.lastPostId).toBe('a2')
    expect(state.hasMore).toBe(true)

    const next = [post('a3', 2000)]
    state = appendProfilePostsPage(state, scopeA, { posts: next, documents: next }, PAGE_SIZE)
    expect(ids(state)).toEqual(['a1', 'a2', 'a3'])
    expect(state.lastPostId).toBe('a3')
    expect(state.hasMore).toBe(false)
  })

  it('drops a next page that lands after the profile changed, and keeps B\'s cursor', () => {
    const view = cell(emptyProfilePosts(scopeA))
    const aFirst = [post('a1', 4000), post('a2', 3000)]
    view.set((c) => commitProfileFirstPage(c, scopeA, { posts: aFirst, originals: aFirst, failed: false }, PAGE_SIZE))
    // A's next page is requested here, under scopeA, and is still out when the profile changes.
    const delayedScope = view.get().scope

    view.set(() => emptyProfilePosts(scopeB))
    const bFirst = [post('b1', 5000), post('b2', 4500)]
    view.set((c) => commitProfileFirstPage(c, scopeB, { posts: bFirst, originals: bFirst, failed: false }, PAGE_SIZE))
    const before = view.get()

    const aNext = [post('a3', 2000), post('a4', 1000)]
    view.set((c) => appendProfilePostsPage(c, delayedScope, { posts: aNext, documents: aNext }, PAGE_SIZE))

    expect(view.get()).toBe(before)
    expect(ids(view.get())).toEqual(['b1', 'b2'])
    expect(view.get().lastPostId).toBe('b2')
  })

  it('drops a late first page from a load that was replaced', () => {
    const view = cell(emptyProfilePosts(scopeB))
    view.set((c) => commitProfileFirstPage(c, scopeA, { posts: [post('a1', 1)], originals: [post('a1', 1)], failed: false }, PAGE_SIZE))
    expect(view.get()).toEqual(emptyProfilePosts(scopeB))
  })

  it('drops a next page that belongs to a reload of the same profile', () => {
    const first = profilePostsScope('A', 'viewer', 1)
    const reload = profilePostsScope('A', 'viewer', 2)
    const view = cell(emptyProfilePosts(first))
    view.set(() => emptyProfilePosts(reload))
    const late = [post('a9', 1)]
    view.set((c) => appendProfilePostsPage(c, first, { posts: late, documents: late }, PAGE_SIZE))
    expect(view.get().posts).toEqual([])
    expect(view.get().scope).toBe(reload)
  })
})
