/**
 * The read API's topology branches with lib's services mocked: the paths
 * testnet (topology v2, two posts) cannot exercise live (v9/v10 tags,
 * flat-thread paging and stubs, rankings, the v10 quote split, polls), and
 * the review regressions (shared list caches, stale thread refresh, tag
 * authenticity, repost ordering).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Post, Reply, User } from '@/lib/types'

const m = vi.hoisted(() => ({
  topology: {} as Record<string, boolean>,
  viewer: null as string | null,
  postService: {
    enrichPostsBatch: vi.fn(), getPostById: vi.fn(), queryForDisplay: vi.fn(), getUserPosts: vi.fn(),
    getPostsByIds: vi.fn(), getQuotePosts: vi.fn(),
  },
  replyService: { getReplies: vi.fn(), getReplyById: vi.fn(), getNestedReplies: vi.fn(), getUserReplies: vi.fn() },
  followService: {
    getFollowers: vi.fn(), getFollowing: vi.fn(), countFollowersBatch: vi.fn(), countFollowingBatch: vi.fn(),
    getFollowStatusBatch: vi.fn(), getFollowingIds: vi.fn(),
  },
  getPostIdsByHashtag: vi.fn(),
  topLikedPostsHydrated: vi.fn(),
  loadEngagementCounts: vi.fn(),
  getUserReposts: vi.fn(),
  resolveUserReposts: vi.fn(),
  provenAbsent: vi.fn(),
  getPoll: vi.fn(), getTally: vi.fn(), getMyVotes: vi.fn(),
  loadFollowingFeed: vi.fn(),
}))

const FLAGS = ['likesAreIndexOnly', 'repostsAreQuotes', 'hasFlatThreads', 'hashtagsAreInline', 'authorDeletesLeaveHoles', 'referencesMayDangle']
vi.mock('@/lib/contract-topology', async (load) => {
  const actual = await load<Record<string, unknown>>()
  return { ...actual, ...Object.fromEntries(FLAGS.map(flag => [flag, () => m.topology[flag] === true])) }
})
vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/services/post-service', async (load) => ({ ...await load<object>(), postService: m.postService }))
vi.mock('@/lib/services/reply-service', async (load) => ({ ...await load<object>(), replyService: m.replyService }))
vi.mock('@/lib/services/follow-service', async (load) => ({ ...await load<object>(), followService: m.followService }))
vi.mock('@/lib/services/hashtag-service', async (load) => ({ ...await load<object>(), hashtagService: { getPostIdsByHashtag: m.getPostIdsByHashtag } }))
vi.mock('@/lib/services/ranked-likes', async (load) => ({ ...await load<object>(), topLikedPostsHydrated: m.topLikedPostsHydrated }))
vi.mock('@/lib/services/social-stats-service', () => ({ loadEngagementCounts: m.loadEngagementCounts, loadUserStats: vi.fn() }))
vi.mock('@/lib/services/repost-service', async (load) => ({ ...await load<object>(), repostService: { getUserReposts: m.getUserReposts } }))
vi.mock('@/lib/feed/resolve-user-reposts', async (load) => ({ ...await load<object>(), resolveUserReposts: m.resolveUserReposts }))
vi.mock('@/lib/feed/prove-absent', () => ({ provenAbsent: m.provenAbsent }))
vi.mock('@/lib/feed/load-following-feed', () => ({ loadFollowingFeed: m.loadFollowingFeed }))
vi.mock('@/lib/services/pollr-poll-service', async (load) => ({ ...await load<object>(), pollrPollService: { getPoll: m.getPoll } }))
vi.mock('@/lib/services/pollr-vote-service', async (load) => ({ ...await load<object>(), pollrVoteService: { getTally: m.getTally, getMyVotes: m.getMyVotes } }))
vi.mock('@/lib/services/unified-profile-service', async (load) => {
  const actual = await load<{ unifiedProfileService: object }>()
  return { ...actual, unifiedProfileService: { getProfilesByIdentityIds: async () => [], getProfile: async () => null } }
})
vi.mock('@/lib/services/identity-batch', () => ({ loadIdentityBatch: async () => ({ usernames: new Map(), profiles: [], avatars: new Map() }) }))
vi.mock('@/lib/services/dpns-service', async (load) => ({
  ...await load<object>(),
  dpnsService: { getAllUsernamesSortedBatch: async (ids: string[]) => new Map(ids.map(id => [id, [`${id.slice(-4)}.dash`]])) },
}))

const { feed } = await import('../../src/api/feed')
const { posts } = await import('../../src/api/posts')
const { profiles } = await import('../../src/api/profiles')
const { graph } = await import('../../src/api/graph')
const { validate, engagementPage, page, postDTO, threadDTO, pollDTO } = await import('../../src/dto/validate')

/** A 44-character base58 id. */
const id = (tag: string) => tag.replace(/[0OIl]/g, 'z').padEnd(44, 'x')
const AUTHOR = id('Author')
const user = (userId: string): User => ({ id: userId, username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) })
const post = (key: string, at: number, extra: Partial<Post> = {}): Post => ({
  id: id(key), author: user(AUTHOR), content: key, createdAt: new Date(at), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0, ...extra,
})
const reply = (key: string, at: number, under?: string): Reply => ({
  id: id(key), author: user(AUTHOR), content: key, createdAt: new Date(at), likes: 0, reposts: 0, replies: 0, views: 0,
  parentId: id('Root'), parentOwnerId: AUTHOR, rootPostId: id('Root'), ...(under ? { replyToReplyId: id(under) } : {}),
})
const ids = (items: { id: string }[]) => items.map(item => item.id)

