import { sha256 } from '@noble/hashes/sha2.js'
import { aesGcmOpen, aesGcmSeal, deriveKeyFromPasswordAndSalt, deriveKeyWithHkdf, importAesKey, type AesGcmSealed } from './aes-gcm'

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

const BUNDLE_INFO = 'yappr/auth-vault/bundle/v1'
const PRF_WRAP_INFO = 'yappr/auth-vault/dek-wrap/prf/v1'

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
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

async function derivePrfWrappingKey(prfOutput: Uint8Array, identityId: string, vaultId: string, rpId: string): Promise<CryptoKey> {
  return deriveKeyWithHkdf(prfOutput, buildPrfSalt(identityId, vaultId, rpId), utf8(PRF_WRAP_INFO))
}

export function generateDek(): Uint8Array {
  return randomBytes(32)
}


export async function encryptBundle(bundle: AuthVaultBundle, dek: Uint8Array, vaultId: string): Promise<AesGcmSealed & { bundleHash: Uint8Array }> {
  const aad = buildBundleAad(bundle.identityId, vaultId, bundle.secretKind, bundle.version)
  const key = await importAesKey(dek, ['encrypt'])
  const plaintext = encodeBundle(bundle)
  const result = await aesGcmSeal(key, plaintext, { aad })

  return {
    ...result,
    bundleHash: sha256(plaintext),
  }
}

export async function decryptBundle(bundleCiphertext: Uint8Array, iv: Uint8Array, dek: Uint8Array, vaultId: string, identityId: string, secretKind: AuthVaultSecretKind, version: number): Promise<AuthVaultBundle> {
  const aad = buildBundleAad(identityId, vaultId, secretKind, version)
  const key = await importAesKey(dek, ['decrypt'])
  const plaintext = await aesGcmOpen(key, bundleCiphertext, iv, aad)
  return decodeBundle(plaintext)
}

export async function wrapDekWithPassword(dek: Uint8Array, password: string, iterations: number, identityId: string, vaultId: string): Promise<{ wrappedDek: Uint8Array; iv: Uint8Array; pbkdf2Salt: Uint8Array }> {
  const pbkdf2Salt = randomBytes(32)
  const wrappingKey = await deriveKeyFromPasswordAndSalt(password, pbkdf2Salt, iterations)
  const aad = buildWrapperAad(identityId, vaultId, 'password', 1)
  const encrypted = await aesGcmSeal(wrappingKey, dek, { aad })

  return {
    wrappedDek: encrypted.ciphertext,
    iv: encrypted.iv,
    pbkdf2Salt,
  }
}

export async function unwrapDekWithPassword(wrappedDek: Uint8Array, iv: Uint8Array, password: string, pbkdf2Salt: Uint8Array, iterations: number, identityId: string, vaultId: string): Promise<Uint8Array> {
  const wrappingKey = await deriveKeyFromPasswordAndSalt(password, pbkdf2Salt, iterations)
  const aad = buildWrapperAad(identityId, vaultId, 'password', 1)
  return aesGcmOpen(wrappingKey, wrappedDek, iv, aad)
}

export async function wrapDekWithPrf(dek: Uint8Array, prfOutput: Uint8Array, identityId: string, vaultId: string, rpId: string): Promise<{ wrappedDek: Uint8Array; iv: Uint8Array }> {
  const wrappingKey = await derivePrfWrappingKey(prfOutput, identityId, vaultId, rpId)
  const aad = buildWrapperAad(identityId, vaultId, 'passkey-prf', 1, rpId)
  const encrypted = await aesGcmSeal(wrappingKey, dek, { aad })

  return {
    wrappedDek: encrypted.ciphertext,
    iv: encrypted.iv,
  }
}

export async function unwrapDekWithPrf(wrappedDek: Uint8Array, iv: Uint8Array, prfOutput: Uint8Array, identityId: string, vaultId: string, rpId: string): Promise<Uint8Array> {
  const wrappingKey = await derivePrfWrappingKey(prfOutput, identityId, vaultId, rpId)
  const aad = buildWrapperAad(identityId, vaultId, 'passkey-prf', 1, rpId)
  return aesGcmOpen(wrappingKey, wrappedDek, iv, aad)
}
