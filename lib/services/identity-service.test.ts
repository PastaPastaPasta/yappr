/**
 * A fresh identity read skips the minute-long cache and refreshes it: a key
 * rotated on chain is seen at once by the caller that asks for it fresh.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetch = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const updateLock = vi.hoisted(() => ({ held: Promise.resolve(), refused: false, onRelease: null as (() => void) | null }))
const storage = vi.hoisted(() => {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) } },
    configurable: true,
  })
  return items
})
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ identities: { fetch, update } }) }))
vi.mock('@/lib/identity-write-lock', () => ({
  crossTabLocks: () => (updateLock.refused ? undefined : {}),
  withIdentityUpdateLock: async (_identityId: string, run: () => Promise<unknown>) => {
    if (updateLock.refused) throw new Error('no cross-tab lock')
    await updateLock.held
    try {
      return await run()
    } finally {
      updateLock.onRelease?.()
    }
  },
}))
vi.mock('./signer-service', () => ({ signerService: { createSigner: async () => ({ addKey() {}, free() {}, keyCount: 2 }) } }))
vi.mock('@/lib/retry-utils', () => ({ sleep: async () => {} }))
vi.mock('@dashevo/wasm-sdk', () => ({
  ContractBounds: { SingleContract: () => ({}) },
  IdentityPublicKeyInCreation: class {},
  PrivateKey: { fromHex: () => ({ free() {} }) },
  Identifier: class {},
}))

import { identityService } from './identity-service'
import { getConfiguredNetwork } from '@/lib/constants'
import { getPublicKey } from '@/lib/crypto/keys'

const IDENTITY = '11111111111111111111111111111112'
const identityWithKey = (data: string, disabledAt?: number) => ({
  toJSON: () => ({ id: IDENTITY, balance: 1, revision: 1, publicKeys: [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data, ...(disabledAt ? { disabledAt } : {}) }] }),
})

beforeEach(() => {
  fetch.mockReset()
  update.mockReset()
  storage.clear()
  updateLock.onRelease = null
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
  it('sends nothing where the update lock refuses (no Web Locks), as charter keys do', async () => {
    updateLock.refused = true
    try {
      await expect(identityService.addEncryptionKey(IDENTITY, new Uint8Array(32).fill(1), 'master-wif'))
        .resolves.toEqual({ success: false, error: 'no cross-tab lock' })
    } finally {
      updateLock.refused = false
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

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

  it('publishes the revision a later read proves before releasing the lock when the update\'s answer is lost', async () => {
    const encryptionKey = new Uint8Array(32).fill(1)
    const master = { keyId: 0, purpose: 0, securityLevel: 0, keyType: 0, data: new Uint8Array(33) }
    const before = { revision: 3n, publicKeys: [master], toJSON: () => ({ revision: 3 }) }
    const after = { revision: 4n, publicKeys: [master, { keyId: 1, purpose: 1, securityLevel: 2, keyType: 0, data: getPublicKey(encryptionKey) }] }
    fetch.mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockResolvedValue(after)
    update.mockRejectedValue(new Error('Request timed out'))
    vi.spyOn(identityService, 'validateKeySecurityLevel').mockResolvedValueOnce({ isValid: true, keyId: 0, securityLevel: 0 })
    const revisionKey = `yappr:identity-revision:${getConfiguredNetwork()}:${IDENTITY}`
    let floorAtRelease: string | null = null
    updateLock.onRelease = () => { floorAtRelease = localStorage.getItem(revisionKey) }
    await expect(identityService.addEncryptionKey(IDENTITY, encryptionKey, 'master-wif')).resolves.toEqual({ success: true, keyId: 1 })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(floorAtRelease).toBe('4')
  })

  it('records the revision of a later read that confirms a key every locked read missed', async () => {
    const encryptionKey = new Uint8Array(32).fill(1)
    const master = { keyId: 0, purpose: 0, securityLevel: 0, keyType: 0, data: new Uint8Array(33) }
    const before = { revision: 3n, publicKeys: [master], toJSON: () => ({ revision: 3 }) }
    const after = { revision: 4n, publicKeys: [master, { keyId: 1, purpose: 1, securityLevel: 2, keyType: 0, data: getPublicKey(encryptionKey) }] }
    fetch.mockResolvedValue(before)
    update.mockRejectedValue(new Error('Request timed out'))
    vi.spyOn(identityService, 'validateKeySecurityLevel').mockResolvedValueOnce({ isValid: true, keyId: 0, securityLevel: 0 })
    const revisionKey = `yappr:identity-revision:${getConfiguredNetwork()}:${IDENTITY}`
    await expect(identityService.addEncryptionKey(IDENTITY, encryptionKey, 'master-wif')).resolves.toMatchObject({ success: false })
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(localStorage.getItem(revisionKey)).toBeNull()
    await expect(identityService.recordKeyRevision(IDENTITY, getPublicKey(encryptionKey))).resolves.toBe(false)
    expect(localStorage.getItem(revisionKey)).toBeNull()
    fetch.mockResolvedValue(after)
    await expect(identityService.recordKeyRevision(IDENTITY, getPublicKey(encryptionKey))).resolves.toBe(true)
    expect(localStorage.getItem(revisionKey)).toBe('4')
  })
})

describe('identityService.recordKeyRevision', () => {
  const encryptionKey = new Uint8Array(32).fill(1)
  const withKey = (revision: bigint) => ({
    revision,
    publicKeys: [{ keyId: 1, purpose: 1, securityLevel: 2, keyType: 0, data: getPublicKey(encryptionKey) }],
  })
  const revisionKey = () => `yappr:identity-revision:${getConfiguredNetwork()}:${IDENTITY}`

  it('reads and records only once it holds the update lock', async () => {
    let release!: () => void
    updateLock.held = new Promise<void>((resolve) => { release = resolve })
    fetch.mockResolvedValue(withKey(4n))
    const recorded = identityService.recordKeyRevision(IDENTITY, getPublicKey(encryptionKey))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetch).not.toHaveBeenCalled()
    expect(localStorage.getItem(revisionKey())).toBeNull()
    release()
    await expect(recorded).resolves.toBe(true)
    expect(localStorage.getItem(revisionKey())).toBe('4')
    updateLock.held = Promise.resolve()
  })

  it('never lowers a floor another update recorded meanwhile', async () => {
    localStorage.setItem(revisionKey(), '9')
    fetch.mockResolvedValue(withKey(8n))
    await expect(identityService.recordKeyRevision(IDENTITY, getPublicKey(encryptionKey))).resolves.toBe(true)
    expect(localStorage.getItem(revisionKey())).toBe('9')
  })

  it('records nothing where the update lock is unavailable, but still answers whether the read had the key', async () => {
    updateLock.refused = true
    try {
      fetch.mockResolvedValue(withKey(4n))
      await expect(identityService.recordKeyRevision(IDENTITY, getPublicKey(encryptionKey))).resolves.toBe(true)
    } finally {
      updateLock.refused = false
    }
    expect(localStorage.getItem(revisionKey())).toBeNull()
  })
})
