/**
 * Key Exchange Crypto Module
 *
 * Implements the Dash Platform Application Key Exchange Protocol.
 * Uses ephemeral ECDH key exchange with AES-256-GCM encryption to securely
 * transfer deterministic login keys from a wallet to a web application.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md
 */

import * as secp256k1 from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

// Text encoder for UTF-8 strings
const encoder = new TextEncoder()

/**
 * Ephemeral keypair for ECDH key exchange
 */
export interface EphemeralKeyPair {
  privateKey: Uint8Array  // 32 bytes
  publicKey: Uint8Array   // 33 bytes (compressed)
}

/**
 * Generate a random ephemeral secp256k1 keypair for ECDH.
 * The public key is in compressed format (33 bytes).
 *
 * Spec section 6.2: Both sides generate random ephemeral keypairs for ECDH
 */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = secp256k1.getPublicKey(privateKey, true) // compressed
  return { privateKey, publicKey }
}

/**
 * Derive the ECDH shared secret from ephemeral keys.
 *
 * Spec section 6.3:
 *   ecdh_point = secp256k1_multiply(wallet_ephemeral_public, app_ephemeral_private)
 *   shared_x = ecdh_point.x (32 bytes)
 *   shared_secret = HKDF-SHA256(ikm=shared_x, salt="dash:key-exchange:v1", info="", length=32)
 *
 * @param appEphemeralPrivateKey - Application's ephemeral private key (32 bytes)
 * @param walletEphemeralPublicKey - Wallet's ephemeral public key from response (33 bytes)
 * @returns 32-byte shared secret for AES-256-GCM
 */
export function deriveSharedSecret(
  appEphemeralPrivateKey: Uint8Array,
  walletEphemeralPublicKey: Uint8Array
): Uint8Array {
  // ECDH using both ephemeral keys
  const sharedPoint = secp256k1.getSharedSecret(appEphemeralPrivateKey, walletEphemeralPublicKey)

  // Extract x-coordinate only (first byte is the prefix 0x04 for uncompressed)
  // getSharedSecret returns uncompressed point: 0x04 || x (32 bytes) || y (32 bytes)
  const sharedX = sharedPoint.slice(1, 33)

  // HKDF with protocol-specific salt
  // salt: UTF-8 encoded "dash:key-exchange:v1" (20 bytes)
  // info: empty
  return hkdf(
    sha256,
    sharedX,
    encoder.encode('dash:key-exchange:v1'),
    new Uint8Array(0),
    32
  )
}

/**
 * Decrypt the encrypted login key payload using AES-256-GCM.
 *
 * Spec section 6.5:
 *   Payload format: nonce (12 bytes) || ciphertext (32 bytes) || tag (16 bytes) = 60 bytes
 *   Web Crypto API expects: nonce, ciphertext+tag combined
 *
 * @param encryptedPayload - The encrypted payload from the response document (60 bytes)
 * @param sharedSecret - The 32-byte ECDH shared secret
 * @returns The decrypted 32-byte login key
 * @throws If decryption fails (wrong key or tampered data)
 */
export async function decryptLoginKey(
  encryptedPayload: Uint8Array,
  sharedSecret: Uint8Array
): Promise<Uint8Array> {
  if (encryptedPayload.length < 44) {
    throw new Error('Encrypted payload too short')
  }

  // Extract nonce and ciphertext+tag
  // Web Crypto's AES-GCM expects ciphertext with tag appended
  const nonce = encryptedPayload.slice(0, 12)
  const ciphertextWithTag = encryptedPayload.slice(12)

  // Import shared secret as AES-256-GCM key
  const key = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertextWithTag
  )

  return new Uint8Array(decrypted)
}

/**
 * Derive authentication private key from login key.
 *
 * Spec section 5.2:
 *   auth_private_key = HKDF-SHA256(
 *     ikm: login_key (32 bytes),
 *     salt: identity_id (32 bytes),
 *     info: UTF8("auth") (4 bytes),
 *     length: 32 bytes
 *   )
 *
 * @param loginKey - The 32-byte login key from wallet
 * @param identityIdBytes - The raw 32-byte identity identifier
 * @returns The derived 32-byte authentication private key
 */
export function deriveAuthKeyFromLogin(
  loginKey: Uint8Array,
  identityIdBytes: Uint8Array
): Uint8Array {
  if (loginKey.length !== 32) {
    throw new Error(`Invalid login key length: expected 32, got ${loginKey.length}`)
  }
  if (identityIdBytes.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${identityIdBytes.length}`)
  }

  return hkdf(
    sha256,
    loginKey,
    identityIdBytes,
    encoder.encode('auth'),
    32
  )
}

/**
 * Derive encryption private key from login key.
 *
 * Spec section 5.3:
 *   encryption_private_key = HKDF-SHA256(
 *     ikm: login_key (32 bytes),
 *     salt: identity_id (32 bytes),
 *     info: UTF8("encryption") (10 bytes),
 *     length: 32 bytes
 *   )
 *
 * @param loginKey - The 32-byte login key from wallet
 * @param identityIdBytes - The raw 32-byte identity identifier
 * @returns The derived 32-byte encryption private key
 */
export function deriveEncryptionKeyFromLogin(
  loginKey: Uint8Array,
  identityIdBytes: Uint8Array
): Uint8Array {
  if (loginKey.length !== 32) {
    throw new Error(`Invalid login key length: expected 32, got ${loginKey.length}`)
  }
  if (identityIdBytes.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${identityIdBytes.length}`)
  }

  return hkdf(
    sha256,
    loginKey,
    identityIdBytes,
    encoder.encode('encryption'),
    32
  )
}

/**
 * Get the public key for a given private key (compressed format).
 *
 * @param privateKey - The 32-byte private key
 * @returns The 33-byte compressed public key
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true)
}

/**
 * Zero out sensitive key material for security.
 *
 * Spec section 12.8: Application MUST clear ephemeral private key from memory
 * immediately after successful decryption.
 *
 * @param key - The key bytes to zero out
 */
export function clearKeyMaterial(key: Uint8Array): void {
  key.fill(0)
}
