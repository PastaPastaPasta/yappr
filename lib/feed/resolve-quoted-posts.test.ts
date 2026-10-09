import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Post } from '@/lib/types'

const fetchQuotedTargets = vi.hoisted(() => vi.fn())
const fetchPostsOrReplies = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services/post-service', () => ({
  postService: { fetchQuotedTargets, fetchPostsOrReplies },
}))

function quotingPost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'quoting', targetKind: 'post', content: 'look at this', createdAt: new Date(1000),
    author: { id: 'author1', username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(1000) },
    likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0,
    quotedPostId: 'target1',
    ...overrides,
  } as Post
}

function targetPost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'target1', targetKind: 'post', content: 'original text', createdAt: new Date(500),
    author: { id: 'author2', username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(500) },
    likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0,
    ...overrides,
  } as Post
}

/** A fresh copy of the module per test: its caches are module-level state. */
async function freshModule() {
  vi.resetModules()
  fetchQuotedTargets.mockReset()
  fetchPostsOrReplies.mockReset()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
  return import('./resolve-quoted-posts')
}

afterEach(() => vi.unstubAllEnvs())

describe('resolve-quoted-posts caches', () => {
  it('drops a resolved quote target from the shared cache (item 1/11: a delete forgets it)', async () => {
    const { attachQuotedPosts, forgetQuotedPosts, getCachedQuotedPost } = await freshModule()
    fetchQuotedTargets.mockResolvedValue([targetPost()])

    const post = quotingPost()
    await attachQuotedPosts([post])
    expect(post.quotedPost?.id).toBe('target1')
    expect(getCachedQuotedPost('target1')).not.toBeNull()

    const dropped = forgetQuotedPosts(['target1'])
    expect(dropped).toEqual(['target1'])
    expect(getCachedQuotedPost('target1')).toBeNull()
  })

  it('does not let a stale in-flight lookup overwrite what a later lookup cached after a forget (item 2)', async () => {
    const { attachQuotedPosts, forgetQuotedPosts, getCachedQuotedPost } = await freshModule()
    let resolveStale: (posts: Post[]) => void = () => undefined
    fetchQuotedTargets
      .mockImplementationOnce(() => new Promise<Post[]>((resolve) => { resolveStale = resolve }))
      .mockImplementationOnce(async () => [targetPost({ content: 'fresh text after the forget' })])

    // A batch pass starts resolving `target1` but its network call never answers yet.
    const staleAttach = attachQuotedPosts([quotingPost({ id: 'quoting-1' })])

    // The quoted post is deleted (or anything else forgets it) while that lookup is still in flight.
    forgetQuotedPosts(['target1'])

    // A later caller (a fresh page load, the per-card fallback) starts its own lookup and caches a fresh result.
    await attachQuotedPosts([quotingPost({ id: 'quoting-2' })])
    expect(getCachedQuotedPost('target1')?.content).toBe('fresh text after the forget')

    // The stale lookup that was already underway when the forget ran finally resolves...
    resolveStale([targetPost({ content: 'stale text from before the delete' })])
    await staleAttach

    // ...but must not overwrite the fresher cached result with its outdated text.
    expect(getCachedQuotedPost('target1')?.content).toBe('fresh text after the forget')
  })

  it('still sets the stale lookup result on its own post object: only the shared cache is gated', async () => {
    const { attachQuotedPosts, forgetQuotedPosts } = await freshModule()
    let resolveStale: (posts: Post[]) => void = () => undefined
    fetchQuotedTargets.mockImplementationOnce(() => new Promise<Post[]>((resolve) => { resolveStale = resolve }))

    const post = quotingPost()
    const attaching = attachQuotedPosts([post])
    forgetQuotedPosts(['target1'])
    resolveStale([targetPost({ content: 'stale text from before the delete' })])
    await attaching

    expect(post.quotedPost?.content).toBe('stale text from before the delete')
  })
})
