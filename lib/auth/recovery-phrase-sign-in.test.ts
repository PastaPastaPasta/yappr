/**
 * A recovery-phrase session also carries the account's CRITICAL key when the
 * phrase holds it, so token and moderation actions never ask for it
 * (lib/auth/critical-key.ts). Messaging is out of scope here: the build has
 * no messaging anchor, so the session stops before it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import type { Dip13Key, Dip13Wallet } from '@/lib/crypto/dip13'

const identity = vi.hoisted(() => ({ publicKeys: [] as unknown[] }))
vi.mock('@/lib/services/identity-service', () => ({
  identityService: { getIdentity: async () => ({ id: 'Id1', balance: 0, revision: 0, publicKeys: identity.publicKeys }) },
}))
vi.mock('@/lib/services/dpns-service', () => ({ dpnsService: {} }))
vi.mock('@/lib/services/messaging-key-service', () => ({}))
vi.mock('@/lib/crypto/encryption-key-lookup', () => ({}))
vi.mock('@/lib/app-connect/config', () => ({ messagingAnchorId: () => null }))

import { preparePhraseSession } from './recovery-phrase-sign-in'

const derivedAt = (keyIndex: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 17 + keyIndex * 3) % 251 + 1)
const wallet: Dip13Wallet = {
  derive(path: string): Dip13Key {
    const keyIndex = parseInt(path.split('/').at(-1) ?? '', 10)
    const privateKey = derivedAt(keyIndex)
    return { privateKey, publicKey: getPublicKey(privateKey) }
  },
}
const key = (id: number, securityLevel: number, data = getPublicKey(derivedAt(id))) =>
  ({ id, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.AUTHENTICATION, securityLevel, data })
const account = { identityIndex: 0, identityId: 'Id1', username: null }
const wifAt = (keyIndex: number) => privateKeyToWif(derivedAt(keyIndex), 'testnet', true)

beforeEach(() => {
  identity.publicKeys = []
})

describe('preparePhraseSession', () => {
  it('signs in with the HIGH key and carries the CRITICAL key the phrase also holds', async () => {
    identity.publicKeys = [key(0, SecurityLevel.MASTER), key(1, SecurityLevel.CRITICAL), key(2, SecurityLevel.HIGH)]
    const session = await preparePhraseSession(wallet, account)
    expect(session.signInWif).toBe(wifAt(2))
    expect(session.criticalWif).toBe(wifAt(1))
  })

  it('carries none when the account\'s CRITICAL key is not the phrase\'s (the sheet asks later)', async () => {
    const foreign = getPublicKey(Uint8Array.from({ length: 32 }, () => 9))
    identity.publicKeys = [key(1, SecurityLevel.CRITICAL, foreign), key(2, SecurityLevel.HIGH)]
    const session = await preparePhraseSession(wallet, account)
    expect(session.signInWif).toBe(wifAt(2))
    expect(session.criticalWif).toBeNull()
  })

  it('carries none when the CRITICAL key is already the session key', async () => {
    identity.publicKeys = [key(1, SecurityLevel.CRITICAL)]
    const session = await preparePhraseSession(wallet, account)
    expect(session.signInWif).toBe(wifAt(1))
    expect(session.criticalWif).toBeNull()
  })
})
