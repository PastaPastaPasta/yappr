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
 * @param purpose - The key purpose (must be 1 for encryption key)
 * @returns True if the derived key matches the identity's encryption key
 */
export async function validateDerivedKeyMatchesIdentity(
  derivedPrivateKey: Uint8Array,
  identityId: string,
  purpose: 1
): Promise<boolean> {
  // Get the public key from derived private key
  const { privateFeedCryptoService } = await import('@/lib/services')
  let derivedPubKey: Uint8Array
  try {
    derivedPubKey = privateFeedCryptoService.getPublicKey(derivedPrivateKey)
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
  const targetKey = identityData.publicKeys.find(
    (key) => key.purpose === purpose && key.type === 0
  )

  if (!targetKey?.data) {
    return false
  }

  // Parse on-chain public key data
  let onChainPubKeyBytes: Uint8Array | null = null
  if (targetKey.data instanceof Uint8Array) {
    onChainPubKeyBytes = targetKey.data
  } else if (typeof targetKey.data === 'string') {
    // Could be hex or base64
    if (/^[0-9a-fA-F]+$/.test(targetKey.data)) {
      // Hex
      onChainPubKeyBytes = new Uint8Array(targetKey.data.length / 2)
      for (let i = 0; i < onChainPubKeyBytes.length; i++) {
        onChainPubKeyBytes[i] = parseInt(targetKey.data.substr(i * 2, 2), 16)
      }
    } else {
      // Assume base64
      const binary = atob(targetKey.data)
      onChainPubKeyBytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        onChainPubKeyBytes[i] = binary.charCodeAt(i)
      }
    }
  }

  if (!onChainPubKeyBytes) {
    return false
  }

  // Compare derived public key with on-chain public key
  return (
    derivedPubKey.length === onChainPubKeyBytes.length &&
    derivedPubKey.every((b, i) => b === onChainPubKeyBytes[i])
  )
}

/**
 * Determine the encryption key type by attempting derivation and checking match.
 *
 * @param authPrivateKey - The 32-byte auth private key
 * @param identityId - The user's identity ID
 * @param purpose - The key purpose (must be 1 for encryption key)
 * @returns The key type ('derived' if matches, 'external' if not, or null if no key on identity)
 */
export async function determineKeyType(
  authPrivateKey: Uint8Array,
  identityId: string,
  purpose: 1
): Promise<KeyType | null> {
  // First check if identity has an encryption key
  const { identityService } = await import('@/lib/services/identity-service')
  const identityData = await identityService.getIdentity(identityId)
  if (!identityData) {
    return null
  }

  const hasKey = identityData.publicKeys.some(
    (key) => key.purpose === purpose && key.type === 0
  )
  if (!hasKey) {
    return null
  }

  // Derive the encryption key
  const derivedKey = deriveEncryptionKey(authPrivateKey, identityId)

  // Check if derived matches identity
  const matches = await validateDerivedKeyMatchesIdentity(derivedKey, identityId, purpose)
  return matches ? 'derived' : 'external'
}
