/**
 * A fresh identity read skips the minute-long cache and refreshes it: a key
 * rotated on chain is seen at once by the caller that asks for it fresh.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetch = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const updateLock = vi.hoisted(() => ({ held: Promise.resolve() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ identities: { fetch, update } }) }))
vi.mock('@/lib/identity-write-lock', () => ({
  withIdentityUpdateLock: async (_identityId: string, run: () => Promise<unknown>) => { await updateLock.held; return run() },
  crossTabLocks: () => ({}),
}))
vi.mock('./signer-service', () => ({ signerService: {} }))

import { identityService } from './identity-service'

const IDENTITY = '11111111111111111111111111111112'
const identityWithKey = (data: string, disabledAt?: number) => ({
  toJSON: () => ({ id: IDENTITY, balance: 1, revision: 1, publicKeys: [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data, ...(disabledAt ? { disabledAt } : {}) }] }),
})

beforeEach(() => {
  fetch.mockReset()
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

describe('identityService.addEncryptionKey', () => {
  it('sends nothing for an add cancelled while it waited behind another update', async () => {
    let release!: () => void
    updateLock.held = new Promise<void>((resolve) => { release = resolve })
    let closed = false
    const added = identityService.addEncryptionKey(IDENTITY, new Uint8Array(32).fill(1), 'master-wif', undefined, { cancelled: () => closed })
    await Promise.resolve()
    closed = true
    release()
    await expect(added).resolves.toEqual({ success: false, cancelled: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
