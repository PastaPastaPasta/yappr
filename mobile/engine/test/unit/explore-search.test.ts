/**
 * People search and mention suggestions with lib's DPNS reads mocked: a
 * failed name read rejects with the host's codes (never an empty list a host
 * would show as "No results"), and a stale quorum is read again once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  findUsernamesByPrefix: vi.fn(),
  findIdentityByName: vi.fn(),
  getSdk: vi.fn(),
}))

vi.mock('@/lib/services/dpns-service', async (load) => ({
  ...await load<object>(),
  dpnsService: { findUsernamesByPrefix: m.findUsernamesByPrefix, findIdentityByName: m.findIdentityByName },
}))
vi.mock('@/lib/services/unified-profile-service', async (load) => ({
  ...await load<object>(),
  unifiedProfileService: { getProfilesByIdentityIds: async () => [] },
}))
vi.mock('@/lib/services/evo-sdk-service', async (load) => {
  const actual = await load<{ evoSdkService: object }>()
  return { ...actual, evoSdkService: { ...actual.evoSdkService, getSdk: m.getSdk } }
})

const { explore } = await import('../../src/api/explore')
const { posts } = await import('../../src/api/posts')
const { retryReadsOnStaleQuorum } = await import('../../src/api/stale-quorum')

const ALICE = 'A1iceA1iceA1iceA1iceA1iceA1iceA1iceA1iceA1ic'
const STALE = 'context provider error: invalid quorum: Quorum not found in cache for hash: 05c491ec'

beforeEach(() => {
  vi.clearAllMocks()
  m.findUsernamesByPrefix.mockResolvedValue([])
  m.findIdentityByName.mockResolvedValue(null)
  m.getSdk.mockResolvedValue({})
})

describe('explore.searchUsers', () => {
  it('finds people by name prefix', async () => {
    m.findUsernamesByPrefix.mockResolvedValue([{ username: 'alice.dash', ownerId: ALICE }])
    const users = await explore.searchUsers('ali')
    expect(users.map(user => [user.id, user.username])).toEqual([[ALICE, 'alice']])
    expect(m.findIdentityByName).not.toHaveBeenCalled()
  })

  it('is empty only when DPNS answered that nothing matches', async () => {
    expect(await explore.searchUsers('zzqx')).toEqual([])
    expect(m.findIdentityByName).toHaveBeenCalledWith('zzqx')
  })

  it.each([
    ['TIMEOUT', new Error('Request timed out after 8000ms')],
    ['NETWORK', new Error('no available addresses to retry')],
    ['RATE_LIMITED', new Error('rate limited')],
  ])('rejects with %s when the prefix search fails', async (code, error) => {
    m.findUsernamesByPrefix.mockRejectedValue(error)
    await expect(explore.searchUsers('ali')).rejects.toMatchObject({ code, message: error.message })
  })

  it('rejects when the exact-name fallback fails', async () => {
    m.findIdentityByName.mockRejectedValue(new Error('deadline exceeded'))
    await expect(explore.searchUsers('alice')).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('reads again on the rebuilt SDK after a stale quorum, as the engine wraps explore', async () => {
    m.findUsernamesByPrefix
      .mockRejectedValueOnce(new Error(STALE))
      .mockResolvedValueOnce([{ username: 'alice.dash', ownerId: ALICE }])
    const users = await retryReadsOnStaleQuorum(explore).searchUsers('ali')
    expect(users.map(user => user.id)).toEqual([ALICE])
    expect(m.getSdk).toHaveBeenCalledTimes(1)
    expect(m.findUsernamesByPrefix).toHaveBeenCalledTimes(2)
  })
})

describe('posts.mentionCandidates', () => {
  it('rejects rather than suggesting no one when the name read fails', async () => {
    m.findUsernamesByPrefix.mockRejectedValue(new Error('Request timed out after 8000ms'))
    await expect(posts.mentionCandidates('@ali')).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(m.findIdentityByName).not.toHaveBeenCalled()
  })
})
