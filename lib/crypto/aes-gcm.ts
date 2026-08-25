/**
 * Shared AES-256-GCM encryption/decryption helpers.
 *
 * Used by vault-service and other modules that need symmetric encryption
 * with Web Crypto API.
 */

import { MIN_KDF_ITERATIONS, MAX_KDF_ITERATIONS } from '../onchain-key-encryption'

/**
 * AES-GCM encrypt: returns IV (12 bytes) prepended to ciphertext.
 */
export async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer
  )
  const result = new Uint8Array(12 + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), 12)
  return result
}

/**
 * AES-GCM decrypt: expects IV (12 bytes) prepended to ciphertext.
 */
export async function aesGcmDecrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, 12)
  const ciphertext = data.slice(12)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer
  )
  return new Uint8Array(plaintext)
}

/**
 * Derive an AES-256 key from password + explicit salt via PBKDF2.
 */
export async function deriveKeyFromPasswordAndSalt(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error(`Iterations must be between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`)
  }
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Derive an AES-256 key from a raw private key via SHA-256.
 *
 * This is intentionally a single SHA-256 hash (not PBKDF2) because the input
 * is already a high-entropy 32-byte private key, not a human-chosen password.
 * PBKDF2's key-stretching is unnecessary for cryptographic key material.
 */
export async function deriveAesKeyFromPrivateKey(privateKey: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest(
    'SHA-256',
    privateKey.buffer.slice(privateKey.byteOffset, privateKey.byteOffset + privateKey.byteLength) as ArrayBuffer
  )
  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
