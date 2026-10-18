import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS, type AppConnectGrant, type AppConnectIdentityKey } from 'platform-auth'
import { hash160 } from '@/lib/crypto/hash'
import { getPublicKey } from '@/lib/crypto/keys'
import { BundleFormat } from '@/lib/crypto/passkey-vault'
import {
  checkSignInKey,
  entryNeedsUpdate,
  identityOfUserHandle,
  keyRingBundle,
  passkeyDisplayName,
  passkeyRpId,
  passkeyUserHandle,
  privateKeyMatches,
  rawKeyBundle,
  slotFor,
} from './passkey-vault-policy'

const NOW = 1_800_000_000_000
const H = (label: string) => sha256(new TextEncoder().encode(label))
const HIGH_KEY = H('high key')
const CRITICAL_KEY = H('critical key')

function key(overrides: Partial<AppConnectIdentityKey> & Pick<AppConnectIdentityKey, 'id'>): AppConnectIdentityKey {
  return { type: 0, purpose: 0, securityLevel: 2, data: getPublicKey(HIGH_KEY), ...overrides }
}

describe('passkey vault policy: where passkeys are offered', () => {
  it('offers them on yap.pr (any path) and localhost, never on mirrors', () => {
    expect(passkeyRpId('yap.pr')).toBe('yap.pr')
    expect(passkeyRpId('localhost')).toBe('localhost')
    expect(passkeyRpId('yappr.pages.dev')).toBeNull()
    expect(passkeyRpId('yappr-v2.thepasta.org')).toBeNull()
    expect(passkeyRpId('www.yap.pr')).toBeNull()
    expect(passkeyRpId('127.0.0.1')).toBeNull()
  })

  it('marks devnet and /testing passkeys in the picker, not production or /staging', () => {
    expect(passkeyDisplayName('alice', { network: 'testnet', scope: '' })).toBe('alice')
    expect(passkeyDisplayName('alice', { network: 'testnet', scope: 'staging' })).toBe('alice')
    expect(passkeyDisplayName('alice', { network: 'testnet', scope: 'testing' })).toBe('alice (testing)')
    expect(passkeyDisplayName('alice', { network: 'devnet', scope: 'devnet' })).toBe('alice (devnet)')
  })
})

describe('passkey vault policy: user handle', () => {
  const identity = H('identity')
  const production = H('production vault')
  const testing = H('testing vault')

  it('carries the identity and this deployment\'s vault, and names the identity only for that vault', () => {
    const handle = passkeyUserHandle(identity, production)
    expect(handle).toHaveLength(64)
    expect(identityOfUserHandle(handle, production)).toEqual(identity)
    expect(identityOfUserHandle(handle, testing)).toBeNull()
    expect(identityOfUserHandle(identity, production)).toBeNull()
    expect(identityOfUserHandle(null, production)).toBeNull()
    expect(() => passkeyUserHandle(identity.slice(0, 31), production)).toThrow()
  })
})

