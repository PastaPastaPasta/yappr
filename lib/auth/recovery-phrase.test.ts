import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@/lib/bytes'
import { hash160 } from '@/lib/crypto/hash'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { getPublicKey } from '@/lib/crypto/keys'
import type { Dip13Key } from '@/lib/crypto/dip13'
import { masterKey, messagingKeyCandidates, phraseKeys, phraseMessagingState, recoveryPhraseOffered, sessionKey } from './recovery-phrase'

const ANCHOR = 'AwjuEqZtXwBq5jU9tg8UnRMmXrwb3nozSgGx59ghD1c1'
const OTHER_CONTRACT = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'

/** A deterministic stand-in for the phrase: key index n is the scalar n + 1. */
function keyAt(index: number): Dip13Key {
  const privateKey = new Uint8Array(32)
  privateKey[31] = index + 1
  return { privateKey, publicKey: getPublicKey(privateKey) }
}
const foreign = keyAt(200)

const identityKey = (id: number, purpose: number, securityLevel: number, data: Uint8Array, extra: Record<string, unknown> = {}) =>
  ({ id, type: KeyType.ECDSA_SECP256K1, purpose, securityLevel, data, ...extra })

describe('recoveryPhraseOffered', () => {
  it('is offered on testnet and devnets, not yet on mainnet', () => {
    expect(recoveryPhraseOffered('testnet')).toBe(true)
    expect(recoveryPhraseOffered('devnet')).toBe(true)
    expect(recoveryPhraseOffered('mainnet')).toBe(false)
  })
})

describe('phraseKeys', () => {
  const keys = [
    identityKey(0, KeyPurpose.AUTHENTICATION, SecurityLevel.MASTER, keyAt(0).publicKey),
    identityKey(1, KeyPurpose.AUTHENTICATION, SecurityLevel.CRITICAL, keyAt(1).publicKey),
    identityKey(2, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, keyAt(2).publicKey),
    // A HASH160 key is held through the hash of its point.
    { id: 3, type: KeyType.ECDSA_HASH160, purpose: KeyPurpose.TRANSFER, securityLevel: SecurityLevel.CRITICAL, data: hash160(keyAt(3).publicKey) },
    // Added by someone else: not the phrase's key at index 4.
    identityKey(4, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, foreign.publicKey),
    // The phrase's, but disabled.
    identityKey(5, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, keyAt(5).publicKey, { disabledAt: 1 }),
  ]

  it('keeps the enabled keys the phrase derives at key index = key id', () => {
    expect(phraseKeys(keys, keyAt).map((key) => key.id)).toEqual([0, 1, 2, 3])
  })

  it('picks HIGH to sign the session, CRITICAL without it, never MASTER', () => {
    const held = phraseKeys(keys, keyAt)
    expect(sessionKey(held)?.id).toBe(2)
    expect(sessionKey(held.filter((key) => key.id !== 2))?.id).toBe(1)
    expect(sessionKey(held.filter((key) => key.id === 0))).toBeUndefined()
    expect(masterKey(held)?.id).toBe(0)
  })

  it('wipes the keys it does not keep', () => {
    const derived: Dip13Key[] = []
    phraseKeys([identityKey(4, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, foreign.publicKey)], (index) => {
      const key = keyAt(index)
      derived.push(key)
      return key
    })
    expect(derived[0].privateKey.every((byte) => byte === 0)).toBe(true)
  })
})

