import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import { sha256 } from '@noble/hashes/sha2.js'
import { getPublicKey } from './crypto/keys'
import { privateKeyToWif } from './crypto/wif'
import { stubAppConnectBuild, stubBrowserStorage } from './test-storage'

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const IDENTITY = id(7)
const ANCHOR = id(1)
const keyOf = (label: string) => sha256(new TextEncoder().encode(label))
const LOGIN_WIF = privateKeyToWif(keyOf('login'), 'testnet', true)
const STORED = keyOf('stored encryption key')
const STORED_WIF = privateKeyToWif(STORED, 'testnet', true)

async function load() {
  vi.resetModules()
  const storage = await import('./secure-storage')
  const mark = await import('./app-connect/anchor-key-mark')
  return { ...storage, ...mark }
}

beforeEach(() => {
  stubBrowserStorage()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('stored encryption key', () => {
  it('counts as is on legacy builds', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    s.storeEncryptionKey(IDENTITY, STORED_WIF)
    expect(s.hasEncryptionKey(IDENTITY)).toBe(true)
    expect(s.getEncryptionKeyBytes(IDENTITY)).toEqual(STORED)
  })

  it('on App Connect builds counts only once confirmed as the anchor key', async () => {
    stubAppConnectBuild(ANCHOR, id(3))
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    s.storeEncryptionKey(IDENTITY, STORED_WIF)
    // A key left by a legacy build, or restored unchecked: ignored, not deleted.
    expect(s.hasEncryptionKey(IDENTITY)).toBe(false)
    expect(s.getEncryptionKey(IDENTITY)).toBeNull()

    s.rememberAnchorKey(IDENTITY, getPublicKey(keyOf('some other key')))
    expect(s.hasEncryptionKey(IDENTITY)).toBe(false)

    s.rememberAnchorKey(IDENTITY, getPublicKey(STORED))
    expect(s.hasEncryptionKey(IDENTITY)).toBe(true)
    expect(s.getEncryptionKeyBytes(IDENTITY)).toEqual(STORED)
  })

  it('on App Connect builds never counts without a raw login key', async () => {
    stubAppConnectBuild(ANCHOR, id(3))
    const s = await load()
    s.storeEncryptionKey(IDENTITY, STORED_WIF)
    s.rememberAnchorKey(IDENTITY, getPublicKey(STORED))
    expect(s.hasEncryptionKey(IDENTITY)).toBe(false)
  })
})

describe('a passkey\'s CRITICAL key', () => {
  const CRITICAL_WIF = privateKeyToWif(keyOf('passkey CRITICAL key'), 'testnet', true)
  const TYPED_WIF = privateKeyToWif(keyOf('typed CRITICAL key'), 'testnet', true)

  it('is stored as one tagged record: the key reads back as is, and it is known to come from a passkey', async () => {
    const s = await load()
    s.expectPasskeyCriticalKey(IDENTITY, CRITICAL_WIF)
    s.storeSessionOnlyPrivateKey(IDENTITY, CRITICAL_WIF)
    s.settlePasskeyCriticalKey(IDENTITY)
    expect(s.getPrivateKey(IDENTITY)).toBe(CRITICAL_WIF)
    expect(s.getPrivateKeyRecord(IDENTITY)).toEqual({ wif: CRITICAL_WIF, fromPasskey: true })
    // A reload of the tab keeps the record, and its provenance with it.
    const reloaded = await load()
    expect(reloaded.getPrivateKeyRecord(IDENTITY)).toEqual({ wif: CRITICAL_WIF, fromPasskey: true })
  })

  it('tags only the exact key the commit expected', async () => {
    const s = await load()
    s.expectPasskeyCriticalKey(IDENTITY, CRITICAL_WIF)
    s.storeSessionOnlyPrivateKey(IDENTITY, TYPED_WIF)
    expect(s.getPrivateKeyRecord(IDENTITY)?.fromPasskey).toBe(false)
    // The expectation was spent by that store: a later store of the passkey key is not tagged either.
    s.storeSessionOnlyPrivateKey(IDENTITY, CRITICAL_WIF)
    expect(s.getPrivateKeyRecord(IDENTITY)?.fromPasskey).toBe(false)
  })

  it('never leaves an untagged record of the same key in charge when the tagged one cannot be written', async () => {
    const s = await load()
    // A typed CRITICAL-key sign-in left the key untagged in this tab.
    s.storeSessionOnlyPrivateKey(IDENTITY, CRITICAL_WIF)
    // The longer tagged record does not fit.
    const setItem = sessionStorage.setItem.bind(sessionStorage)
    sessionStorage.setItem = (key: string, value: string) => {
      if (value.startsWith('passkey:')) throw new Error('QuotaExceededError')
      setItem(key, value)
    }
    s.expectPasskeyCriticalKey(IDENTITY, CRITICAL_WIF)
    s.storeSessionOnlyPrivateKey(IDENTITY, CRITICAL_WIF)
    expect(s.getPrivateKeyRecord(IDENTITY)).toEqual({ wif: CRITICAL_WIF, fromPasskey: true })
    // A reload does not bring the untagged record back: the key is simply gone.
    const reloaded = await load()
    expect(reloaded.getPrivateKeyRecord(IDENTITY)).toBeNull()
  })

  it('fails the store when the old record can be neither replaced nor removed', async () => {
    const s = await load()
    s.storeSessionOnlyPrivateKey(IDENTITY, CRITICAL_WIF)
    sessionStorage.setItem = () => { throw new Error('QuotaExceededError') }
    sessionStorage.removeItem = () => { throw new Error('SecurityError') }
    s.expectPasskeyCriticalKey(IDENTITY, CRITICAL_WIF)
    expect(() => s.storeSessionOnlyPrivateKey(IDENTITY, CRITICAL_WIF)).toThrow()
  })

  it('does not hold back a persisted key that took over, and comes back with its tag if that one goes', async () => {
    const s = await load()
    s.expectPasskeyCriticalKey(IDENTITY, CRITICAL_WIF)
    s.storeSessionOnlyPrivateKey(IDENTITY, CRITICAL_WIF)
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    // The key and its provenance come from the same record: the persisted key, unrestricted.
    expect(s.getPrivateKeyRecord(IDENTITY)).toEqual({ wif: LOGIN_WIF, fromPasskey: false })
    // Another tab signs out and removes the shared persisted key: the passkey key is still restricted.
    localStorage.clear()
    expect(s.getPrivateKeyRecord(IDENTITY)).toEqual({ wif: CRITICAL_WIF, fromPasskey: true })
  })
})

describe('remote sign-out secrets', () => {
  it('erases a tab-only key while preserving a newer shared key', async () => {
    const s = await load()
    s.storeSessionOnlyPrivateKey(IDENTITY, STORED_WIF)
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    s.clearTabSecrets(IDENTITY)
    expect(s.getPrivateKey(IDENTITY)).toBe(LOGIN_WIF)
    localStorage.clear()
    expect(s.getPrivateKey(IDENTITY)).toBeNull()
  })
  it('erases a persisted key from storage that is full but still deletable', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    localStorage.setItem = () => { throw new Error('QuotaExceededError') }
    sessionStorage.setItem = () => { throw new Error('QuotaExceededError') }
    expect(s.clearPrivateKey(IDENTITY)).toEqual({ existed: true, complete: true })
    expect(s.getPrivateKey(IDENTITY)).toBeNull()
    expect(localStorage.length).toBe(0)
  })
  it('says when a persisted key outlived the removal', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    localStorage.removeItem = () => { throw new Error('SecurityError') }
    expect(s.clearPrivateKey(IDENTITY)).toEqual({ existed: true, complete: false })
  })
  it('fails a tab-only sign-in, holding nothing, when the persisted key it replaces cannot be removed', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    localStorage.removeItem = () => { throw new Error('SecurityError') }
    expect(() => s.storeSessionOnlyPrivateKey(IDENTITY, STORED_WIF)).toThrow()
    // The persisted key is still what signs; the typed one is not left behind in this tab.
    expect(s.getPrivateKey(IDENTITY)).toBe(LOGIN_WIF)
    expect(sessionStorage.length).toBe(0)
  })
  it('fails a store the browser cannot keep', async () => {
    const s = await load()
    localStorage.setItem = () => { throw new Error('QuotaExceededError') }
    expect(() => s.storePrivateKey(IDENTITY, LOGIN_WIF)).toThrow()
    expect(() => s.storeEncryptionKey(IDENTITY, STORED_WIF)).toThrow()
    expect(s.getPrivateKey(IDENTITY)).toBeNull()
  })
  it('erases the memory fallback when session storage is unavailable', async () => {
    const s = await load()
    sessionStorage.setItem = () => { throw new Error('Storage blocked') }
    s.storeSessionOnlyPrivateKey(IDENTITY, STORED_WIF)
    expect(s.getPrivateKey(IDENTITY)).toBe(STORED_WIF)
    s.clearTabSecrets(IDENTITY)
    expect(s.getPrivateKey(IDENTITY)).toBeNull()
  })
})
