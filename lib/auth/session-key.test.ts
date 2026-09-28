import { describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }))
import { storedKeyBelongsToIdentity } from './session-key'

const A_PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const B_PRIV = Uint8Array.from({ length: 32 }, (_, i) => 200 - i)
const authKey = (priv: Uint8Array, purpose: number = KeyPurpose.AUTHENTICATION) => ({
  id: 1, type: KeyType.ECDSA_SECP256K1, purpose, securityLevel: SecurityLevel.HIGH,
  data: bytesToBase64(getPublicKey(priv)),
})
const A_WIF = privateKeyToWif(A_PRIV, 'testnet')
const bKeys = [authKey(B_PRIV)]

describe('storedKeyBelongsToIdentity (session restore)', () => {
  it("refuses identity B's session when B's key slot holds A's key", async () => {
    const fetchKeys = vi.fn(async () => bKeys)
    expect(await storedKeyBelongsToIdentity(A_WIF, bKeys, fetchKeys, 'testnet')).toBe(false)
    // A mismatch against the saved copy is confirmed against the identity.
    expect(fetchKeys).toHaveBeenCalledOnce()
  })

  it('accepts the identity own key from the saved session without a network read', async () => {
    const fetchKeys = vi.fn(async () => null)
    expect(await storedKeyBelongsToIdentity(A_WIF, [authKey(A_PRIV)], fetchKeys, 'testnet')).toBe(true)
    expect(fetchKeys).not.toHaveBeenCalled()
  })

  it('fetches the identity keys when the session saved none', async () => {
    expect(await storedKeyBelongsToIdentity(A_WIF, [], async () => [authKey(A_PRIV)], 'testnet')).toBe(true)
    expect(await storedKeyBelongsToIdentity(A_WIF, [], async () => bKeys, 'testnet')).toBe(false)
    expect(await storedKeyBelongsToIdentity(A_WIF, [], async () => null, 'testnet')).toBe(false)
  })

  it('does not count a non-authentication key on the identity', async () => {
    const encryptionOnly = [authKey(A_PRIV, KeyPurpose.ENCRYPTION)]
    expect(await storedKeyBelongsToIdentity(A_WIF, encryptionOnly, async () => encryptionOnly, 'testnet')).toBe(false)
  })

  it('keeps the session when the identity cannot be read', async () => {
    expect(await storedKeyBelongsToIdentity(A_WIF, [], async () => { throw new Error('offline') }, 'testnet')).toBe(true)
  })
})
