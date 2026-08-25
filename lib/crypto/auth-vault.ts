import { sha256 } from '@noble/hashes/sha2.js'
import { MIN_KDF_ITERATIONS, MAX_KDF_ITERATIONS } from '@/lib/onchain-key-encryption'

export type AuthVaultSecretKind = 'login-key' | 'auth-key'
export type AuthVaultSource = 'wallet-derived' | 'direct-key' | 'password-migrated' | 'mixed'

export interface AuthVaultBundle {
  version: 1
  identityId: string
  network: 'testnet' | 'mainnet'
  secretKind: AuthVaultSecretKind
  loginKey?: string
  authKeyWif?: string
  encryptionKeyWif?: string
  transferKeyWif?: string
  source: AuthVaultSource
  updatedAt: number
}

export interface EncryptResult {
  ciphertext: Uint8Array
  iv: Uint8Array
}

const BUNDLE_INFO = 'yappr/auth-vault/bundle/v1'
const PRF_WRAP_INFO = 'yappr/auth-vault/dek-wrap/prf/v1'
const IV_LENGTH = 12

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function encodeBundle(bundle: AuthVaultBundle): Uint8Array {
  return utf8(JSON.stringify(bundle))
}

function decodeBundle(bytes: Uint8Array): AuthVaultBundle {
  return JSON.parse(new TextDecoder().decode(bytes)) as AuthVaultBundle
}

function buildBundleAad(identityId: string, vaultId: string, secretKind: AuthVaultSecretKind, version: number): Uint8Array {
  return utf8(JSON.stringify({
    info: BUNDLE_INFO,
    identityId,
    vaultId,
    secretKind,
    version,
  }))
}

function buildWrapperAad(identityId: string, vaultId: string, kind: 'password' | 'passkey-prf', version: number, rpId?: string): Uint8Array {
  return utf8(JSON.stringify({
    identityId,
    vaultId,
    kind,
    version,
    rpId,
  }))
}

function buildPrfSalt(identityId: string, vaultId: string, rpId: string): Uint8Array {
  return sha256(utf8(`yappr/auth-vault/prf-salt/v1:${identityId}:${vaultId}:${rpId}`))
}

async function importAesKey(rawKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(rawKey),
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  )
}

async function importHkdfMaterial(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), 'HKDF', false, ['deriveKey'])
}

async function importPbkdf2Material(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(utf8(password)), 'PBKDF2', false, ['deriveKey'])
}

async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array, iv = randomBytes(IV_LENGTH)): Promise<EncryptResult> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    key,
    toArrayBuffer(plaintext),
  )

  return {
    ciphertext: new Uint8Array(ciphertext),
    iv,
  }
}

async function aesGcmDecrypt(key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    key,
    toArrayBuffer(ciphertext),
  )

  return new Uint8Array(plaintext)
}

async function derivePasswordWrappingKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error(`Iterations must be between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`)
  }

  const keyMaterial = await importPbkdf2Material(password)
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function derivePrfWrappingKey(prfOutput: Uint8Array, identityId: string, vaultId: string, rpId: string): Promise<CryptoKey> {
  const keyMaterial = await importHkdfMaterial(prfOutput)
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(buildPrfSalt(identityId, vaultId, rpId)),
      info: toArrayBuffer(utf8(PRF_WRAP_INFO)),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function generateDek(): Uint8Array {
  return randomBytes(32)
}

export function generatePrfInput(): Uint8Array {
  return randomBytes(32)
}

export function getBundleHash(bundle: AuthVaultBundle): Uint8Array {
  return sha256(encodeBundle(bundle))
}

export function encodeBinaryToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function decodeBinaryFromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function encryptBundle(bundle: AuthVaultBundle, dek: Uint8Array, vaultId: string): Promise<EncryptResult & { bundleHash: Uint8Array }> {
  const aad = buildBundleAad(bundle.identityId, vaultId, bundle.secretKind, bundle.version)
  const key = await importAesKey(dek, ['encrypt'])
  const plaintext = encodeBundle(bundle)
  const result = await aesGcmEncrypt(key, plaintext, aad)

  return {
    ...result,
    bundleHash: sha256(plaintext),
  }
}

export async function decryptBundle(bundleCiphertext: Uint8Array, iv: Uint8Array, dek: Uint8Array, vaultId: string, identityId: string, secretKind: AuthVaultSecretKind, version: number): Promise<AuthVaultBundle> {
  const aad = buildBundleAad(identityId, vaultId, secretKind, version)
  const key = await importAesKey(dek, ['decrypt'])
  const plaintext = await aesGcmDecrypt(key, bundleCiphertext, iv, aad)
  return decodeBundle(plaintext)
}

export async function wrapDekWithPassword(dek: Uint8Array, password: string, iterations: number, identityId: string, vaultId: string): Promise<{ wrappedDek: Uint8Array; iv: Uint8Array; pbkdf2Salt: Uint8Array }> {
  const pbkdf2Salt = randomBytes(32)
  const wrappingKey = await derivePasswordWrappingKey(password, pbkdf2Salt, iterations)
  const aad = buildWrapperAad(identityId, vaultId, 'password', 1)
  const encrypted = await aesGcmEncrypt(wrappingKey, dek, aad)

  return {
    wrappedDek: encrypted.ciphertext,
    iv: encrypted.iv,
    pbkdf2Salt,
  }
}

export async function unwrapDekWithPassword(wrappedDek: Uint8Array, iv: Uint8Array, password: string, pbkdf2Salt: Uint8Array, iterations: number, identityId: string, vaultId: string): Promise<Uint8Array> {
  const wrappingKey = await derivePasswordWrappingKey(password, pbkdf2Salt, iterations)
  const aad = buildWrapperAad(identityId, vaultId, 'password', 1)
  return aesGcmDecrypt(wrappingKey, wrappedDek, iv, aad)
}

export async function wrapDekWithPrf(dek: Uint8Array, prfOutput: Uint8Array, identityId: string, vaultId: string, rpId: string): Promise<{ wrappedDek: Uint8Array; iv: Uint8Array }> {
  const wrappingKey = await derivePrfWrappingKey(prfOutput, identityId, vaultId, rpId)
  const aad = buildWrapperAad(identityId, vaultId, 'passkey-prf', 1, rpId)
  const encrypted = await aesGcmEncrypt(wrappingKey, dek, aad)

  return {
    wrappedDek: encrypted.ciphertext,
    iv: encrypted.iv,
  }
}

export async function unwrapDekWithPrf(wrappedDek: Uint8Array, iv: Uint8Array, prfOutput: Uint8Array, identityId: string, vaultId: string, rpId: string): Promise<Uint8Array> {
  const wrappingKey = await derivePrfWrappingKey(prfOutput, identityId, vaultId, rpId)
  const aad = buildWrapperAad(identityId, vaultId, 'passkey-prf', 1, rpId)
  return aesGcmDecrypt(wrappingKey, wrappedDek, iv, aad)
}
