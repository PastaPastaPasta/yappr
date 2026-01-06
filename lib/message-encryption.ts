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

export interface EncryptedMessage {
  ciphertext: string  // base64 encoded
  iv: string  // base64 encoded
  senderPublicKey: string  // base64 encoded - sender's public key for ECDH decryption
}

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
    sharedSecret,
    'HKDF',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('yappr-dm-v1'),
      info: new TextEncoder().encode('aes-key')
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt a message for a recipient using ECDH + AES-GCM
 *
 * @param message - Plain text message
 * @param senderPrivateKeyWif - Sender's private key in WIF format
 * @param recipientPublicKeyBytes - Recipient's public key bytes (33 or 65 bytes)
 * @returns Encrypted message object with ciphertext and IV
 */
export async function encryptMessage(
  message: string,
  senderPrivateKeyWif: string,
  recipientPublicKeyBytes: Uint8Array
): Promise<EncryptedMessage> {
  // 1. Convert WIF to raw private key
  const privateKey = wifToPrivateKey(senderPrivateKeyWif)

  // 2. Get sender's public key (to include in message for decryption)
  const senderPublicKey = secp256k1.getPublicKey(privateKey, true) // compressed 33 bytes

  // 3. Derive shared secret using ECDH
  const sharedSecret = deriveSharedSecret(privateKey, recipientPublicKeyBytes)

  // 4. Derive AES key from shared secret
  const aesKey = await deriveAesKey(sharedSecret)

  // 5. Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12))

  // 6. Encrypt the message
  const encoder = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encoder.encode(message)
  )

  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv),
    senderPublicKey: arrayBufferToBase64(senderPublicKey)
  }
}

/**
 * Decrypt a message using ECDH + AES-GCM
 *
 * @param encrypted - The encrypted message object
 * @param recipientPrivateKeyWif - Recipient's private key in WIF format
 * @param senderPublicKeyBytes - Sender's public key bytes (33 or 65 bytes)
 * @returns Decrypted plain text message
 */
export async function decryptMessage(
  encrypted: EncryptedMessage,
  recipientPrivateKeyWif: string,
  senderPublicKeyBytes: Uint8Array
): Promise<string> {
  // 1. Convert WIF to raw private key
  const privateKey = wifToPrivateKey(recipientPrivateKeyWif)

  // 2. Derive shared secret using ECDH (same as sender derived)
  const sharedSecret = deriveSharedSecret(privateKey, senderPublicKeyBytes)

  // 3. Derive AES key from shared secret
  const aesKey = await deriveAesKey(sharedSecret)

  // 4. Decrypt
  const iv = base64ToArrayBuffer(encrypted.iv)
  const ciphertext = base64ToArrayBuffer(encrypted.ciphertext)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    aesKey,
    ciphertext
  )

  return new TextDecoder().decode(decrypted)
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
    { name: 'AES-GCM', iv },
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
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertext
  )

  return new TextDecoder().decode(decrypted)
}

/**
 * Parse encrypted content string (format: "senderPubKey:iv:ciphertext") into EncryptedMessage
 * Also handles legacy format "iv:ciphertext" for backwards compatibility
 */
export function parseEncryptedContent(encryptedContent: string): EncryptedMessage {
  const parts = encryptedContent.split(':')
  if (parts.length === 3) {
    // New format: senderPubKey:iv:ciphertext
    return { senderPublicKey: parts[0], iv: parts[1], ciphertext: parts[2] }
  } else if (parts.length === 2) {
    // Legacy format: iv:ciphertext (no sender public key)
    return { senderPublicKey: '', iv: parts[0], ciphertext: parts[1] }
  }
  throw new Error('Invalid encrypted content format')
}

/**
 * Format EncryptedMessage as a string for storage (format: "senderPubKey:iv:ciphertext")
 */
export function formatEncryptedContent(encrypted: EncryptedMessage): string {
  return `${encrypted.senderPublicKey}:${encrypted.iv}:${encrypted.ciphertext}`
}

// Helper functions
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/**
 * Convert base64 string to Uint8Array (exported for use in decryption)
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