describe('phraseMessagingState (#1210 and DIP rules)', () => {
  const mine = keyAt(7).publicKey
  const rotated = keyAt(8).publicKey
  const legacy = keyAt(9).publicKey
  const bound = (contractId: string) => ({ $type: 'singleContract', id: contractId })
  const encryptionKey = (id: number, data: Uint8Array, contractId = ANCHOR, extra: Record<string, unknown> = {}) =>
    ({ id, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.ENCRYPTION, data, contractBounds: bound(contractId), ...extra })
  const state = (...args: Parameters<typeof phraseMessagingState>) => phraseMessagingState(...args)

  it('is current when the anchor\'s current key is the phrase\'s', () => {
    expect(state([mine], mine, [encryptionKey(5, mine)], ANCHOR)).toEqual({ state: 'current', candidate: 0 })
  })

  it('belongs to another wallet when another key is current', () => {
    expect(state([mine], foreign.publicKey, [encryptionKey(5, mine), encryptionKey(6, foreign.publicKey)], ANCHOR))
      .toEqual({ state: 'another-wallet', candidate: null })
  })

  it('is absent when the identity has no anchor key and never had the phrase\'s', () => {
    expect(state([mine], null, [], ANCHOR)).toEqual({ state: 'absent', candidate: null })
    // A key bound to another contract is not the app's.
    expect(state([mine], null, [encryptionKey(5, foreign.publicKey, OTHER_CONTRACT)], ANCHOR)).toEqual({ state: 'absent', candidate: null })
  })

  it('never shadows a live anchor key the current-key read missed', () => {
    expect(state([mine], null, [encryptionKey(5, foreign.publicKey)], ANCHOR)).toEqual({ state: 'another-wallet', candidate: null })
  })

  it('is current when the read lags but the newest live anchor key is the phrase\'s', () => {
    expect(state([mine], null, [encryptionKey(5, foreign.publicKey, ANCHOR, { disabledAt: 1 }), encryptionKey(6, mine)], ANCHOR))
      .toEqual({ state: 'current', candidate: 0 })
    expect(state([mine], null, [encryptionKey(5, mine), encryptionKey(6, foreign.publicKey)], ANCHOR))
      .toEqual({ state: 'another-wallet', candidate: null })
  })

  it('is absent when the phrase\'s point is on the identity only under another purpose or contract', () => {
    expect(state([mine], null, [encryptionKey(5, mine, OTHER_CONTRACT)], ANCHOR).state).toBe('absent')
    expect(state([mine], null, [identityKey(5, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, mine)], ANCHOR).state).toBe('absent')
  })

  it('does not re-add the phrase\'s key once it was disabled', () => {
    expect(state([mine], null, [encryptionKey(5, mine, ANCHOR, { disabledAt: 1 })], ANCHOR).state).toBe('another-wallet')
  })

  it('finds the current key among rotation 0, a later rotation and the pre-DIP key', () => {
    const candidates = [mine, rotated, legacy]
    const keys = [encryptionKey(5, mine, ANCHOR, { disabledAt: 1 }), encryptionKey(6, rotated)]
    expect(state(candidates, rotated, keys, ANCHOR)).toEqual({ state: 'current', candidate: 1 })
    expect(state(candidates, null, keys, ANCHOR)).toEqual({ state: 'current', candidate: 1 })
    expect(state(candidates, legacy, [encryptionKey(5, legacy)], ANCHOR)).toEqual({ state: 'current', candidate: 2 })
  })

  it('belongs to another wallet when a current key matches no candidate, whatever else is on the identity', () => {
    const keys = [encryptionKey(5, mine, ANCHOR, { disabledAt: 1 }), encryptionKey(6, foreign.publicKey)]
    expect(state([mine, legacy], foreign.publicKey, keys, ANCHOR)).toEqual({ state: 'another-wallet', candidate: null })
  })

  it('does not register next to disabled candidates: any one on the identity leaves the slot out', () => {
    expect(state([mine, legacy], null, [encryptionKey(5, legacy, ANCHOR, { disabledAt: 1 })], ANCHOR))
      .toEqual({ state: 'another-wallet', candidate: null })
    expect(state([mine, rotated], null, [encryptionKey(5, mine, ANCHOR, { disabledAt: 1 }), encryptionKey(6, rotated, ANCHOR, { disabledAt: 2 })], ANCHOR).state)
      .toBe('another-wallet')
  })
})

describe('messagingKeyCandidates', () => {
  const bound = { $type: 'singleContract', id: ANCHOR }
  const encryptionKey = (id: number, data: Uint8Array, extra: Record<string, unknown> = {}) =>
    ({ id, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.ENCRYPTION, data, contractBounds: bound, ...extra })
  // Rotation n is the stand-in key n + 20; the pre-DIP key is key 99.
  const rotation = (n: number) => keyAt(20 + n)
  const legacy = () => keyAt(99)
  const publics = (keys: Dip13Key[]) => keys.map((key) => bytesToHex(key.publicKey))
  const expectPublics = (keys: Dip13Key[], expected: Dip13Key[]) => expect(publics(keys)).toEqual(publics(expected))

  it('is rotation 0 and the pre-DIP key when the identity has neither', () => {
    expectPublics(messagingKeyCandidates(rotation, legacy, [], ANCHOR), [rotation(0), legacy()])
  })

  it('walks the rotations while each is on the identity, in any state, and stops at the first that is not', () => {
    const keys = [
      encryptionKey(5, rotation(0).publicKey, { disabledAt: 1 }),
      encryptionKey(6, rotation(1).publicKey, { disabledAt: 2 }),
      encryptionKey(7, rotation(2).publicKey),
      // A gap: rotation 3 is missing, so rotation 4 is never looked at.
      encryptionKey(8, rotation(4).publicKey),
    ]
    expectPublics(messagingKeyCandidates(rotation, legacy, keys, ANCHOR), [rotation(0), rotation(1), rotation(2), legacy()])
  })

  it('does not count a rotation key that is on the identity only under another purpose or contract', () => {
    const keys = [
      encryptionKey(5, rotation(0).publicKey, { contractBounds: { $type: 'singleContract', id: OTHER_CONTRACT } }),
      { id: 6, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.AUTHENTICATION, data: rotation(0).publicKey },
    ]
    expectPublics(messagingKeyCandidates(rotation, null, keys, ANCHOR), [rotation(0)])
  })

  it('leaves the pre-DIP key out when none is asked for, and wipes the key it drops', () => {
    const dropped = rotation(1)
    const derived = (n: number) => (n === 1 ? dropped : rotation(n))
    const keys = [encryptionKey(5, rotation(0).publicKey)]
    expectPublics(messagingKeyCandidates(derived, null, keys, ANCHOR), [rotation(0)])
    expect(dropped.privateKey.every((byte) => byte === 0)).toBe(true)
  })
})