beforeEach(() => {
  vi.clearAllMocks()
  m.topology = {}
  m.viewer = null
  // Enrichment resolves every author.
  m.postService.enrichPostsBatch.mockImplementation(async (list: Post[]) =>
    list.map(item => ({ ...item, author: { ...item.author, username: 'alice.dash', hasDpns: true } })))
})

describe('graph', () => {
  it('pages followers and following independently when interleaved', async () => {
    const people = (prefix: string) => Array.from({ length: 40 }, (_, n) => id(`${prefix}${n + 1}`))
    m.followService.getFollowers.mockResolvedValue(people('Fan').map($ownerId => ({ $ownerId })))
    m.followService.getFollowing.mockResolvedValue(people('Idol').map(followingId => ({ followingId })))
    m.followService.countFollowersBatch.mockResolvedValue(new Map())
    m.followService.countFollowingBatch.mockResolvedValue(new Map())
    const followers = await graph.followers(AUTHOR)
    await graph.following(AUTHOR)
    const more = await graph.followers(AUTHOR, followers.cursor)
    expect(ids(more.items)).toEqual(people('Fan').slice(30))
  })
})

describe('posts.thread on flat threads (v9/v10)', () => {
  beforeEach(() => {
    m.topology = { hasFlatThreads: true, authorDeletesLeaveHoles: true }
    m.postService.getPostById.mockResolvedValue(post('Root', 1))
    m.provenAbsent.mockResolvedValue(new Set())
  })

  it('re-reads the replies on a refresh, and reuses read pages only on a continuation', async () => {
    m.replyService.getReplies.mockResolvedValueOnce({ documents: [reply('One', 2)] })
    expect(ids((await posts.thread(id('Root'))).replies.items)).toEqual([id('One')])
    m.replyService.getReplies.mockResolvedValueOnce({ documents: [reply('One', 2), reply('Two', 3)] })
    expect(ids((await posts.thread(id('Root'))).replies.items)).toEqual([id('One'), id('Two')])

    m.replyService.getReplies.mockReset()
    m.replyService.getReplies.mockResolvedValueOnce({ documents: [reply('One', 2)], nextCursor: id('One') })
    const first = await posts.thread(id('Root'))
    expect(first.replies.cursor).not.toBeNull()
    // Another author's answer to One (the focus author's own would join the author thread).
    m.replyService.getReplies.mockResolvedValueOnce({ documents: [{ ...reply('Three', 4, 'One'), author: user(id('Other')) }] })
    const second = await posts.thread(id('Root'), first.replies.cursor)
    // Cumulative and re-nested; page 1 came from the cache.
    expect(second.replies.items.map(item => [item.id, item.depth])).toEqual([[id('One'), 0], [id('Three'), 1]])
    expect(m.replyService.getReplies).toHaveBeenCalledTimes(2)
    expect(m.replyService.getReplies).toHaveBeenLastCalledWith(id('Root'), { skipEnrichment: true, startAfter: id('One') })
    await expect(posts.thread(id('Other'), first.replies.cursor)).rejects.toMatchObject({ code: 'BAD_CURSOR' })
  })

  it('keeps replies under a proved-deleted parent below a blank stub', async () => {
    m.replyService.getReplies.mockResolvedValue({ documents: [reply('Orphan', 5, 'Gone')] })
    m.provenAbsent.mockResolvedValue(new Set([id('Gone')]))
    const thread = await posts.thread(id('Root'))
    expect(validate(threadDTO, thread)).toEqual([])
    expect(thread.replies.items.map(item => [item.id, item.depth, item.deletedStub ?? false])).toEqual([
      [id('Gone'), 0, true], [id('Orphan'), 1, false],
    ])
    expect(thread.replies.items[0].author).toEqual({ id: '', username: null, displayName: '', avatar: { uri: null, dicebear: null }, resolved: false })
  })
})

