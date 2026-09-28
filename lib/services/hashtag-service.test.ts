import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ranked } = vi.hoisted(() => ({ ranked: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { ranked } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))
vi.mock('../contract-topology', async (importOriginal) => ({
  ...await importOriginal<typeof import('../contract-topology')>(),
  prefixRankingsAvailable: () => true,
  windowedRankingsAvailable: () => true,
}))

beforeEach(() => {
  // A new module gives each test its own trending cache.
  vi.resetModules()
  ranked.mockReset()
})

describe('trending hashtags', () => {
  it('does not cache a failed ranked read as "no trending tags"', async () => {
    const { hashtagService } = await import('./hashtag-service')
    ranked.mockRejectedValueOnce(new Error('Quorum not found'))
    expect(await hashtagService.getTrendingHashtags()).toEqual([])

    ranked.mockResolvedValueOnce({ entries: [{ groupValue: 'dash', value: BigInt(7) }] })
    expect(await hashtagService.getTrendingHashtags()).toEqual([{ hashtag: 'dash', postCount: 7 }])
    expect(ranked).toHaveBeenCalledTimes(2)
  })

  it('caches a genuine ranking for the window', async () => {
    const { hashtagService } = await import('./hashtag-service')
    ranked.mockResolvedValue({ entries: [{ groupValue: 'dash', value: BigInt(7) }] })
    await hashtagService.getTrendingHashtags()
    expect(await hashtagService.getTrendingHashtags()).toEqual([{ hashtag: 'dash', postCount: 7 }])
    expect(ranked).toHaveBeenCalledTimes(1)
  })
})
