import { keyNetwork } from '@/lib/constants'
import { publicKeyHashFromWif } from '@/lib/crypto/keys'
import { parsePrivateKey, privateKeyToWif, validateWifNetwork, wifToPrivateKey } from '@/lib/crypto/wif'
import { identityService } from '@/lib/services/identity-service'
import { keyValidationService } from '@/lib/services/key-validation-service'
import { RpcError } from '../protocol/envelope'

/**
 * Private-key sign-in, as web's key login form (components/auth/key-login-form.tsx)
 * does it: the identity is found from the key through Platform's
 * public-key-hash index, and the key must be one of that identity's enabled
 * AUTHENTICATION keys at CRITICAL or HIGH. Unlike web, a 64-hex key is
 * accepted too (ADR-001 E5); it is encoded as a WIF for this network, which
 * is what lib stores and signs with.
 *
 * Errors never quote the input.
 */

/** A key the user typed, as the WIF lib stores. Throws KEY_INVALID or KEY_WRONG_NETWORK. */
export function toNetworkWif(input: string): string {
  const network = keyNetwork()
  let parsed: ReturnType<typeof parsePrivateKey>
  try {
    parsed = parsePrivateKey(input)
  } catch {
    throw new RpcError('Invalid private key', 'KEY_INVALID')
  }
  if (parsed.format === 'hex') return privateKeyToWif(parsed.privateKey, network)
  const wif = input.trim()
  if (!validateWifNetwork(wifToPrivateKey(wif).prefix, network)) {
    throw new RpcError('This key is for a different network', 'KEY_WRONG_NETWORK')
  }
  // Re-encoded compressed: Platform keys are compressed points, and so is what lib derives from a WIF.
  return privateKeyToWif(parsed.privateKey, network)
}

/** The identity whose key hashes to `publicKeyHash`, or null (`identities.byPublicKeyHash`, then the non-unique index). */
export function identityForPublicKeyHash(publicKeyHash: Uint8Array): Promise<string | null> {
  return identityService.getIdentityIdByPublicKeyHash(publicKeyHash)
}

export interface VerifiedKey {
  identityId: string
  /** The WIF to store: the input, re-encoded for this network. */
  wif: string
  keyId: number
  securityLevel: number
}

/**
 * Find the identity for a typed key and check the key may sign in for it.
 * Throws KEY_INVALID, KEY_WRONG_NETWORK, IDENTITY_NOT_FOUND ("No identity uses
 * this key") or KEY_NOT_ON_IDENTITY (with lib's reason, e.g. a MASTER key).
 */
export async function verifySignInKey(input: string): Promise<VerifiedKey> {
  const wif = toNetworkWif(input)
  const identityId = await identityForPublicKeyHash(publicKeyHashFromWif(wif))
  if (!identityId) throw new RpcError('No identity uses this key', 'IDENTITY_NOT_FOUND')
  const result = await keyValidationService.validatePrivateKey(wif, identityId, keyNetwork())
  if (!result.isValid || result.keyId === undefined || result.securityLevel === undefined) {
    const code = result.errorType === 'IDENTITY_NOT_FOUND' ? 'IDENTITY_NOT_FOUND' : 'KEY_NOT_ON_IDENTITY'
    throw new RpcError(result.error ?? 'Private key does not match this identity', code)
  }
  return { identityId, wif, keyId: result.keyId, securityLevel: result.securityLevel }
}
