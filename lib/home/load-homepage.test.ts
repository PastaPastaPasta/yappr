import { beforeEach, describe, expect, it, vi } from 'vitest'

const { postService } = vi.hoisted(() => ({
  postService: {
    countAllPosts: vi.fn(),
    getTopPostsByLikes: vi.fn(),
    getAuthorPostCounts: vi.fn(),
    countPostsSince: vi.fn(),
  },
}))
vi.mock('@/lib/contract-topology', async (original) => ({ ...(await original<object>()), likesAreIndexOnly: () => false }))
vi.mock('@/lib/services/post-service', () => ({ postService }))
vi.mock('@/lib/services/dpns-service', () => ({ dpnsService: { resolveUsernamesBatch: async () => new Map() } }))
vi.mock('@/lib/services/unified-profile-service', () => ({ unifiedProfileService: { getProfilesByIdentityIds: async () => [] } }))
vi.mock('@/lib/services/evo-sdk-service', () => ({ getEvoSdk: async () => ({}) }))
vi.mock('@/lib/services/ranked-likes', () => ({ topLikedPosts: vi.fn() }))
vi.mock('@/lib/feed/composite-feed-page', () => ({ loadCompositeFeedPage: vi.fn(), usernamesByIdentity: vi.fn() }))

import { loadHomepage } from './load-homepage'

beforeEach(() => {
  postService.countAllPosts.mockResolvedValue(10)
  postService.getTopPostsByLikes.mockResolvedValue([])
  postService.countPostsSince.mockResolvedValue(1)
})

describe('people-posting stat', () => {
  it('is exact when every author was counted', async () => {
    postService.getAuthorPostCounts.mockResolvedValue({ counts: new Map([['a', 2], ['b', 1]]), truncated: false })
    expect(await loadHomepage()).toMatchObject({ authorCount: 2, authorCountCapped: false })
  })

  it('is a floor ("N+") when the scan stopped short of the whole timeline', async () => {
    postService.getAuthorPostCounts.mockResolvedValue({ counts: new Map([['a', 2], ['b', 1]]), truncated: true })
    expect(await loadHomepage()).toMatchObject({ authorCount: 2, authorCountCapped: true })
  })
})
