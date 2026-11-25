import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserLikedPostIds: vi.fn(),
  getUserBookmarksForPosts: vi.fn(),
  getOwnQuotes: vi.fn(),
  getUserRepostedPostIds: vi.fn(),
  readQuoteCount: vi.fn(),
  readRepostCount: vi.fn(),
}))

vi.mock('./like-service', () => ({ likeService: { getUserLikedPostIds: mocks.getUserLikedPostIds } }))
vi.mock('./bookmark-service', () => ({ bookmarkService: { getUserBookmarksForPosts: mocks.getUserBookmarksForPosts } }))
vi.mock('./post-service', () => ({ postService: { getOwnQuotes: mocks.getOwnQuotes, readQuoteCount: mocks.readQuoteCount } }))
vi.mock('./repost-service', () => ({ repostService: { getUserRepostedPostIds: mocks.getUserRepostedPostIds, readRepostCount: mocks.readRepostCount } }))

describe('fetchBatchUserInteractions', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    mocks.getUserLikedPostIds.mockReset().mockResolvedValue(new Set())
    mocks.getUserBookmarksForPosts.mockReset().mockResolvedValue([])
    mocks.getOwnQuotes.mockReset().mockResolvedValue(new Map())
    mocks.getUserRepostedPostIds.mockReset().mockResolvedValue(new Set())
  })

  it('reads each target\'s marks', async () => {
    mocks.getUserLikedPostIds.mockImplementation(async (_viewer: string, ids: string[]) => new Set(ids.filter((id) => id === 'p1')))
    mocks.getOwnQuotes.mockImplementation(async (_viewer: string, ids: string[]) => new Map(ids.includes('p2') ? [['p2', { id: 'q', bare: true }]] : []))
    const { fetchBatchUserInteractions } = await import('./post-stats-helpers')
    const marks = await fetchBatchUserInteractions([{ id: 'p1', kind: 'post' }, { id: 'p2', kind: 'post' }], 'alice')
    expect(marks.get('p1')).toEqual({ liked: true, reposted: false, bookmarked: false })
    expect(marks.get('p2')).toEqual({ liked: false, reposted: true, bookmarked: false, ownQuote: { id: 'q', bare: true } })
  })

  it('leaves out the targets of a failed read, rather than reading them as unmarked', async () => {
    mocks.getUserLikedPostIds.mockRejectedValue(new Error('quorum'))
    const { fetchBatchUserInteractions } = await import('./post-stats-helpers')
    const marks = await fetchBatchUserInteractions([{ id: 'p1', kind: 'post' }, { id: 'p2', kind: 'post' }], 'alice')
    expect(marks.size).toBe(0)
  })

  it('reads a document type the contract lacks as held by nobody', async () => {
    mocks.getOwnQuotes.mockRejectedValue(new Error('[WASM] document type not found: can not get document type from contract'))
    mocks.getUserLikedPostIds.mockResolvedValue(new Set(['p1']))
    const { fetchBatchUserInteractions } = await import('./post-stats-helpers')
    const marks = await fetchBatchUserInteractions([{ id: 'p1', kind: 'post' }], 'alice')
    expect(marks.get('p1')).toEqual({ liked: true, reposted: false, bookmarked: false })
  })
})

describe('fetchUserMark', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    mocks.getUserLikedPostIds.mockReset().mockResolvedValue(new Set(['p1']))
    mocks.getUserBookmarksForPosts.mockReset().mockRejectedValue(new Error('timeout'))
    mocks.getOwnQuotes.mockReset().mockResolvedValue(new Map([['p1', { id: 'q', bare: true }]]))
    mocks.getUserRepostedPostIds.mockReset().mockResolvedValue(new Set())
  })

  it('reads a like or repost even while the bookmark lookup fails', async () => {
    const { fetchBatchUserInteractions, fetchUserMark } = await import('./post-stats-helpers')
    const target = { id: 'p1', kind: 'post' as const }
    expect((await fetchBatchUserInteractions([target], 'alice')).has('p1')).toBe(false)
    expect(await fetchUserMark(target, 'alice', 'liked')).toEqual({ liked: true })
    expect(await fetchUserMark(target, 'alice', 'reposted')).toEqual({ reposted: true, ownQuote: { id: 'q', bare: true } })
    expect(mocks.getUserBookmarksForPosts).toHaveBeenCalledTimes(1)
  })

  it('rejects when the mark it was asked for cannot be read', async () => {
    const { fetchUserMark } = await import('./post-stats-helpers')
    await expect(fetchUserMark({ id: 'p1', kind: 'post' }, 'alice', 'bookmarked')).rejects.toThrow('timeout')
  })
})

describe('fetchRepostTotal', () => {
  beforeEach(() => {
    mocks.readQuoteCount.mockReset().mockResolvedValue(4)
    mocks.readRepostCount.mockReset().mockResolvedValue(2)
  })

  it('reads quotes on v10, where a repost is a quote', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const { fetchRepostTotal } = await import('./post-stats-helpers')
    expect(await fetchRepostTotal({ id: 'p1', kind: 'post' })).toBe(4)
    expect(mocks.readRepostCount).not.toHaveBeenCalled()
  })

  it('rejects a failed read, so the card keeps its last confirmed total', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    mocks.readQuoteCount.mockRejectedValue(new Error('timeout'))
    const { fetchRepostTotal } = await import('./post-stats-helpers')
    await expect(fetchRepostTotal({ id: 'p1', kind: 'post' })).rejects.toThrow('timeout')
  })
})
