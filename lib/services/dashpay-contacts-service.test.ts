import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const { query, loadIdentityBatch } = vi.hoisted(() => ({ query: vi.fn(), loadIdentityBatch: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./unified-profile-service', () => ({
  unifiedProfileService: { getDefaultAvatarUrl: (id: string) => `https://example.com/avatar/${id}` },
}))
vi.mock('./identity-batch', () => ({ loadIdentityBatch }))

import { dashPayContactsService } from './dashpay-contacts-service'

let fixtureNumber = 10
let userId = ''
const contactId = bs58.encode(new Uint8Array(32).fill(2))
const outgoing = () => [{ $id: 'outgoing', $ownerId: userId, $createdAt: 1000, toUserId: contactId }]
const incoming = () => [{ $id: 'incoming', $ownerId: contactId, $createdAt: 2000, toUserId: userId }]
const empty = { contacts: [], totalMutualContacts: 0, alreadyFollowedCount: 0 }

beforeEach(() => {
  // Keep the follow service's short-lived result cache isolated between cases.
  userId = bs58.encode(new Uint8Array(32).fill(fixtureNumber++))
  query.mockReset()
  loadIdentityBatch.mockReset().mockResolvedValue({ usernames: new Map(), profiles: [] })
  dashPayContactsService.clearCache()
})

describe('Dash Pay contact read failures and retry', () => {
  for (const method of ['getOutgoingContactRequests', 'getIncomingContactRequests'] as const) {
    it(`${method} propagates a failed query`, async () => {
      query.mockRejectedValueOnce(new Error('offline'))
      await expect(dashPayContactsService[method](userId)).rejects.toThrow('offline')
    })
  }

  it('does not cache a failed outgoing read as empty, and retries immediately', async () => {
    query.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).rejects.toThrow('offline')
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).resolves.toEqual(empty)
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).resolves.toEqual(empty)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed incoming read as no mutual contacts', async () => {
    query.mockResolvedValueOnce(outgoing()).mockRejectedValueOnce(new Error('incoming unavailable'))
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).rejects.toThrow('incoming unavailable')
    query.mockResolvedValueOnce(outgoing()).mockResolvedValueOnce(incoming()).mockResolvedValueOnce([])
    const result = await dashPayContactsService.getUnfollowedContacts(userId)
    expect(result.contacts.map(contact => contact.identityId)).toEqual([contactId])
    expect(result.totalMutualContacts).toBe(1)
    expect(query).toHaveBeenCalledTimes(5)
  })

  it('does not cache a failed follow read as everyone unfollowed', async () => {
    query.mockResolvedValueOnce(outgoing()).mockResolvedValueOnce(incoming()).mockRejectedValueOnce(new Error('follows unavailable'))
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).rejects.toThrow('follows unavailable')
    query.mockResolvedValueOnce(outgoing()).mockResolvedValueOnce(incoming()).mockResolvedValueOnce([])
    const result = await dashPayContactsService.getUnfollowedContacts(userId)
    expect(result.contacts.map(contact => contact.identityId)).toEqual([contactId])
    expect(query).toHaveBeenCalledTimes(6)
  })

  it('caches a successful empty outgoing query without querying incoming or follows', async () => {
    query.mockResolvedValueOnce([])
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).resolves.toEqual(empty)
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).resolves.toEqual(empty)
    expect(query).toHaveBeenCalledTimes(1)
    expect(loadIdentityBatch).not.toHaveBeenCalled()
  })

  it('treats successful empty incoming results as no mutual contacts', async () => {
    query.mockResolvedValueOnce(outgoing()).mockResolvedValueOnce([])
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).resolves.toEqual(empty)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('recognizes mutual contacts already followed on Yappr', async () => {
    query.mockResolvedValueOnce(outgoing()).mockResolvedValueOnce(incoming()).mockResolvedValueOnce([
      { $id: 'follow', $ownerId: userId, $createdAt: 3000, followingId: contactId },
    ])
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).resolves.toEqual({
      contacts: [], totalMutualContacts: 1, alreadyFollowedCount: 1,
    })
    expect(loadIdentityBatch).not.toHaveBeenCalled()
  })

  it('retains contact enrichment, established date and successful result caching', async () => {
    query.mockResolvedValueOnce(outgoing()).mockResolvedValueOnce(incoming()).mockResolvedValueOnce([])
    loadIdentityBatch.mockResolvedValueOnce({
      usernames: new Map([[contactId, 'contact.dash']]),
      profiles: [{ $ownerId: contactId, displayName: 'QA contact' }],
    })
    const result = await dashPayContactsService.getUnfollowedContacts(userId)
    expect(result.contacts).toEqual([expect.objectContaining({
      identityId: contactId, username: 'contact.dash', displayName: 'QA contact',
      contactRequestDate: new Date(2000), isFollowedOnYappr: false,
    })])
    await expect(dashPayContactsService.getUnfollowedContacts(userId)).resolves.toEqual(result)
    expect(query).toHaveBeenCalledTimes(3)
  })
})
