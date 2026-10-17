import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { checkLoginKey } from './login-key'

const PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 200 - i)
const WIF = privateKeyToWif(PRIV, 'testnet')

const key = (
  overrides: { id?: number; purpose?: number; securityLevel?: number; disabledAt?: number; priv?: Uint8Array } = {},
) => ({
  id: overrides.id ?? 1,
  type: KeyType.ECDSA_SECP256K1,
  purpose: overrides.purpose ?? KeyPurpose.AUTHENTICATION,
  securityLevel: overrides.securityLevel ?? SecurityLevel.HIGH,
  data: bytesToBase64(getPublicKey(overrides.priv ?? PRIV)),
  ...(overrides.disabledAt !== undefined ? { disabledAt: overrides.disabledAt } : {}),
})

describe('checkLoginKey', () => {
  it('accepts an enabled HIGH or CRITICAL authentication key', () => {
    expect(checkLoginKey(WIF, [key()], 'testnet')).toMatchObject({ isValid: true, keyId: 1, securityLevelName: 'HIGH' })
    expect(checkLoginKey(WIF, [key({ securityLevel: SecurityLevel.CRITICAL })], 'testnet'))
      .toMatchObject({ isValid: true, securityLevelName: 'CRITICAL' })
  })

  it('refuses a key the identity has disabled (#616)', () => {
    const result = checkLoginKey(WIF, [key({ disabledAt: 1_700_000_000_000 })], 'testnet')
    expect(result).toMatchObject({ isValid: false, errorType: 'DISABLED', keyId: 1 })
  })

  it('signs in with the enabled copy when a disabled key shares the private key', () => {
    const keys = [key({ id: 1, disabledAt: 5 }), key({ id: 2 })]
    expect(checkLoginKey(WIF, keys, 'testnet')).toMatchObject({ isValid: true, keyId: 2 })
  })

  it('names a disabled sign-in key as disabled even when the same key is enabled for another purpose', () => {
    const keys = [key({ id: 1, disabledAt: 5 }), key({ id: 3, purpose: KeyPurpose.ENCRYPTION, securityLevel: SecurityLevel.MEDIUM })]
    expect(checkLoginKey(WIF, keys, 'testnet')).toMatchObject({ isValid: false, errorType: 'DISABLED', keyId: 1 })
  })

  it('names the reason a matched key of the wrong kind is refused', () => {
    expect(checkLoginKey(WIF, [key({ securityLevel: SecurityLevel.MASTER })], 'testnet'))
      .toMatchObject({ isValid: false, errorType: 'WRONG_SECURITY_LEVEL', error: expect.stringContaining('master key') })
    expect(checkLoginKey(WIF, [key({ securityLevel: SecurityLevel.MEDIUM })], 'testnet'))
      .toMatchObject({ isValid: false, errorType: 'WRONG_SECURITY_LEVEL', error: expect.stringContaining('too low') })
    expect(checkLoginKey(WIF, [key({ purpose: KeyPurpose.ENCRYPTION, securityLevel: SecurityLevel.MEDIUM })], 'testnet'))
      .toMatchObject({ isValid: false, errorType: 'WRONG_PURPOSE' })
  })

  it('refuses a key the identity does not have', () => {
    expect(checkLoginKey(WIF, [key({ priv: OTHER })], 'testnet')).toMatchObject({ isValid: false, errorType: 'NO_MATCH' })
  })

  it('refuses a malformed or other-network key', () => {
    expect(checkLoginKey('not-a-key', [key()], 'testnet')).toMatchObject({ isValid: false, errorType: 'INVALID_WIF' })
    expect(checkLoginKey(privateKeyToWif(PRIV, 'mainnet'), [key()], 'testnet'))
      .toMatchObject({ isValid: false, errorType: 'NETWORK_MISMATCH' })
  })
})
