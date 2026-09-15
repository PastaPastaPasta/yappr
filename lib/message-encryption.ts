'use client'

/**
 * Message encryption using ECDH for end-to-end encrypted direct messages
 *
 * ECDH(senderPrivateKey, recipientPublicKey) → HKDF-SHA256 → AES-256-GCM with
 * the IV prepended. The recipient derives the same key from
 * ECDH(recipientPrivateKey, senderPublicKey). Private keys arrive as WIF and are
 * checksum-verified on decode.
 */

import { wifToPrivateKey } from './crypto/wif'
import { getPublicKey } from './crypto/keys'
import { ecdhSharedX } from './crypto/ecdh'
import { aesGcmDecrypt, aesGcmEncrypt, deriveKeyWithHkdf } from './crypto/aes-gcm'

const DM_KDF_SALT = new TextEncoder().encode('yappr-dm-v1')
const DM_KDF_INFO = new TextEncoder().encode('aes-key')
/**
 * Generate a deterministic conversation ID from two participant IDs
 * Sorts alphabetically to ensure same ID regardless of sender/recipient order
 * Returns 10 bytes (first 10 bytes of SHA-256 hash)
 *
 * Note: 10 bytes is the minimum for platform's byteArray auto-detection heuristic
 */
export async function generateConversationId(userId1: string, userId2: string): Promise<Uint8Array> {
  const sorted = [userId1, userId2].sort()
  const combined = sorted[0] + ':' + sorted[1]

  const encoder = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(combined))
  return new Uint8Array(hash).slice(0, 10)  // 10 bytes for platform compatibility
}

/**
 * The AES key both parties derive: HKDF over the ECDH shared x-coordinate.
 * ECDH(senderPriv, recipientPub) == ECDH(recipientPriv, senderPub).
 */
async function deriveMessageKey(privateKeyWif: string, otherPublicKey: Uint8Array): Promise<CryptoKey> {
  const { privateKey } = wifToPrivateKey(privateKeyWif)
  return deriveKeyWithHkdf(ecdhSharedX(privateKey, otherPublicKey), DM_KDF_SALT, DM_KDF_INFO)
}

/**
 * Get public key from private key (for including sender's public key in message)
 */
export function getPublicKeyFromPrivate(privateKeyWif: string): Uint8Array {
  return getPublicKey(wifToPrivateKey(privateKeyWif).privateKey)
}

/**
 * Encrypt a message to binary format for v2 contract
 * Returns Uint8Array with IV prepended: [12 bytes IV | ciphertext]
 * Sender's public key is NOT included (stored in conversationInvite instead)
 */
export async function encryptToBinary(
  message: string,
  senderPrivateKeyWif: string,
  recipientPublicKeyBytes: Uint8Array
): Promise<Uint8Array> {
  const aesKey = await deriveMessageKey(senderPrivateKeyWif, recipientPublicKeyBytes)
  return aesGcmEncrypt(aesKey, new TextEncoder().encode(message))
}

/**
 * Decrypt a message from binary format (v2 contract)
 * Expects Uint8Array with IV prepended: [12 bytes IV | ciphertext]
 */
export async function decryptFromBinary(
  encryptedContent: Uint8Array,
  recipientPrivateKeyWif: string,
  senderPublicKeyBytes: Uint8Array
): Promise<string> {
  const aesKey = await deriveMessageKey(recipientPrivateKeyWif, senderPublicKeyBytes)
  return new TextDecoder().decode(await aesGcmDecrypt(aesKey, encryptedContent))
}
