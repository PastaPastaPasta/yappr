import { describe, expect, it } from 'vitest'
import { hash160 } from '@/lib/crypto/hash'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { getPublicKey } from '@/lib/crypto/keys'
import type { Dip13Key } from '@/lib/crypto/dip13'
import { masterKey, phraseKeys, phraseMessagingState, recoveryPhraseOffered, sessionKey } from './recovery-phrase'

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

describe('phraseMessagingState (#1210 rules)', () => {
  const mine = keyAt(7).publicKey
  const bound = (contractId: string) => ({ $type: 'singleContract', id: contractId })
  const encryptionKey = (id: number, data: Uint8Array, contractId = ANCHOR, extra: Record<string, unknown> = {}) =>
    ({ id, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.ENCRYPTION, data, contractBounds: bound(contractId), ...extra })

  it('is current when the anchor\'s current key is the phrase\'s', () => {
    expect(phraseMessagingState(mine, mine, [encryptionKey(5, mine)], ANCHOR)).toBe('current')
  })

  it('belongs to another wallet when another key is current', () => {
    expect(phraseMessagingState(mine, foreign.publicKey, [encryptionKey(5, mine), encryptionKey(6, foreign.publicKey)], ANCHOR)).toBe('another-wallet')
  })

  it('is absent when the identity has no anchor key and never had the phrase\'s', () => {
    expect(phraseMessagingState(mine, null, [], ANCHOR)).toBe('absent')
    // A key bound to another contract is not the app's.
    expect(phraseMessagingState(mine, null, [encryptionKey(5, foreign.publicKey, OTHER_CONTRACT)], ANCHOR)).toBe('absent')
  })

  it('never shadows a live anchor key the current-key read missed', () => {
    expect(phraseMessagingState(mine, null, [encryptionKey(5, foreign.publicKey)], ANCHOR)).toBe('another-wallet')
  })

  it('is current when the read lags but the newest live anchor key is the phrase\'s', () => {
    expect(phraseMessagingState(mine, null, [encryptionKey(5, foreign.publicKey, ANCHOR, { disabledAt: 1 }), encryptionKey(6, mine)], ANCHOR)).toBe('current')
    expect(phraseMessagingState(mine, null, [encryptionKey(5, mine), encryptionKey(6, foreign.publicKey)], ANCHOR)).toBe('another-wallet')
  })

  it('is absent when the phrase\'s point is on the identity only under another purpose or contract', () => {
    expect(phraseMessagingState(mine, null, [encryptionKey(5, mine, OTHER_CONTRACT)], ANCHOR)).toBe('absent')
    expect(phraseMessagingState(mine, null, [identityKey(5, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, mine)], ANCHOR)).toBe('absent')
  })

  it('does not re-add the phrase\'s key once it was disabled', () => {
    expect(phraseMessagingState(mine, null, [encryptionKey(5, mine, ANCHOR, { disabledAt: 1 })], ANCHOR)).toBe('another-wallet')
  })
})
