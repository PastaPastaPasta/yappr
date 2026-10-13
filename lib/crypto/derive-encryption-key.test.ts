import { afterEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { deriveEncryptionKey } from './derive-encryption-key'
import { stubAppConnectBuild } from '@/lib/test-storage'

const enc = (text: string) => new TextEncoder().encode(text)
const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const IDENTITY = id(7)
const ANCHOR = id(1)
const OTHER_ANCHOR = id(2)
const LOGIN_KEY = sha256(enc('key-derivation test login key'))

function reference(info: string): Uint8Array {
  return hkdf(sha256, LOGIN_KEY, sha256(enc(IDENTITY)), enc(info), 32)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('deriveEncryptionKey', () => {
  it('derives the legacy unbound key without an anchor', () => {
    expect(deriveEncryptionKey(LOGIN_KEY, IDENTITY, null)).toEqual(reference('yappr/encryption-key/v1'))
  })

  it('derives a separate key per anchor', () => {
    const anchored = deriveEncryptionKey(LOGIN_KEY, IDENTITY, ANCHOR)
    expect(anchored).toEqual(reference(`yappr/app-connect/encryption-key/v1:${ANCHOR}`))
    expect(anchored).not.toEqual(deriveEncryptionKey(LOGIN_KEY, IDENTITY, null))
    expect(anchored).not.toEqual(deriveEncryptionKey(LOGIN_KEY, IDENTITY, OTHER_ANCHOR))
  })

  it('follows the build: legacy builds derive the unbound key', () => {
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', '')
    expect(deriveEncryptionKey(LOGIN_KEY, IDENTITY)).toEqual(deriveEncryptionKey(LOGIN_KEY, IDENTITY, null))
  })

  it('follows the build: App Connect builds derive the anchor key', () => {
    stubAppConnectBuild(ANCHOR, id(3))
    expect(deriveEncryptionKey(LOGIN_KEY, IDENTITY)).toEqual(deriveEncryptionKey(LOGIN_KEY, IDENTITY, ANCHOR))
  })

  it('refuses a key of the wrong length', () => {
    expect(() => deriveEncryptionKey(new Uint8Array(31), IDENTITY, null)).toThrow(/expected 32/)
  })
})
