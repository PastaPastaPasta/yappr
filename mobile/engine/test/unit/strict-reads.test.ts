/**
 * Reads that must reject, not answer an empty list, when the network fails:
 * the Top sorts through lib's real ranked service (its cache included), the
 * Following Top's follow list, the v2 tag list and the mentions tab. An empty
 * answer would replace the page the app shows and cannot be retried.
 * Only the SDK, the composite page and the viewer are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Post, User } from '@/lib/types'

const m = vi.hoisted(() => ({
  topology: {} as Record<string, boolean>,
  viewer: null as string | null,
  ranked: vi.fn(),
  query: vi.fn(),
  hydrate: vi.fn(),
  getFollowing: vi.fn(),
}))

const FLAGS = ['likesAreIndexOnly', 'hashtagsAreInline', 'mentionsAreInline']
vi.mock('@/lib/contract-topology', async (load) => {
  const actual = await load<Record<string, unknown>>()
  return { ...actual, ...Object.fromEntries(FLAGS.map(flag => [flag, () => m.topology[flag] === true])) }
})
vi.mock('@/lib/services/evo-sdk-service', async (load) => ({
  ...await load<object>(),
  getEvoSdk: async () => ({ documents: { ranked: m.ranked, query: m.query } }),
}))
vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/feed/composite-feed-page', () => ({ loadCompositeFeedPage: m.hydrate }))
vi.mock('@/lib/services/follow-service', async (load) => {
  const actual = await load<{ followService: object }>()
  return { ...actual, followService: Object.assign(Object.create(actual.followService), { getFollowing: m.getFollowing }) }
})

const { feed } = await import('../../src/api/feed')
const { profiles } = await import('../../src/api/profiles')
const { explore } = await import('../../src/api/explore')

/** A 44-character base58 id. */
const id = (tag: string) => tag.replace(/[0OIl]/g, 'z').padEnd(44, 'x')
const AUTHOR = id('Author')
const VIEWER = id('Viewer')
const user = (userId: string): User => ({ id: userId, username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) })
const post = (key: string): Post => ({
  id: id(key), author: user(AUTHOR), content: key, createdAt: new Date(1), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0,
})

/** A one-post ranking the composite page proves. */
function rankedPage(key: string) {
  m.ranked.mockResolvedValueOnce({ entries: [{ groupValue: id(key), value: BigInt(3) }] })
  m.hydrate.mockResolvedValueOnce({ rawPosts: [{ $id: id(key) }], posts: [post(key)], preloaded: {} })
}

/** Each Top read with a key of its own in the ranked cache. */
const TOP_READS: [string, (refresh: boolean) => Promise<unknown>][] = [
  ['Explore Top', refresh => explore.topPosts({ window: 'all', refresh })],
  ['a tag\'s Top', refresh => feed.hashtag({ tag: '#Dash', sort: 'top', refresh })],
  ['a profile\'s Top tab', refresh => profiles.posts({ id: AUTHOR, tab: 'top', refresh })],
  ['Home Top', refresh => feed.home({ tab: 'forYou', sort: 'top', refresh })],
]

beforeEach(() => {
  vi.resetAllMocks()
  m.topology = { likesAreIndexOnly: true, hashtagsAreInline: true, mentionsAreInline: true }
  m.viewer = null
})

describe('Top reads', () => {
  it.each(TOP_READS)('%s rejects when its first ranking fails', async (_name, read) => {
    m.ranked.mockRejectedValue(new Error('ranking down'))
    await expect(read(false)).rejects.toThrow('ranking down')
  })

  it.each(TOP_READS)('%s rejects when its first page fails to hydrate', async (_name, read) => {
    m.ranked.mockResolvedValue({ entries: [{ groupValue: id('Hydrate'), value: BigInt(1) }] })
    m.hydrate.mockRejectedValue(new Error('hydration down'))
    await expect(read(false)).rejects.toThrow('hydration down')
  })

  it.each(TOP_READS)('%s rejects a failed pull to refresh rather than answering an empty page', async (name, read) => {
    // Explore's and Home's Top share a cache key, so the shown page is read
    // fresh too rather than from the previous case's cache.
    const key = name.replace(/\W/g, '')
    rankedPage(`Shown${key}`)
    expect(JSON.stringify(await read(true))).toContain(id(`Shown${key}`))
    m.ranked.mockRejectedValueOnce(new Error('ranking down'))
    await expect(read(true)).rejects.toThrow('ranking down')
    m.ranked.mockResolvedValueOnce({ entries: [{ groupValue: id(`Lost${key}`), value: BigInt(3) }] })
    m.hydrate.mockRejectedValueOnce(new Error('hydration down'))
    await expect(read(true)).rejects.toThrow('hydration down')
    // The failed refresh dropped the cached page, so the next read is fresh.
    rankedPage(`Next${key}`)
    expect(JSON.stringify(await read(false))).toContain(id(`Next${key}`))
  })

  it('Following Top rejects when the follow list fails, rather than ranking nobody', async () => {
    m.viewer = VIEWER
    m.getFollowing.mockRejectedValue(new Error('follows down'))
    await expect(feed.home({ tab: 'following', sort: 'top' })).rejects.toThrow('follows down')
    expect(m.getFollowing).toHaveBeenCalledWith(VIEWER, { throwOnError: true })
    expect(m.ranked).not.toHaveBeenCalled()
  })

  it('Following Top rejects when a followed author\'s ranking fails on a refresh', async () => {
    m.viewer = VIEWER
    m.getFollowing.mockResolvedValue([{ followingId: AUTHOR }])
    m.ranked.mockRejectedValue(new Error('ranking down'))
    await expect(feed.home({ tab: 'following', sort: 'top', refresh: true })).rejects.toThrow('ranking down')
  })
})

describe('list reads lib would report as empty', () => {
  it('a v2 tag rejects when its tag documents fail, and the failure is not cached', async () => {
    m.topology = {}
    m.query.mockRejectedValueOnce(new Error('tags down'))
    await expect(feed.hashtag({ tag: '#Quiet' })).rejects.toThrow('tags down')
    m.query.mockResolvedValueOnce([])
    await expect(feed.hashtag({ tag: '#Quiet' })).resolves.toMatchObject({ items: [] })
    expect(m.query).toHaveBeenCalledTimes(2)
  })

  it('the mentions tab rejects when its mention documents fail, and the failure is not cached', async () => {
    m.query.mockRejectedValue(new Error('mentions down'))
    await expect(profiles.posts({ id: id('Mentioned'), tab: 'mentions' })).rejects.toThrow('mentions down')
    const calls = m.query.mock.calls.length
    await expect(profiles.posts({ id: id('Mentioned'), tab: 'mentions' })).rejects.toThrow('mentions down')
    expect(m.query.mock.calls.length).toBeGreaterThan(calls)
  })
})
