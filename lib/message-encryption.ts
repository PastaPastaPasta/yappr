'use client'

/**
 * Message encryption using ECDH for end-to-end encrypted direct messages
 *
 * Flow:
 * 1. Derive shared secret using ECDH(senderPrivateKey, recipientPublicKey)
 * 2. Use HKDF to derive AES-256 key from shared secret
 * 3. Encrypt message with AES-GCM
 *
 * Decryption uses the same shared secret derived from ECDH(recipientPrivateKey, senderPublicKey)
 */

import * as secp256k1 from '@noble/secp256k1'
import bs58 from 'bs58'

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
 * Convert WIF (Wallet Import Format) private key to raw bytes
 */
function wifToPrivateKey(wif: string): Uint8Array {
  const decoded = bs58.decode(wif)
  // WIF format: version (1 byte) + key (32 bytes) + [compression flag (1 byte)] + checksum (4 bytes)
  // Extract the 32-byte private key
  return decoded.slice(1, 33)
}

/**
 * Derive a shared secret using ECDH
 * Both parties will derive the same secret:
 * - Sender: ECDH(senderPrivate, recipientPublic)
 * - Recipient: ECDH(recipientPrivate, senderPublic)
 */
function deriveSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // Use secp256k1 to compute shared point
  const sharedPoint = secp256k1.getSharedSecret(privateKey, publicKey)
  // The shared secret is the x-coordinate of the shared point (first 32 bytes after prefix)
  // getSharedSecret returns 33 bytes (compressed) or 65 bytes (uncompressed)
  // We take bytes 1-33 for the x-coordinate
  return sharedPoint.slice(1, 33)
}

/**
 * Derive an AES-256 key from the shared secret using HKDF
 */
async function deriveAesKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    sharedSecret.buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('yappr-dm-v1').buffer as ArrayBuffer,
      info: new TextEncoder().encode('aes-key').buffer as ArrayBuffer
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Get public key from private key (for including sender's public key in message)
 */
export function getPublicKeyFromPrivate(privateKeyWif: string): Uint8Array {
  const privateKey = wifToPrivateKey(privateKeyWif)
  return secp256k1.getPublicKey(privateKey, true) // compressed format (33 bytes)
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
  // 1. Convert WIF to raw private key
  const privateKey = wifToPrivateKey(senderPrivateKeyWif)

  // 2. Derive shared secret using ECDH
  const sharedSecret = deriveSharedSecret(privateKey, recipientPublicKeyBytes)

  // 3. Derive AES key from shared secret
  const aesKey = await deriveAesKey(sharedSecret)

  // 4. Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12))

  // 5. Encrypt the message
  const encoder = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    aesKey,
    encoder.encode(message)
  )

  // 6. Prepend IV to ciphertext
  const result = new Uint8Array(12 + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), 12)
  return result
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
  // 1. Convert WIF to raw private key
  const privateKey = wifToPrivateKey(recipientPrivateKeyWif)

  // 2. Derive shared secret using ECDH
  const sharedSecret = deriveSharedSecret(privateKey, senderPublicKeyBytes)

  // 3. Derive AES key from shared secret
  const aesKey = await deriveAesKey(sharedSecret)

  // 4. Extract IV (first 12 bytes) and ciphertext (rest)
  const iv = encryptedContent.slice(0, 12)
  const ciphertext = encryptedContent.slice(12)

  // 5. Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    aesKey,
    ciphertext
  )

  return new TextDecoder().decode(decrypted)
}
