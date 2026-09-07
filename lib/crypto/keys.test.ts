import { describe, expect, it } from 'vitest'
import { hash160 } from './hash'
import { privateKeyToWif } from './wif'
import { bytesToHex } from '@/lib/bytes'
import {
  KeyPurpose,
  KeyType,
  SecurityLevel,
  findMatchingKeyIndex,
  getPublicKey,
  matchIdentityKey,
  toKeyInfo,
} from './keys'

const AUTH_PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const OTHER_PRIV = Uint8Array.from({ length: 32 }, (_, i) => 200 - i)
const AUTH_PUB = getPublicKey(AUTH_PRIV)
const AUTH_WIF = privateKeyToWif(AUTH_PRIV, 'testnet')

// The two shapes an identity key arrives in: wasm getters (hex data, *Number
// fields) and toJSON()/app types (base64 or bytes, plain field names).
const wasmKey = (keyId: number, purposeNumber: number, securityLevelNumber: number, data: Uint8Array, extra = {}) => ({
  keyId,
  purposeNumber,
  securityLevelNumber,
  keyTypeNumber: KeyType.ECDSA_SECP256K1,
  data: bytesToHex(data),
  ...extra,
})
const jsonKey = (id: number, purpose: number, securityLevel: number, data: Uint8Array, extra = {}) => ({
  id,
  purpose,
  securityLevel,
  type: KeyType.ECDSA_SECP256K1,
  data,
  ...extra,
})

describe('toKeyInfo', () => {
  it('reads the wasm getter shape', () => {
    expect(toKeyInfo(wasmKey(3, KeyPurpose.TRANSFER, SecurityLevel.HIGH, AUTH_PUB))).toEqual({
      id: 3,
      type: KeyType.ECDSA_SECP256K1,
      purpose: KeyPurpose.TRANSFER,
      securityLevel: SecurityLevel.HIGH,
      data: AUTH_PUB,
    })
  })

  it('reads the JSON shape and prefers the wasm fields when both exist', () => {
    expect(toKeyInfo(jsonKey(1, KeyPurpose.AUTHENTICATION, SecurityLevel.CRITICAL, AUTH_PUB))?.id).toBe(1)
    expect(toKeyInfo({ id: 1, keyId: 9, purpose: 0, purposeNumber: 3, data: AUTH_PUB })).toMatchObject({ id: 9, purpose: 3 })
  })

  it('returns null when the key data cannot be decoded', () => {
    expect(toKeyInfo({ id: 1, data: 42 })).toBeNull()
  })
})

describe('findMatchingKeyIndex', () => {
  it('matches a compressed public key and a hash160 key', () => {
    const keys = [
      { id: 0, type: KeyType.ECDSA_HASH160, purpose: 0, securityLevel: 0, data: hash160(getPublicKey(OTHER_PRIV)) },
      { id: 1, type: KeyType.ECDSA_HASH160, purpose: 0, securityLevel: 1, data: hash160(AUTH_PUB) },
      { id: 2, type: KeyType.ECDSA_SECP256K1, purpose: 0, securityLevel: 2, data: AUTH_PUB },
    ]
    expect(findMatchingKeyIndex(AUTH_WIF, keys, 'testnet')?.keyId).toBe(1)
    expect(findMatchingKeyIndex(AUTH_WIF, keys.slice(2), 'testnet')?.keyId).toBe(2)
  })

  it('rejects a WIF for the wrong network or a malformed WIF', () => {
    const keys = [{ id: 2, type: KeyType.ECDSA_SECP256K1, purpose: 0, securityLevel: 2, data: AUTH_PUB }]
    expect(findMatchingKeyIndex(AUTH_WIF, keys, 'mainnet')).toBeNull()
    expect(findMatchingKeyIndex('not-a-wif', keys, 'testnet')).toBeNull()
  })
})

describe('matchIdentityKey', () => {
  const auth = { network: 'testnet' as const, purpose: KeyPurpose.AUTHENTICATION }

  it('returns the original key object for the match', () => {
    const critical = wasmKey(1, KeyPurpose.AUTHENTICATION, SecurityLevel.CRITICAL, AUTH_PUB)
    const result = matchIdentityKey(AUTH_WIF, [wasmKey(0, KeyPurpose.AUTHENTICATION, SecurityLevel.MASTER, getPublicKey(OTHER_PRIV)), critical], {
      ...auth,
      allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
    })
    expect(result).toMatchObject({ ok: true, key: critical, match: { keyId: 1, securityLevel: SecurityLevel.CRITICAL } })
  })

  it('filters by level before matching so a weaker duplicate cannot mask the real key', () => {
    // Same private key registered twice: MEDIUM at a lower id, HIGH at a higher one.
    const keys = [
      wasmKey(2, KeyPurpose.AUTHENTICATION, SecurityLevel.MEDIUM, AUTH_PUB),
      wasmKey(5, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, AUTH_PUB),
    ]
    const result = matchIdentityKey(AUTH_WIF, keys, { ...auth, allowedSecurityLevels: [SecurityLevel.HIGH] })
    expect(result).toMatchObject({ ok: true, match: { keyId: 5 } })
  })

  it('skips disabled keys and keys of another purpose', () => {
    const keys = [
      wasmKey(1, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, AUTH_PUB, { disabledAt: 1700000000n }),
      jsonKey(2, KeyPurpose.TRANSFER, SecurityLevel.HIGH, AUTH_PUB),
    ]
    expect(matchIdentityKey(AUTH_WIF, keys, { ...auth, allowedSecurityLevels: [SecurityLevel.HIGH] })).toEqual({ ok: false, reason: 'no-candidates' })
    expect(matchIdentityKey(AUTH_WIF, keys, { network: 'testnet', purpose: KeyPurpose.TRANSFER, allowedSecurityLevels: [SecurityLevel.HIGH] })).toMatchObject({ ok: true, match: { keyId: 2 } })
  })

  it('distinguishes no candidates from no match', () => {
    const keys = [jsonKey(1, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, getPublicKey(OTHER_PRIV))]
    expect(matchIdentityKey(AUTH_WIF, keys, { ...auth, allowedSecurityLevels: [SecurityLevel.HIGH] })).toEqual({ ok: false, reason: 'no-match' })
  })

  it('enforces a requested key id', () => {
    const keys = [jsonKey(4, KeyPurpose.TRANSFER, SecurityLevel.HIGH, AUTH_PUB)]
    const opts = { network: 'testnet' as const, purpose: KeyPurpose.TRANSFER, allowedSecurityLevels: [SecurityLevel.HIGH] }
    expect(matchIdentityKey(AUTH_WIF, keys, { ...opts, keyId: 4 })).toMatchObject({ ok: true })
    expect(matchIdentityKey(AUTH_WIF, keys, { ...opts, keyId: 9 })).toMatchObject({ ok: false, reason: 'wrong-key-id', match: { keyId: 4 } })
  })
})
