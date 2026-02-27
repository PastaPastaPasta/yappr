'use client'

import { logger } from '@/lib/logger';
/**
 * On-chain key encryption utilities for encrypted key backup feature.
 *
 * Password Backup (v1):
 *   Uses PBKDF2 for key derivation (user-configurable iterations) and AES-GCM for encryption.
 *   Salt is derived from identity ID to ensure uniqueness without storing separately.
 */

// Iteration limits (1M to 1B)
export const MIN_KDF_ITERATIONS = 1_000_000
export const MAX_KDF_ITERATIONS = 1_000_000_000
export const DEFAULT_TARGET_MS = 2000

// Current encryption version
export const ENCRYPTION_VERSION = 1

// Minimum password length
export const MIN_PASSWORD_LENGTH = 16

export interface OnchainEncryptedData {
  encryptedKey: string  // Base64-encoded AES-GCM ciphertext
  iv: string            // Base64-encoded initialization vector
  version: number       // Encryption scheme version
  kdfIterations: number // PBKDF2 iterations used
}

/**
 * Storacha credentials for backup/restore
 */
export interface StorachaBackupCredentials {
  email: string
  agentData: string  // Base64 serialized agent
  spaceDid: string
}

/**
 * Extended backup data structure (v2) that includes optional Storacha credentials
 */
export interface ExtendedBackupPayload {
  /** Backup format version - 2 for extended format */
  formatVersion: 2
  /** The login key in WIF format */
  loginKey: string
  /** Optional Storacha credentials */
  storachaCredentials?: StorachaBackupCredentials
}

export interface PasswordValidationResult {
  valid: boolean
  error?: string
  length: number
}

export interface BenchmarkResult {
  iterations: number
  estimatedMs: number
}


/**
 * Validate backup password requirements (16+ characters)
 */
export function validateBackupPassword(password: string): PasswordValidationResult {
  const length = password.length

  if (length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters (currently ${length})`,
      length
    }
  }

  return { valid: true, length }
}

/**
 * Benchmark PBKDF2 on the current device to estimate iteration count for target time.
 * Returns iteration count clamped to MIN_KDF_ITERATIONS - MAX_KDF_ITERATIONS range.
 */
export async function benchmarkPbkdf2(targetMs: number = DEFAULT_TARGET_MS): Promise<BenchmarkResult> {
  const testPassword = 'benchmark-test-password'
  const testSalt = new Uint8Array(16)

  const encoder = new TextEncoder()
  const passwordBuffer = encoder.encode(testPassword)

  // Import password as key material (do this once, outside timing)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits']
  )

  // Warm up run to trigger JIT compilation
  await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: testSalt,
      iterations: 10_000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  )

  // Use a larger test (500k iterations) to minimize fixed overhead impact
  // This should take ~100-500ms on most devices, giving accurate measurement
  const testIterations = 500_000

  const startTime = performance.now()

  await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: testSalt,
      iterations: testIterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  )

  const endTime = performance.now()
  const elapsedMs = endTime - startTime

  // Calculate iterations per ms and target iterations
  const iterationsPerMs = testIterations / elapsedMs
  let targetIterations = Math.round(iterationsPerMs * targetMs)

  // Clamp to allowed range
  targetIterations = Math.max(MIN_KDF_ITERATIONS, Math.min(MAX_KDF_ITERATIONS, targetIterations))

  // Estimate actual time with clamped iterations
  const estimatedMs = targetIterations / iterationsPerMs

  return {
    iterations: targetIterations,
    estimatedMs: Math.round(estimatedMs)
  }
}

/**
 * Generate deterministic salt from identity ID using SHA-256.
 * This ensures the salt is unique per identity without storing it.
 */
export async function generateIdentitySalt(identityId: string): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  // Add domain separator to prevent collisions with other uses
  const data = encoder.encode(`yappr:key-backup:v1:${identityId}`)

  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  // Use first 16 bytes of SHA-256 hash as salt
  return new Uint8Array(hashBuffer).slice(0, 16)
}

/**
 * Derive AES-256 key from identity ID + password using PBKDF2
 */
export async function deriveOnchainKey(
  identityId: string,
  password: string,
  iterations: number
): Promise<CryptoKey> {
  // Validate iterations
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error(`Iterations must be between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`)
  }

  const encoder = new TextEncoder()
  const passwordBuffer = encoder.encode(password)

  // Generate salt from identity ID
  const salt = await generateIdentitySalt(identityId)

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  )

  // Derive AES key
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt private key for on-chain storage.
 * Returns data suitable for storing in the encryptedKeyBackup contract document.
 */
export async function encryptKeyForOnchain(
  privateKeyWif: string,
  identityId: string,
  password: string,
  iterations: number
): Promise<OnchainEncryptedData> {
  // Validate password
  const validation = validateBackupPassword(password)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  // Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12))

  // Derive key from identity ID + password
  const key = await deriveOnchainKey(identityId, password, iterations)

  // Encrypt the private key
  const encoder = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(privateKeyWif)
  )

  return {
    encryptedKey: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv),
    version: ENCRYPTION_VERSION,
    kdfIterations: iterations
  }
}

/**
 * Decrypt private key from on-chain backup.
 * Uses the stored iteration count for decryption.
 */
export async function decryptKeyFromOnchain(
  data: OnchainEncryptedData,
  identityId: string,
  password: string
): Promise<string> {
  // Check version compatibility
  if (data.version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${data.version}`)
  }

  // Derive key using stored iteration count
  const key = await deriveOnchainKey(identityId, password, data.kdfIterations)

  // Decrypt
  const iv = base64ToUint8Array(data.iv)
  const ciphertext = base64ToArrayBuffer(data.encryptedKey)

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    )

    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  } catch {
    throw new Error('Invalid password')
  }
}