describe('feed.hashtag', () => {
  it('v9/v10: pages tagAndTime by document cursor, in storage form, per tag', async () => {
    m.topology = { hashtagsAreInline: true }
    const full = Array.from({ length: 50 }, (_, n) => post(`Tag${n + 1}`, 100 - n))
    m.postService.queryForDisplay.mockResolvedValueOnce({ documents: full }).mockResolvedValueOnce({ documents: [post('Last', 1)] })
    const first = await feed.hashtag({ tag: '$DASH' })
    expect(m.postService.queryForDisplay.mock.calls[0][0].where[0]).toEqual(['hashtag', '==', 'dash_cashtag'])
    expect(validate(page(postDTO), first)).toEqual([])
    const second = await feed.hashtag({ tag: 'dash_cashtag', cursor: first.cursor })
    expect(m.postService.queryForDisplay.mock.calls[1][0].startAfter).toBe(full[49].id)
    expect(second).toMatchObject({ cursor: null, hasMore: false })
    await expect(feed.hashtag({ tag: '#Other', cursor: first.cursor })).rejects.toMatchObject({ code: 'BAD_CURSOR' })
  })

  it('v2: keeps a post one of its taggers wrote, whoever tagged it last', async () => {
    m.getPostIdsByHashtag.mockResolvedValue([
      { postId: id('Tagged'), $ownerId: id('Stranger') },
      { postId: id('Tagged'), $ownerId: AUTHOR },
      { postId: id('Forged'), $ownerId: id('Stranger') },
    ])
    m.postService.getPostsByIds.mockResolvedValue([post('Tagged', 2), post('Forged', 1)])
    expect(ids((await feed.hashtag({ tag: '#Yappr' })).items)).toEqual([id('Tagged')])
    expect(m.getPostIdsByHashtag).toHaveBeenCalledWith('yappr')
  })
})

