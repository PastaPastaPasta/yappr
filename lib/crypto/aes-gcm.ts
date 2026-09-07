/**
 * AES-256-GCM over Web Crypto, plus the two key derivations the app pairs it
 * with. Every symmetric-encryption path (auth vault, legacy vault, on-chain
 * key backup, direct messages) is built from these.
 */

export const AES_GCM_IV_LENGTH = 12
export const AES_KEY_LENGTH = 256

// Iteration limits for password-derived keys (1M to 1B). Shared by every
// password-wrapped secret so a stored iteration count is validated the same
// way regardless of which feature wrote it.
export const MIN_KDF_ITERATIONS = 1_000_000
export const MAX_KDF_ITERATIONS = 1_000_000_000

export interface AesGcmSealed {
  ciphertext: Uint8Array
  iv: Uint8Array
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function randomIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH))
}

/** Import raw 32-byte key material as a non-extractable AES-GCM key. */
export async function importAesKey(rawKey: Uint8Array, usages: KeyUsage[] = ['encrypt', 'decrypt']): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM', length: AES_KEY_LENGTH }, false, usages)
}

/**
 * AES-GCM encrypt with a separate IV. `aad` is bound into the tag when given.
 * The IV is generated here unless the caller derives one deterministically.
 */
export async function aesGcmSeal(
  key: CryptoKey,
  plaintext: Uint8Array,
  options: { aad?: Uint8Array; iv?: Uint8Array } = {}
): Promise<AesGcmSealed> {
  const iv = options.iv ?? randomIv()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), ...(options.aad?.length ? { additionalData: toArrayBuffer(options.aad) } : {}) },
    key,
    toArrayBuffer(plaintext)
  )
  return { ciphertext: new Uint8Array(ciphertext), iv }
}

/** AES-GCM decrypt with a separate IV. Throws on a bad tag (wrong key, AAD, or tampering). */
export async function aesGcmOpen(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), ...(aad?.length ? { additionalData: toArrayBuffer(aad) } : {}) },
    key,
    toArrayBuffer(ciphertext)
  )
  return new Uint8Array(plaintext)
}

/** AES-GCM encrypt, returning the IV prepended to the ciphertext: `iv (12) || ciphertext || tag`. */
export async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const { ciphertext, iv } = await aesGcmSeal(key, plaintext)
  const result = new Uint8Array(iv.length + ciphertext.length)
  result.set(iv, 0)
  result.set(ciphertext, iv.length)
  return result
}

/** AES-GCM decrypt of `iv (12) || ciphertext || tag`. */
export async function aesGcmDecrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return aesGcmOpen(key, data.slice(AES_GCM_IV_LENGTH), data.slice(0, AES_GCM_IV_LENGTH))
}

export function assertKdfIterations(iterations: number): void {
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error(`Iterations must be between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`)
  }
}

/** PBKDF2-SHA256 from a password and explicit salt to a non-extractable AES-256-GCM key. */
export async function deriveKeyFromPasswordAndSalt(
  password: string,
  salt: Uint8Array,
  iterations: number,
  usages: KeyUsage[] = ['encrypt', 'decrypt']
): Promise<CryptoKey> {
  assertKdfIterations(iterations)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(new TextEncoder().encode(password)),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    usages
  )
}

/**
 * HKDF-SHA256 from input key material to a non-extractable AES-256-GCM key.
 * For high-entropy inputs (ECDH shared secrets, PRF outputs), not passwords.
 */
export async function deriveKeyWithHkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  usages: KeyUsage[] = ['encrypt', 'decrypt']
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', toArrayBuffer(ikm), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    usages
  )
}

/**
 * Derive an AES-256 key from a raw private key via a single SHA-256.
 * The input is already 32 bytes of key material, so no stretching is needed.
 */
export async function deriveAesKeyFromPrivateKey(privateKey: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', toArrayBuffer(privateKey))
  return crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM', length: AES_KEY_LENGTH }, false, ['encrypt', 'decrypt'])
}
