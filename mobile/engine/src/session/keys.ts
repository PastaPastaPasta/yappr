import { keyNetwork } from '@/lib/constants'
import { matchIdentityKey, publicKeyHashFromWif, type IdentityKeyLike, type KeyMatchResult } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel, getPurposeName, getSecurityLevelName } from '@/lib/crypto/identity-keys'
import { parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { identityService } from '@/lib/services/identity-service'
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
  if (parsed.format === 'wif' && parsed.network !== network) {
    throw new RpcError('This key is for a different network', 'KEY_WRONG_NETWORK')
  }
  // Re-encoded compressed for this network: Platform keys are compressed points.
  return privateKeyToWif(parsed.privateKey, network)
}

export interface VerifiedKey {
  identityId: string
  /** The WIF to store: the input, re-encoded for this network. */
  wif: string
  keyId: number
  securityLevel: number
}

/** lib's wording for a key that matches the identity but may not sign in (key-validation-service). */
function rejectionMessage(match: KeyMatchResult): string {
  if (match.purpose !== KeyPurpose.AUTHENTICATION) {
    return `This key cannot be used for authentication (it's a ${getPurposeName(match.purpose)} key)`
  }
  return match.securityLevel === SecurityLevel.MASTER
    ? 'This is your MASTER key - keep it safe! Use a HIGH or CRITICAL authentication key instead.'
    : `This key's security level is too low (${getSecurityLevelName(match.securityLevel)}) - need HIGH or CRITICAL`
}

/**
 * Find the identity for a typed key and check the key may sign in for it:
 * one of the identity's ENABLED AUTHENTICATION keys at CRITICAL or HIGH,
 * matched with `matchIdentityKey`, the matcher session restore uses. (lib's
 * `keyValidationService.validatePrivateKey` ignores `disabledAt`; web bug
 * #616.) Throws KEY_INVALID, KEY_WRONG_NETWORK, IDENTITY_NOT_FOUND ("No
 * identity uses this key") or KEY_NOT_ON_IDENTITY (with lib's reason).
 */
export async function verifySignInKey(input: string): Promise<VerifiedKey> {
  const wif = toNetworkWif(input)
  const network = keyNetwork()
  const identityId = await identityService.getIdentityIdByPublicKeyHash(publicKeyHashFromWif(wif))
  if (!identityId) throw new RpcError('No identity uses this key', 'IDENTITY_NOT_FOUND')
  const identity = await identityService.getIdentity(identityId)
  if (!identity) throw new RpcError('Identity not found', 'IDENTITY_NOT_FOUND')
  const keys = identity.publicKeys as IdentityKeyLike[]
  const result = matchIdentityKey(wif, keys, {
    network,
    purpose: KeyPurpose.AUTHENTICATION,
    allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
  })
  if (result.ok) return { identityId, wif, keyId: result.match.keyId, securityLevel: result.match.securityLevel }
  if (result.reason === 'rejected') throw new RpcError(rejectionMessage(result.match), 'KEY_NOT_ON_IDENTITY')
  // Found by its hash, yet no enabled key matches: the key was disabled.
  const disabled = matchIdentityKey(wif, keys.map(key => ({ ...key, disabledAt: undefined })), { network, purpose: KeyPurpose.AUTHENTICATION })
  throw new RpcError(disabled.ok ? 'This key has been disabled on this identity' : 'Private key does not match this identity', 'KEY_NOT_ON_IDENTITY')
}
