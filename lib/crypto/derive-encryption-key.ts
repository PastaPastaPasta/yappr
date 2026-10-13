/**
 * Encryption key derivation (pure: no network, no SDK)
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
 *
 * On App Connect builds the encryption key is the one bound to the
 * `yappr-app` anchor, and its info names that anchor:
 * "yappr/app-connect/encryption-key/v1:<anchor id>". It is therefore never the
 * same key as an identity's legacy (unbound) one, which Platform would refuse
 * as a duplicate, and an identity's anchor key is recovered from the same
 * login key on any device.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import bs58 from 'bs58'
import { deriveYapprAuthKeyFromLogin, deriveYapprEncryptionKeyFromLogin } from 'platform-auth'
import { messagingAnchorId } from '@/lib/app-connect/config'

// HKDF info string for encryption key derivation
const INFO_ENCRYPTION_KEY = 'yappr/encryption-key/v1'
const INFO_ANCHOR_ENCRYPTION_KEY = 'yappr/app-connect/encryption-key/v1'

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
 * @param anchorId - The App Connect anchor the key is bound to; defaults to
 *   this build's (null on legacy builds, which derive the unbound key)
 * @returns The derived 32-byte encryption key
 */
export function deriveEncryptionKey(
  authPrivateKey: Uint8Array,
  identityId: string,
  anchorId: string | null = messagingAnchorId(),
): Uint8Array {
  if (authPrivateKey.length !== KEY_SIZE) {
    throw new Error(`Invalid auth key length: expected ${KEY_SIZE}, got ${authPrivateKey.length}`)
  }

  const salt = identityIdToSalt(identityId)
  const info = anchorId ? `${INFO_ANCHOR_ENCRYPTION_KEY}:${anchorId}` : INFO_ENCRYPTION_KEY
  return hkdf(sha256, authPrivateKey, salt, utf8Encode(info), KEY_SIZE)
}

/**
 * The encryption key a wallet sign-in (`dash-key:` login key) holds and its
 * first-login registration adds. Legacy builds: the key exchange's own
 * HKDF(loginKey, "encryption"). App Connect builds: the anchor key derived
 * from the sign-in's auth key, the same key "Set up messaging" adds and
 * `dm.unlock` re-derives, so every device that signs in with the wallet
 * recovers it.
 */
export function deriveLoginEncryptionKey(
  loginKey: Uint8Array,
  identityIdBytes: Uint8Array,
  anchorId: string | null = messagingAnchorId(),
): Uint8Array {
  if (!anchorId) return deriveYapprEncryptionKeyFromLogin(loginKey, identityIdBytes)
  const authKey = deriveYapprAuthKeyFromLogin(loginKey, identityIdBytes)
  const key = deriveEncryptionKey(authKey, bs58.encode(identityIdBytes), anchorId)
  authKey.fill(0)
  return key
}
