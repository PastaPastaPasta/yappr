/**
 * The check of a derived encryption key (derive-encryption-key.ts) against an
 * identity's on-chain encryption key.
 */

import { getPublicKey } from './keys'
import { bytesEqual, normalizeBytes } from '@/lib/bytes'
import { rememberAnchorKey } from '@/lib/app-connect/anchor-key-mark'

/**
 * Check if a derived encryption key matches the public key on an identity.
 *
 * @param derivedPrivateKey - The derived 32-byte private key
 * @param identityId - The user's identity ID
 * @returns True if the derived key matches the identity's encryption key
 */
export async function validateDerivedKeyMatchesIdentity(
  derivedPrivateKey: Uint8Array,
  identityId: string,
): Promise<boolean> {
  // Get the public key from derived private key
  let derivedPubKey: Uint8Array
  try {
    derivedPubKey = getPublicKey(derivedPrivateKey)
  } catch {
    return false
  }

  // Fetch identity's public keys. On App Connect builds the key must be the
  // anchor's current one, so a cached identity (which may predate a rotation) won't do.
  const { identityService } = await import('@/lib/services/identity-service')
  const { isAppConnectBuild } = await import('@/lib/app-connect/config')
  const identityData = await identityService.getIdentity(identityId, { fresh: isAppConnectBuild() })
  if (!identityData) {
    return false
  }

  // Find the encryption key (purpose=1, type=0 is ECDSA_SECP256K1)
  // Use shared helper for contract-bound key preference
  const { findEncryptionKey } = await import('@/lib/crypto/encryption-key-lookup')
  const targetKey = findEncryptionKey(identityData.publicKeys)

  if (!targetKey?.data) {
    return false
  }

  const onChainPubKeyBytes = normalizeBytes(targetKey.data)
  if (!onChainPubKeyBytes) {
    return false
  }

  const matches = bytesEqual(derivedPubKey, onChainPubKeyBytes)
  // The stored copy of this key may now stand in for the anchor key (secure-storage).
  if (matches && isAppConnectBuild()) rememberAnchorKey(identityId, derivedPubKey)
  return matches
}