describe('passkey vault policy: keys', () => {
  it('matches a private key to a full point or its hash160', () => {
    expect(privateKeyMatches(HIGH_KEY, { type: 0, data: getPublicKey(HIGH_KEY) })).toBe(true)
    expect(privateKeyMatches(HIGH_KEY, { type: 2, data: hash160(getPublicKey(HIGH_KEY)) })).toBe(true)
    expect(privateKeyMatches(HIGH_KEY, { type: 0, data: getPublicKey(CRITICAL_KEY) })).toBe(false)
    expect(privateKeyMatches(new Uint8Array(32), { type: 0, data: getPublicKey(HIGH_KEY) })).toBe(false)
  })

  it('accepts an enabled HIGH sign-in key, and a CRITICAL one only with a moderator check when unbound', () => {
    const keys = [key({ id: 2 }), key({ id: 1, securityLevel: 1, data: getPublicKey(CRITICAL_KEY) })]
    expect(checkSignInKey(slotFor(keys[0], HIGH_KEY), keys, NOW)).toMatchObject({ ok: true, needsModerator: false })
    expect(checkSignInKey(slotFor(keys[1], CRITICAL_KEY), keys, NOW)).toMatchObject({ ok: true, needsModerator: true })
    const bound = key({ id: 3, securityLevel: 1, data: getPublicKey(CRITICAL_KEY), bounds: { kind: 'contractGroup', groupId: 'g' } })
    expect(checkSignInKey(slotFor(bound, CRITICAL_KEY), [bound], NOW)).toMatchObject({ ok: true, needsModerator: false })
    // Only a group bound exempts a CRITICAL key: one bound to a single contract still needs the moderator check.
    const single = { ...bound, bounds: { kind: 'singleContract' as const, contractId: 'c' } }
    expect(checkSignInKey(slotFor(single, CRITICAL_KEY), [single], NOW)).toMatchObject({ ok: true, needsModerator: true })
  })

  it('refuses a disabled, expiring, mislabelled, wrong-level or mismatched sign-in key', () => {
    const high = key({ id: 2 })
    const slot = slotFor(high, HIGH_KEY)
    expect(checkSignInKey(slot, [{ ...high, disabledAt: NOW - 1 }], NOW).ok).toBe(false)
    expect(checkSignInKey(slot, [{ ...high, expiresAt: NOW + APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS }], NOW).ok).toBe(false)
    expect(checkSignInKey(slot, [{ ...high, securityLevel: 3 }], NOW).ok).toBe(false)
    expect(checkSignInKey(slot, [{ ...high, purpose: 1 }], NOW).ok).toBe(false)
    expect(checkSignInKey(slot, [{ ...high, securityLevel: 0 }], NOW).ok).toBe(false)
    expect(checkSignInKey({ ...slot, securityLevel: 1 }, [high], NOW).ok).toBe(false)
    expect(checkSignInKey({ ...slot, privateKey: CRITICAL_KEY }, [high], NOW).ok).toBe(false)
    expect(checkSignInKey(slot, [], NOW).ok).toBe(false)
  })

  it('asks for an update only when the sealed sign-in key stopped working', () => {
    const keys = [key({ id: 2 }), key({ id: 5, expiresAt: NOW + 60 * 60_000 }), key({ id: 6, expiresAt: NOW + 60_000 }), key({ id: 7, disabledAt: NOW - 1 })]
    expect(entryNeedsUpdate(2, keys, NOW)).toBe(false)
    expect(entryNeedsUpdate(5, keys, NOW)).toBe(false)
    expect(entryNeedsUpdate(6, keys, NOW)).toBe(true)
    expect(entryNeedsUpdate(7, keys, NOW)).toBe(true)
    expect(entryNeedsUpdate(9, keys, NOW)).toBe(true)
  })

  it('counts a wallet key with a spent budget as needing an update, but not one whose budget is unknown', () => {
    const keys = [key({ id: 5, totalBudget: 1_000n }), key({ id: 2 })]
    expect(entryNeedsUpdate(5, keys, NOW, new Map([[5, 0n]]))).toBe(true)
    expect(entryNeedsUpdate(5, keys, NOW, new Map([[5, 10n]]))).toBe(false)
    expect(entryNeedsUpdate(5, keys, NOW, new Map())).toBe(false)
    // A budget reported for an unbudgeted key changes nothing.
    expect(entryNeedsUpdate(2, keys, NOW, new Map([[2, 0n]]))).toBe(false)
  })
})

describe('passkey vault policy: bundles', () => {
  it('puts the sign-in key first in a raw-key bundle', () => {
    const signIn = slotFor(key({ id: 2 }), HIGH_KEY)
    const messaging = slotFor(key({ id: 4, purpose: 1, securityLevel: 3 }), H('messaging'))
    expect(rawKeyBundle(signIn, messaging)).toEqual({ format: BundleFormat.RAW_KEY, keys: [signIn, messaging] })
    expect(rawKeyBundle(signIn, null).keys).toEqual([signIn])
  })

  it('puts the group key first in a key-ring bundle and copies every private key', () => {
    const grant: AppConnectGrant = {
      identityId: 'owner',
      authKeys: [
        { role: 'documentType', bindingIndex: 1, privateKey: H('profile'), key: key({ id: 8, type: 2 }) },
        { role: 'contractGroup', bindingIndex: 0, privateKey: H('group'), key: key({ id: 7, securityLevel: 1 }) },
      ],
      encryptionKeys: [{ role: 'encryption', bindingIndex: 0, privateKey: H('anchor'), key: key({ id: 9, purpose: 1, securityLevel: 3 }) }],
    }
    const bundle = keyRingBundle(grant)
    expect(bundle.format).toBe(BundleFormat.KEY_RING)
    expect(bundle.keys.map((slot) => [slot.keyId, slot.purpose, slot.securityLevel, slot.keyType])).toEqual([[7, 0, 1, 0], [8, 0, 2, 2], [9, 1, 3, 0]])
    bundle.keys[0].privateKey.fill(0)
    expect(grant.authKeys[1].privateKey).toEqual(H('group'))
    expect(() => keyRingBundle({ ...grant, authKeys: [grant.authKeys[0]] })).toThrow(/no group key/)
  })
})