/**
 * Estimate decryption time for a given iteration count based on benchmark
 */
export async function estimateDecryptionTime(iterations: number): Promise<number> {
  const benchmark = await benchmarkPbkdf2(1000) // Quick benchmark
  const iterationsPerMs = benchmark.iterations / benchmark.estimatedMs
  return Math.round(iterations / iterationsPerMs)
}

// --- Utility functions ---

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

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// --- Extended Backup (v2) Functions ---

/**
 * Check if decrypted data is in extended format (v2)
 */
export function isExtendedBackupPayload(data: unknown): data is ExtendedBackupPayload {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return obj.formatVersion === 2 && typeof obj.loginKey === 'string'
}

/**
 * Encrypt extended backup payload for on-chain storage.
 * Uses the same encryption scheme as v1 but with JSON payload.
 */
export async function encryptExtendedBackup(
  payload: ExtendedBackupPayload,
  identityId: string,
  password: string,
  iterations: number
): Promise<OnchainEncryptedData> {
  // Validate password
  const validation = validateBackupPassword(password)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  // Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12))

  // Derive key from identity ID + password
  const key = await deriveOnchainKey(identityId, password, iterations)

  // Encrypt the JSON payload
  const encoder = new TextEncoder()
  const payloadJson = JSON.stringify(payload)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(payloadJson)
  )

  return {
    encryptedKey: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv),
    version: ENCRYPTION_VERSION,
    kdfIterations: iterations
  }
}

/**
 * Decrypt backup and return the payload.
 * Handles both v1 (plain WIF) and v2 (extended JSON) formats.
 */
export async function decryptBackupPayload(
  data: OnchainEncryptedData,
  identityId: string,
  password: string
): Promise<{ loginKey: string; storachaCredentials?: StorachaBackupCredentials }> {
  // Decrypt using existing function
  const decrypted = await decryptKeyFromOnchain(data, identityId, password)

  // Try to parse as JSON (v2 format)
  try {
    const parsed = JSON.parse(decrypted)
    if (isExtendedBackupPayload(parsed)) {
      return {
        loginKey: parsed.loginKey,
        storachaCredentials: parsed.storachaCredentials
      }
    }
    // Parsed as JSON but not a valid ExtendedBackupPayload - unexpected format
    logger.warn('Unexpected backup payload format:', typeof parsed, Object.keys(parsed as object))
    throw new Error('Unexpected backup payload format')
  } catch (e) {
    // If JSON.parse failed, it's v1 format (plain WIF key)
    // If it's our own error about unexpected format, re-throw it
    if (e instanceof Error && e.message === 'Unexpected backup payload format') {
      throw e
    }
  }

  // V1 format - decrypted string is the login key directly
  return { loginKey: decrypted }
}
