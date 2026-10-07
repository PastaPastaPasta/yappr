import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  queryPostsByOwnersSince: vi.fn(),
  listToDTOs: vi.fn(),
}))
vi.mock('@/lib/services/document-service', async (load) => ({ ...await load<object>(), queryPostsByOwnersSince: m.queryPostsByOwnersSince }))
vi.mock('@/lib/services/follow-service', async (load) => ({
  ...await load<object>(),
  followService: { getFollowingIdsCached: async () => ['followed'] },
}))
vi.mock('@/lib/feed/enrich-posts', () => ({ enrichPostsWithRepostsAndQuotes: async (posts: unknown[]) => posts }))
vi.mock('../../src/dto/hydrate', async (load) => ({
  ...await load<object>(),
  requireViewer: () => 'viewer',
  listToDTOs: m.listToDTOs,
}))

const { feed } = await import('../../src/api/feed')

const doc = (id: string, at: number) => ({ $id: id, $ownerId: 'followed', $createdAt: at, content: id })
const since = new Date(1_000_000)
const startOf = (call: number) => m.queryPostsByOwnersSince.mock.calls[call][1] as number

beforeEach(() => {
  m.queryPostsByOwnersSince.mockReset()
  m.listToDTOs.mockReset().mockImplementation(async (posts: unknown[]) => posts)
})

describe('feed.checkNew (Following) after an incomplete scan', () => {
  it('holds the scan start only once the answer is built', async () => {
    // An incomplete scan whose answer fails to build: the app got nothing, so no boundary is held.
    m.queryPostsByOwnersSince.mockResolvedValue({ posts: [doc('a', 1_000_010)], complete: false })
    m.listToDTOs.mockRejectedValueOnce(new Error('hydration failed'))
    await expect(feed.checkNew({ tab: 'following', since, knownIds: [] })).rejects.toThrow('hydration failed')

    const later = new Date(1_000_010)
    m.queryPostsByOwnersSince.mockResolvedValue({ posts: [], complete: true })
    await feed.checkNew({ tab: 'following', since: later, knownIds: [] })
    expect(startOf(1)).toBe(later.getTime() - 2000)
  })

  it('returns complete, and reads from an incomplete scan\'s start after since moves past it', async () => {
    m.queryPostsByOwnersSince.mockResolvedValue({ posts: [doc('b', 1_000_010)], complete: false })
    const first = await feed.checkNew({ tab: 'following', since, knownIds: [] })
    expect(first.complete).toBe(false)

    m.queryPostsByOwnersSince.mockResolvedValue({ posts: [], complete: true })
    await feed.checkNew({ tab: 'following', since: new Date(1_000_010), knownIds: [] })
    expect(startOf(1)).toBe(since.getTime() - 2000)
  })
})
