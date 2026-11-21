/**
 * A fresh identity read skips the minute-long cache and refreshes it: a key
 * rotated on chain is seen at once by the caller that asks for it fresh.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetch, byPublicKeyHash, byNonUniquePublicKeyHash } = vi.hoisted(() => ({
  fetch: vi.fn(), byPublicKeyHash: vi.fn(), byNonUniquePublicKeyHash: vi.fn(),
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ identities: { fetch, byPublicKeyHash, byNonUniquePublicKeyHash } }) }))
vi.mock('./signer-service', () => ({ signerService: {} }))

import { identityService } from './identity-service'

const IDENTITY = '11111111111111111111111111111112'
const identityWithKey = (data: string, disabledAt?: number) => ({
  toJSON: () => ({ id: IDENTITY, balance: 1, revision: 1, publicKeys: [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data, ...(disabledAt ? { disabledAt } : {}) }] }),
})

beforeEach(() => {
  fetch.mockReset()
  byPublicKeyHash.mockReset()
  byNonUniquePublicKeyHash.mockReset().mockRejectedValue(new Error('no proof in result'))
  identityService.clearCache()
})

describe('identityService.getIdentity', () => {
  it('reads past the cache when asked fresh, and caches what it read', async () => {
    fetch.mockResolvedValueOnce(identityWithKey('old'))
    expect((await identityService.getIdentity(IDENTITY))?.publicKeys[0].data).toBe('old')

    // The key is rotated on chain: a cached read still answers the old one.
    fetch.mockResolvedValueOnce(identityWithKey('old', 5))
    expect((await identityService.getIdentity(IDENTITY))?.publicKeys[0].disabledAt).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)

    expect((await identityService.getIdentity(IDENTITY, { fresh: true }))?.publicKeys[0].disabledAt).toBe(5)
    expect(fetch).toHaveBeenCalledTimes(2)
    // The fresh answer replaced the cached one.
    expect((await identityService.getIdentity(IDENTITY))?.publicKeys[0].disabledAt).toBe(5)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('throws on a failed fresh read rather than answer from the cache', async () => {
    fetch.mockResolvedValueOnce(identityWithKey('old'))
    await identityService.getIdentity(IDENTITY)
    fetch.mockRejectedValueOnce(new Error('DAPI unavailable'))
    await expect(identityService.getIdentity(IDENTITY, { fresh: true })).rejects.toThrow('DAPI unavailable')
  })
})

describe('identityService.getIdentityIdByMasterKeyHash', () => {
  const hash = new Uint8Array(20)

  it('answers the identity holding the unique key', async () => {
    byPublicKeyHash.mockResolvedValueOnce({ id: { toBase58: () => IDENTITY } })
    await expect(identityService.getIdentityIdByMasterKeyHash(hash)).resolves.toBe(IDENTITY)
  })

  it('answers none for an unheld key without reading the non-unique index', async () => {
    byPublicKeyHash.mockResolvedValueOnce(undefined)
    await expect(identityService.getIdentityIdByMasterKeyHash(hash)).resolves.toBeNull()
    expect(byNonUniquePublicKeyHash).not.toHaveBeenCalled()
  })

  it('still throws a failed unique read', async () => {
    byPublicKeyHash.mockRejectedValueOnce(new Error('DAPI unavailable'))
    await expect(identityService.getIdentityIdByMasterKeyHash(hash)).rejects.toThrow('DAPI unavailable')
  })
})
