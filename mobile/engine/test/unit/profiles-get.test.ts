/**
 * `profiles.get` with lib's reads mocked: lib answers a failed DPNS read as
 * "nobody owns the name" or "no names", so the engine reads strictly and
 * rejects instead of showing a profile without its name, or "not found"
 * (QA rc17 D-010).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  findIdentityByName: vi.fn(),
  getAllUsernamesSortedBatch: vi.fn(),
  getProfile: vi.fn(),
  profileExists: vi.fn(),
  getIdentity: vi.fn(),
  getFollowing: vi.fn(),
  viewer: null as string | null,
}))

vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/services/social-stats-service', () => ({ loadUserStats: async () => ({ followers: 0, following: 0, posts: 0 }) }))
vi.mock('@/lib/services/identity-service', async (load) => ({ ...await load<object>(), identityService: { getIdentity: m.getIdentity } }))
vi.mock('@/lib/services/follow-service', async (load) => ({ ...await load<object>(), followService: { getFollowing: m.getFollowing } }))
vi.mock('@/lib/services/block-service', async (load) => ({
  ...await load<object>(),
  blockService: { getBlockProvenance: async () => ({ isBlocked: false, isOwnBlock: false, inheritedFrom: null }) },
}))
vi.mock('@/lib/services/dpns-service', async (load) => ({
  ...await load<object>(),
  dpnsService: { findIdentityByName: m.findIdentityByName, getAllUsernamesSortedBatch: m.getAllUsernamesSortedBatch },
}))
vi.mock('@/lib/services/unified-profile-service', async (load) => ({
  ...await load<object>(),
  unifiedProfileService: { getProfile: m.getProfile, profileExists: m.profileExists, getProfilesByIdentityIds: async () => [] },
}))

const { profiles } = await import('../../src/api/profiles')

const ALICE = 'A1iceA1iceA1iceA1iceA1iceA1iceA1iceA1iceA1ic'
const BOB = 'BobBobBobBobBobBobBobBobBobBobBobBobBobBobBo'

beforeEach(() => {
  vi.clearAllMocks()
  m.findIdentityByName.mockResolvedValue(ALICE)
  m.getAllUsernamesSortedBatch.mockImplementation(async (ids: string[]) => new Map(ids.map(id => [id, ['alice.dash']])))
  m.getProfile.mockResolvedValue(null)
  m.profileExists.mockResolvedValue(false)
  m.getIdentity.mockResolvedValue({ id: ALICE })
  m.getFollowing.mockResolvedValue([])
  m.viewer = null
})

describe('profiles.get', () => {
  it('names an identity without a profile by its DPNS label', async () => {
    const profile = await profiles.get('@alice')
    expect(profile).toMatchObject({ id: ALICE, username: 'alice', displayName: 'alice', hasProfile: false })
  })

  it('rejects when the name read fails, rather than showing the profile without a name', async () => {
    // The batch leaves out an identity whose names it could not read.
    m.getAllUsernamesSortedBatch.mockResolvedValue(new Map())
    await expect(profiles.get(ALICE)).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('rejects when looking up a name fails, and answers null only when DPNS says nobody owns it', async () => {
    m.findIdentityByName.mockRejectedValueOnce(new Error('Request timeout'))
    await expect(profiles.get('alice')).rejects.toMatchObject({ code: 'TIMEOUT' })
    m.findIdentityByName.mockResolvedValueOnce(null)
    expect(await profiles.get('alice')).toBeNull()
  })

  it('rejects when the profile read fails, rather than reporting no profile', async () => {
    m.profileExists.mockRejectedValue(new Error('connection refused'))
    await expect(profiles.get(ALICE)).rejects.toThrow()
  })

  it("rejects when the viewer's follow read fails, rather than offering to follow again", async () => {
    m.viewer = BOB
    m.getFollowing.mockResolvedValueOnce([{ followingId: ALICE }])
    expect(await profiles.get(ALICE)).toMatchObject({ viewer: { follows: true, isSelf: false } })
    expect(m.getFollowing).toHaveBeenLastCalledWith(BOB, { throwOnError: true })
    m.getFollowing.mockRejectedValueOnce(new Error('Request timeout'))
    await expect(profiles.get(ALICE)).rejects.toThrow()
  })
})
