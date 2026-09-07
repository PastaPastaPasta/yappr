import { describe, expect, it } from 'vitest'
import { hash160 } from './hash'
import { privateKeyToWif } from './wif'
import { bytesToBase64, bytesToHex } from '@/lib/bytes'
import { findMatchingKeyIndex, getPublicKey, matchIdentityKey, toKeyInfo } from './keys'
import { KeyPurpose, KeyType, SecurityLevel, getPurposeName, resolveKeyPurpose, resolveSecurityLevel } from './identity-keys'

const AUTH_PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const OTHER_PRIV = Uint8Array.from({ length: 32 }, (_, i) => 200 - i)
const AUTH_PUB = getPublicKey(AUTH_PRIV)
const AUTH_WIF = privateKeyToWif(AUTH_PRIV, 'testnet')

// The two shapes an identity key arrives in. The wasm getter object carries
// both the enum NAME and the *Number field, with hex data; identity.toJSON()
// and the app's own IdentityPublicKey carry numeric enums with base64 data.
const wasmKey = (keyId: number, purposeNumber: number, securityLevelNumber: number, data: Uint8Array, extra = {}) => ({
  keyId,
  purpose: getPurposeName(purposeNumber).toLowerCase(),
  purposeNumber,
  securityLevel: ['master', 'critical', 'high', 'medium'][securityLevelNumber],
  securityLevelNumber,
  keyType: 'ecdsa_secp256k1',
  keyTypeNumber: KeyType.ECDSA_SECP256K1,
  data: bytesToHex(data),
  ...extra,
})
const jsonKey = (id: number, purpose: number, securityLevel: number, data: Uint8Array, extra = {}) => ({
  id,
  purpose,
  securityLevel,
  type: KeyType.ECDSA_SECP256K1,
  data: bytesToBase64(data),
  ...extra,
})

describe('enum resolution', () => {
  it('accepts numbers, numeric strings, bigints and lowercase names', () => {
    expect(resolveKeyPurpose(3)).toBe(KeyPurpose.TRANSFER)
    expect(resolveKeyPurpose('3')).toBe(KeyPurpose.TRANSFER)
    expect(resolveKeyPurpose(3n)).toBe(KeyPurpose.TRANSFER)
    expect(resolveKeyPurpose('transfer')).toBe(KeyPurpose.TRANSFER)
    expect(resolveKeyPurpose('OWNER')).toBe(KeyPurpose.OWNER)
    expect(resolveSecurityLevel('critical')).toBe(SecurityLevel.CRITICAL)
  })

  it('returns null rather than a default for unknown values', () => {
    expect(resolveKeyPurpose(undefined)).toBeNull()
    expect(resolveKeyPurpose('')).toBeNull()
    expect(resolveKeyPurpose('nonsense')).toBeNull()
    expect(resolveSecurityLevel(NaN)).toBeNull()
  })
})

describe('toKeyInfo', () => {
  it('reads the wasm getter shape, preferring the numeric fields', () => {
    expect(toKeyInfo(wasmKey(3, KeyPurpose.TRANSFER, SecurityLevel.HIGH, AUTH_PUB))).toEqual({
      id: 3,
      type: KeyType.ECDSA_SECP256K1,
      purpose: KeyPurpose.TRANSFER,
      securityLevel: SecurityLevel.HIGH,
      data: AUTH_PUB,
    })
  })

  it('reads the JSON shape with base64 data', () => {
    expect(toKeyInfo(jsonKey(1, KeyPurpose.AUTHENTICATION, SecurityLevel.CRITICAL, AUTH_PUB))).toEqual({
      id: 1,
      type: KeyType.ECDSA_SECP256K1,
      purpose: KeyPurpose.AUTHENTICATION,
      securityLevel: SecurityLevel.CRITICAL,
      data: AUTH_PUB,
    })
  })

  it('resolves enum names when only the name is present', () => {
    expect(toKeyInfo({ keyId: 2, purpose: 'transfer', securityLevel: 'high', keyType: 'ecdsa_hash160', data: hash160(AUTH_PUB) })).toMatchObject({
      purpose: KeyPurpose.TRANSFER,
      securityLevel: SecurityLevel.HIGH,
      type: KeyType.ECDSA_HASH160,
    })
  })

  it('returns null when the data or any enum cannot be resolved', () => {
    expect(toKeyInfo({ id: 1, purpose: 0, securityLevel: 2, type: 0, data: 'not base64!' })).toBeNull()
    expect(toKeyInfo({ id: 1, securityLevel: 2, type: 0, data: AUTH_PUB })).toBeNull()
    expect(toKeyInfo({ id: 1, purpose: 'mystery', securityLevel: 2, type: 0, data: AUTH_PUB })).toBeNull()
    expect(toKeyInfo({ purpose: 0, securityLevel: 2, type: 0, data: AUTH_PUB })).toBeNull()
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
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.key).toBe(critical)
      expect(result.match).toMatchObject({ keyId: 1, securityLevel: SecurityLevel.CRITICAL })
    }
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
    expect(matchIdentityKey(AUTH_WIF, keys, { ...auth, allowedSecurityLevels: [SecurityLevel.HIGH] })).toMatchObject({ ok: false, reason: 'rejected', match: { keyId: 2 } })
    expect(matchIdentityKey(AUTH_WIF, keys, { network: 'testnet', purpose: KeyPurpose.TRANSFER })).toMatchObject({ ok: true, match: { keyId: 2 } })
  })

  it('names the key the WIF does match when it is turned down', () => {
    const master = jsonKey(0, KeyPurpose.AUTHENTICATION, SecurityLevel.MASTER, AUTH_PUB)
    const result = matchIdentityKey(AUTH_WIF, [master], { ...auth, allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH] })
    expect(result).toEqual({ ok: false, reason: 'rejected', match: expect.objectContaining({ keyId: 0, securityLevel: SecurityLevel.MASTER }) })
  })

  it('distinguishes a rejected key from no key at all', () => {
    const keys = [jsonKey(1, KeyPurpose.AUTHENTICATION, SecurityLevel.HIGH, getPublicKey(OTHER_PRIV))]
    expect(matchIdentityKey(AUTH_WIF, keys, { ...auth, allowedSecurityLevels: [SecurityLevel.HIGH] })).toEqual({ ok: false, reason: 'no-match' })
  })

  it('enforces a requested key id', () => {
    const keys = [jsonKey(4, KeyPurpose.TRANSFER, SecurityLevel.HIGH, AUTH_PUB)]
    const opts = { network: 'testnet' as const, purpose: KeyPurpose.TRANSFER }
    expect(matchIdentityKey(AUTH_WIF, keys, { ...opts, keyId: 4 })).toMatchObject({ ok: true })
    expect(matchIdentityKey(AUTH_WIF, keys, { ...opts, keyId: 9 })).toMatchObject({ ok: false, reason: 'wrong-key-id', match: { keyId: 4 } })
  })
})
