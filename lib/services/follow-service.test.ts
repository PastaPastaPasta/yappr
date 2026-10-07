import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const query = vi.hoisted(() => vi.fn())
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
import { followService } from './follow-service'

beforeEach(() => {
  query.mockReset()
})

describe('connection list read failures', () => {
  for (const method of ['getFollowing', 'getFollowers'] as const) {
    it(`${method} distinguishes a failed read from a successful empty list`, async () => {
      query.mockRejectedValueOnce(new Error('offline'))
      await expect(followService[method]('111111111', { throwOnError: true })).rejects.toThrow('offline')

      query.mockResolvedValueOnce([])
      await expect(followService[method]('111111111', { throwOnError: true })).resolves.toEqual([])
    })

    it(`${method} preserves the legacy fallback for callers that do not opt in`, async () => {
      query.mockRejectedValueOnce(new Error('offline'))
      await expect(followService[method]('111111111')).resolves.toEqual([])
    })
  }
})

describe('complete connection lists', () => {
  /** A valid identifier for `n`. */
  const identity = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? n % 256 : k === 1 ? Math.floor(n / 256) : 1)))
  /** `total` follow documents, paged 100 at a time after `startAfter`. */
  const follows = (total: number) => async ({ limit, startAfter }: { limit: number; startAfter?: string }) => {
    const first = startAfter ? Number(startAfter.slice(1)) + 1 : 0
    return Array.from({ length: Math.max(0, Math.min(limit, total - first)) }, (_, i) => ({
      $id: `f${first + i}`, $ownerId: identity(first + i), $createdAt: first + i, followingId: identity(first + i),
    }))
  }

  it('getFollowingIds reads every follow, past the old 1000-row cap', async () => {
    query.mockImplementation(follows(1234))
    const ids = await followService.getFollowingIds('111111111')
    expect(ids).toHaveLength(1234)
    expect(ids.at(-1)).toBe(identity(1233))
    expect(query).toHaveBeenCalledTimes(13)
  })

  it('getFollowers reads every follower', async () => {
    query.mockImplementation(follows(1050))
    expect(await followService.getFollowers('111111111', { throwOnError: true })).toHaveLength(1050)
  })

  it('getRecentFollowers asks for the newest followers in one query', async () => {
    query.mockResolvedValue([])
    await followService.getRecentFollowers('111111111', 50)
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).toMatchObject({
      where: [['followingId', '==', '111111111'], ['$createdAt', '>', 0]],
      orderBy: [['followingId', 'asc'], ['$createdAt', 'desc']],
      limit: 50,
    })
  })
})