describe('Top sorts', () => {
  it('rejects without rankings, widens K and returns only unseen ids, and ties cursors to the window', async () => {
    await expect(feed.home({ tab: 'forYou', sort: 'top' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    m.topology = { likesAreIndexOnly: true }
    const ranked = Array.from({ length: 25 }, (_, n) => post(`Top${n + 1}`, n))
    m.topLikedPostsHydrated.mockResolvedValueOnce(ranked.slice(0, 20)).mockResolvedValueOnce([...ranked].reverse())
    const first = await feed.home({ tab: 'forYou', sort: 'top' })
    expect(first.items).toHaveLength(20)
    const second = await feed.home({ tab: 'forYou', sort: 'top', cursor: first.cursor })
    expect(ids(second.items)).toEqual(ids(ranked.slice(20).reverse()))
    expect(m.topLikedPostsHydrated).toHaveBeenLastCalledWith({ limit: 40, window: 'all', force: true, throwOnError: true })
    expect(second.hasMore).toBe(false)
    await expect(feed.home({ tab: 'forYou', sort: 'top', window: 'today', cursor: first.cursor })).rejects.toMatchObject({ code: 'BAD_CURSOR' })
  })
})

describe('Following feed', () => {
  it('rejects a load lib reported as an empty page', async () => {
    await expect(feed.home({ tab: 'following' })).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    m.viewer = AUTHOR
    m.loadFollowingFeed.mockImplementationOnce(async ({ onBatchReady }) => onBatchReady([], null, false))
    await expect(feed.home({ tab: 'following' })).rejects.toMatchObject({ code: 'NETWORK' })
    m.loadFollowingFeed.mockImplementationOnce(async ({ onBatchReady, enrichProgressively }) => {
      onBatchReady([], null, false)
      enrichProgressively([])
    })
    expect(await feed.home({ tab: 'following' })).toEqual({ items: [], cursor: null, hasMore: false })
  })
})

describe('v10 quote split', () => {
  const bare = (key: string) => post(key, 1, { content: '', quotedPostId: id('Target') })

  it('splits bare reposts from quotes for the counts and both tabs, flagging a full list', async () => {
    m.topology = { repostsAreQuotes: true }
    m.loadEngagementCounts.mockResolvedValue({ likes: 4, reposts: 0, quotes: 3 })
    m.postService.getQuotePosts.mockResolvedValue([bare('Bare1'), bare('Bare2'), post('Quote1', 1, { quotedPostId: id('Target') })])
    const target = { id: id('Target'), kind: 'post' as const }
    expect(await posts.engagementCounts(target)).toEqual({ likes: 4, reposts: 2, quotes: 1, truncated: false })
    const reposts = await posts.engagements(target, 'reposts')
    expect(validate(engagementPage, reposts)).toEqual([])
    expect(reposts.items.map(entry => entry.quote?.id)).toEqual([id('Bare1'), id('Bare2')])

    m.postService.getQuotePosts.mockResolvedValue(Array.from({ length: 100 }, (_, n) => bare(`B${n + 1}`)))
    const full = await posts.engagements(target, 'reposts')
    expect(full).toMatchObject({ truncated: true, hasMore: true })
    expect(await posts.engagementCounts(target)).toMatchObject({ reposts: 100, truncated: true })
  })
})

describe('posts.poll', () => {
  it('degrades each part alone, as poll-card does', async () => {
    m.viewer = AUTHOR
    m.getPoll.mockResolvedValue({ id: id('Poll'), ownerId: AUTHOR, createdAt: new Date(1), question: 'Q?', options: ['a', 'b'], multiChoice: false })
    m.getTally.mockRejectedValue(new Error('proof failed'))
    m.getMyVotes.mockRejectedValue(new Error('timeout'))
    const poll = await posts.poll({ id: id('Poll') })
    expect(validate(pollDTO, poll)).toEqual([])
    expect(poll).toMatchObject({ totalVotes: null, myVotes: null, options: [{ text: 'a', votes: 0 }, { text: 'b', votes: 0 }] })
    m.getTally.mockResolvedValue({ counts: [2, 1], total: 3 })
    m.getMyVotes.mockResolvedValue([0])
    expect(await posts.poll({ id: id('Poll') })).toMatchObject({ totalVotes: 3, myVotes: [0], options: [{ votes: 2 }, { votes: 1 }] })
  })
})

describe('profiles.posts Posts tab (v2/v9 reposts)', () => {
  it('places each repost on the page its time falls in, flushing the rest on the last page', async () => {
    const own = Array.from({ length: 60 }, (_, n) => post(`Own${n + 1}`, 1000 - n * 10))
    m.postService.getUserPosts.mockResolvedValueOnce({ documents: own.slice(0, 50) }).mockResolvedValueOnce({ documents: own.slice(50) })
    const repost = (key: string, at: number) => ({ ...post(key, 0), author: user(id('Other')), repostedBy: { id: AUTHOR }, repostTimestamp: new Date(at) })
    m.getUserReposts.mockResolvedValue([{}])
    m.resolveUserReposts.mockResolvedValue([repost('New', 995), repost('Old', 455), repost('Ancient', 1)])
    const first = await profiles.posts({ id: AUTHOR, tab: 'posts' })
    expect(ids(first.items).slice(0, 2)).toEqual([own[0].id, id('New')])
    expect(ids(first.items)).not.toContain(id('Old'))
    const second = await profiles.posts({ id: AUTHOR, tab: 'posts', cursor: first.cursor })
    expect(ids(second.items)).toEqual([...ids(own.slice(50, 55)), id('Old'), ...ids(own.slice(55)), id('Ancient')])
    expect(second.cursor).toBeNull()
  })
})
