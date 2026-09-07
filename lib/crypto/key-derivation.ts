/**
 * Key Derivation Module
 *
 * Derives encryption and transfer keys from the auth private key using HKDF.
 * This enables zero-friction key management for new users - their encryption
 * and transfer keys can be deterministically derived from their auth key.
 *
 * Algorithm:
 *   derivedKey = HKDF-SHA256(
 *     ikm: authPrivateKey (32 bytes),
 *     salt: SHA256(identityId),
 *     info: "yappr/<purpose>/v1",
 *     length: 32 bytes
 *   )
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { getPublicKey } from './keys'
import { bytesEqual, normalizeBytes } from '@/lib/bytes'

// Key type indicates whether a key was derived from auth key or externally provided
export type KeyType = 'derived' | 'external'

// HKDF info string for encryption key derivation
const INFO_ENCRYPTION_KEY = 'yappr/encryption-key/v1'

// Key size (256 bits)
const KEY_SIZE = 32

/**
 * Convert string to UTF-8 bytes
 */
function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

/**
 * Convert identity ID string to bytes for use as HKDF salt.
 * Uses SHA256(identityId) to ensure consistent 32-byte salt.
 */
function identityIdToSalt(identityId: string): Uint8Array {
  return sha256(utf8Encode(identityId))
}

/**
 * Derive encryption key from auth private key.
 *
 * The encryption key is used for private feed operations (purpose=1 on identity).
 *
 * @param authPrivateKey - The 32-byte auth private key
 * @param identityId - The user's identity ID
 * @returns The derived 32-byte encryption key
 */
export function deriveEncryptionKey(
  authPrivateKey: Uint8Array,
  identityId: string
): Uint8Array {
  if (authPrivateKey.length !== KEY_SIZE) {
    throw new Error(`Invalid auth key length: expected ${KEY_SIZE}, got ${authPrivateKey.length}`)
  }

  const salt = identityIdToSalt(identityId)
  return hkdf(sha256, authPrivateKey, salt, utf8Encode(INFO_ENCRYPTION_KEY), KEY_SIZE)
}


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

  // Fetch identity's public keys
  const { identityService } = await import('@/lib/services/identity-service')
  const identityData = await identityService.getIdentity(identityId)
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

  return bytesEqual(derivedPubKey, onChainPubKeyBytes)
}

/**
 * Determine the encryption key type by attempting derivation and checking match.
 *
 * @param authPrivateKey - The 32-byte auth private key
 * @param identityId - The user's identity ID
 * @returns The key type ('derived' if matches, 'external' if not, or null if no key on identity)
 */
export async function determineKeyType(
  authPrivateKey: Uint8Array,
  identityId: string,
): Promise<KeyType | null> {
  // First check if identity has an encryption key
  const { identityService } = await import('@/lib/services/identity-service')
  const { hasEncryptionKeyOnIdentity } = await import('@/lib/crypto/encryption-key-lookup')
  const identityData = await identityService.getIdentity(identityId)
  if (!identityData) {
    return null
  }

  if (!hasEncryptionKeyOnIdentity(identityData.publicKeys)) {
    return null
  }

  // Derive the encryption key
  const derivedKey = deriveEncryptionKey(authPrivateKey, identityId)

  // Check if derived matches identity
  const matches = await validateDerivedKeyMatchesIdentity(derivedKey, identityId)
  return matches ? 'derived' : 'external'
}
