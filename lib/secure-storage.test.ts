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
