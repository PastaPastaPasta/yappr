import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Post } from '@/lib/types'

const m = vi.hoisted(() => ({
  getFollowing: vi.fn(),
  getFollowingFeed: vi.fn(),
  fetchPostsOrReplies: vi.fn(),
  fetchQuotedTargets: vi.fn(),
  getUserRepostsBatch: vi.fn(),
  loadIdentityBatch: vi.fn(),
}))
const postService = { getFollowingFeed: m.getFollowingFeed, fetchPostsOrReplies: m.fetchPostsOrReplies, fetchQuotedTargets: m.fetchQuotedTargets }
vi.mock('@/lib/services', () => ({ followService: { getFollowing: m.getFollowing }, postService }))
vi.mock('@/lib/services/post-service', () => ({ postService }))
vi.mock('@/lib/services/repost-service', () => ({ repostService: { getUserRepostsBatch: m.getUserRepostsBatch } }))
vi.mock('@/lib/services/identity-batch', () => ({ loadIdentityBatch: m.loadIdentityBatch }))

const author = { id: 'author1', username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) }

function post(id: string, overrides: Partial<Post> = {}): Post {
  return {
    id, targetKind: 'post', content: id, createdAt: new Date(1000), author,
    likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0, ...overrides,
  } as Post
}

/** Fresh modules per test: the quote caches are module-level state. */
async function freshModules() {
  vi.resetModules()
  for (const mock of Object.values(m)) mock.mockReset()
  // v9: separate repost documents, split quote fields.
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
  const [loader, resolver, targets] = await Promise.all([
    import('./load-following-feed'), import('./resolve-quoted-posts'), import('./quote-targets'),
  ])
  return { ...loader, ...resolver, ...targets }
}

afterEach(() => vi.unstubAllEnvs())

describe('loadFollowingFeed', () => {
  it('hands quotes that arrive only through a followed repost to beforeAttachQuotes, so a since-deleted target is not reattached', async () => {
    const { loadFollowingFeed, attachQuotedPosts, forgetQuotedPosts, getCachedQuotedPost, quoteTargetOf } = await freshModules()

    // An earlier load cached reply R as the target of quote Q.
    const replyR = post('replyR', { targetKind: 'reply', content: 'text from before the delete' })
    m.fetchQuotedTargets.mockResolvedValueOnce([replyR])
    await attachQuotedPosts([post('earlierQuote', { quotedReplyId: 'replyR' })])
    expect(getCachedQuotedPost('replyR')).not.toBeNull()

    // R is then deleted on another device: a fresh read finds nothing.
    m.fetchQuotedTargets.mockResolvedValue([])

    // The followed account's own timeline is empty; Q reaches the page only through its repost.
    m.getFollowing.mockResolvedValue([{ followingId: 'reposter' }])
    m.getFollowingFeed.mockResolvedValue({ documents: [], nextCursor: undefined, prevCursor: undefined })
    m.getUserRepostsBatch.mockResolvedValue([{ postId: 'quoteQ', $ownerId: 'reposter', $createdAt: 2000 }])
    m.fetchPostsOrReplies.mockResolvedValue([post('quoteQ', { quotedReplyId: 'replyR' })])
    m.loadIdentityBatch.mockResolvedValue({ profiles: [], usernames: new Map() })

    const seenByCallback: string[] = []
    let page: Post[] = []
    await loadFollowingFeed({
      userId: 'viewer',
      forceRefresh: false,
      onBatchReady: (posts) => { page = posts },
      enrichProgressively: () => undefined,
      beforeAttachQuotes: (posts) => {
        seenByCallback.push(...posts.map((entry) => entry.id))
        forgetQuotedPosts(posts.flatMap((entry) => quoteTargetOf(entry)?.id ?? []))
      },
    })

    expect(seenByCallback).toContain('quoteQ')
    expect(page.map((entry) => entry.id)).toEqual(['quoteQ'])
    expect(page[0].repostedBy?.id).toBe('reposter')
    // The repost-added quote was resolved afresh: no stale text, and nothing left for a later enrichment to reattach.
    expect(page[0].quotedPost).toBeUndefined()
    expect(getCachedQuotedPost('replyR')).toBeNull()
    expect(m.fetchQuotedTargets).toHaveBeenLastCalledWith({ postIds: [], replyIds: ['replyR'], blogPostIds: [] })
  })
})
