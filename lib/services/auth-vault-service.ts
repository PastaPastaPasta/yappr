'use client'

import { logger } from '@/lib/logger'
import { DOCUMENT_TYPES, YAPPR_AUTH_VAULT_CONTRACT_ID } from '@/lib/constants'
import { BaseDocumentService } from '@/lib/services/document-service'
import { documentBuilderService } from '@/lib/services/document-builder-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { normalizeBytes } from '@/lib/services/sdk-helpers'
import {
  type AuthVaultBundle,
  type AuthVaultSecretKind,
  type AuthVaultSource,
  decryptBundle,
  encryptBundle,
  generateDek,
  unwrapDekWithPassword,
  unwrapDekWithPrf,
} from '@/lib/crypto/auth-vault'
import {
  authVaultAccessService,
  type AuthVaultAccessDocument,
} from '@/lib/services/auth-vault-access-service'
import { decodeBinaryFromBase64, encodeBinaryToBase64 } from '@/lib/crypto/auth-vault'

export interface AuthVaultDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $revision: number
  version: number
  secretKind: AuthVaultSecretKind
  ciphertext: Uint8Array
  iv: Uint8Array
  bundleHash: Uint8Array
  updatedAt: number
  active: boolean
}

export interface AuthVaultUnlockResult {
  identityId: string
  vault: AuthVaultDocument
  bundle: AuthVaultBundle
  dek: Uint8Array
  access?: AuthVaultAccessDocument
}

export interface AuthVaultStatus {
  configured: boolean
  hasVault: boolean
  secretKind?: AuthVaultSecretKind
  hasPasswordAccess: boolean
  passkeyCount: number
  hasEncryptionKey: boolean
  hasTransferKey: boolean
  updatedAt?: number
}

export interface MergeSecretsInput {
  loginKey?: Uint8Array | string
  authKeyWif?: string
  encryptionKeyWif?: string
  transferKeyWif?: string
  source?: AuthVaultSource
}

const DEFAULT_VERSION = 1

function isIdentityId(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{42,46}$/.test(input.trim())
}

function toDocumentBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function stringOrUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

function normalizeLoginKey(value?: Uint8Array | string): string | undefined {
  if (!value) return undefined
  return typeof value === 'string' ? value : encodeBinaryToBase64(value)
}

class AuthVaultService extends BaseDocumentService<AuthVaultDocument> {
  constructor() {
    super(DOCUMENT_TYPES.AUTH_VAULT, YAPPR_AUTH_VAULT_CONTRACT_ID)
  }

  isConfigured(): boolean {
    return Boolean(YAPPR_AUTH_VAULT_CONTRACT_ID && !YAPPR_AUTH_VAULT_CONTRACT_ID.includes('PLACEHOLDER'))
  }

  protected transformDocument(doc: Record<string, unknown>): AuthVaultDocument {
    const data = (doc.data || doc) as Record<string, unknown>

    return {
      $id: doc.$id as string,
      $ownerId: doc.$ownerId as string,
      $createdAt: (doc.$createdAt as number) ?? Date.now(),
      $revision: (doc.$revision as number) ?? 1,
      version: (data.version as number) ?? DEFAULT_VERSION,
      secretKind: (data.secretKind as AuthVaultSecretKind) ?? 'auth-key',
      ciphertext: normalizeBytes(data.ciphertext) ?? new Uint8Array(),
      iv: normalizeBytes(data.iv) ?? new Uint8Array(),
      bundleHash: normalizeBytes(data.bundleHash) ?? new Uint8Array(),
      updatedAt: (data.updatedAt as number) ?? 0,
      active: (data.active as boolean) ?? true,
    }
  }

  protected extractContentFields(doc: AuthVaultDocument): Record<string, unknown> {
    return {
      version: doc.version,
      secretKind: doc.secretKind,
      ciphertext: toDocumentBytes(doc.ciphertext),
      iv: toDocumentBytes(doc.iv),
      bundleHash: toDocumentBytes(doc.bundleHash),
      updatedAt: doc.updatedAt,
      active: doc.active,
    }
  }

  async resolveIdentityId(identityOrUsername: string): Promise<string | null> {
    const normalized = identityOrUsername.trim()
    if (!normalized) return null
    if (isIdentityId(normalized)) return normalized
    return dpnsService.resolveIdentity(normalized)
  }

  async getVault(identityId: string): Promise<AuthVaultDocument | null> {
    if (!this.isConfigured()) return null

    try {
      const result = await this.query({
        where: [['$ownerId', '==', identityId]],
        limit: 1,
      })
      return result.documents[0] ?? null
    } catch (error) {
      logger.error('AuthVaultService: Failed to get auth vault:', error)
      return null
    }
  }

  async hasVault(identityId: string): Promise<boolean> {
    const vault = await this.getVault(identityId)
    return Boolean(vault?.active)
  }

  async createOrUpdateVaultBundle(identityId: string, bundle: AuthVaultBundle, dek = generateDek()): Promise<AuthVaultUnlockResult> {
    if (!this.isConfigured()) {
      throw new Error('Auth vault contract is not configured')
    }

    const existing = await this.getVault(identityId)
    const activeBundle: AuthVaultBundle = {
      ...bundle,
      version: DEFAULT_VERSION,
      updatedAt: Date.now(),
    }

    let vault = existing
    if (!vault) {
      const { id: vaultId, entropy } = await documentBuilderService.generateDocumentIdentity(
        this.contractId,
        this.documentType,
        identityId,
      )
      const encrypted = await encryptBundle(activeBundle, dek, vaultId)

      vault = await this.createWithOptions(identityId, {
        version: DEFAULT_VERSION,
        secretKind: activeBundle.secretKind,
        ciphertext: toDocumentBytes(encrypted.ciphertext),
        iv: toDocumentBytes(encrypted.iv),
        bundleHash: toDocumentBytes(encrypted.bundleHash),
        updatedAt: activeBundle.updatedAt,
        active: true,
      }, {
        documentId: vaultId,
        entropy,
      })

      return {
        identityId,
        vault,
        bundle: activeBundle,
        dek,
      }
    }

    const encrypted = await encryptBundle(activeBundle, dek, vault.$id)
    const updated = await this.update(vault.$id, identityId, {
      version: DEFAULT_VERSION,
      secretKind: activeBundle.secretKind,
      ciphertext: toDocumentBytes(encrypted.ciphertext),
      iv: toDocumentBytes(encrypted.iv),
      bundleHash: toDocumentBytes(encrypted.bundleHash),
      updatedAt: activeBundle.updatedAt,
      active: true,
    })

    return {
      identityId,
      vault: updated,
      bundle: activeBundle,
      dek,
    }
  }

  async decryptVault(identityId: string, dek: Uint8Array): Promise<AuthVaultUnlockResult> {
    const vault = await this.getVault(identityId)
    if (!vault) {
      throw new Error('No auth vault found')
    }

    const bundle = await decryptBundle(
      vault.ciphertext,
      vault.iv,
      dek,
      vault.$id,
      identityId,
      vault.secretKind,
      vault.version,
    )

    return {
      identityId,
      vault,
      bundle,
      dek,
    }
  }

  async unlockWithPassword(identityOrUsername: string, password: string): Promise<AuthVaultUnlockResult> {
    if (!this.isConfigured()) {
      throw new Error('Auth vault contract is not configured')
    }

    const identityId = await this.resolveIdentityId(identityOrUsername)
    if (!identityId) {
      throw new Error('Username not found')
    }

    const vault = await this.getVault(identityId)
    if (!vault) {
      throw new Error('No auth vault found')
    }

    const access = await authVaultAccessService.getPasswordAccess(identityId)
    if (!access?.pbkdf2Salt || !access?.pbkdf2Iterations) {
      throw new Error('No password access configured')
    }

    let dek: Uint8Array
    try {
      dek = await unwrapDekWithPassword(
        access.wrappedDek,
        access.iv,
        password,
        access.pbkdf2Salt,
        access.pbkdf2Iterations,
        identityId,
        vault.$id,
      )
    } catch {
      throw new Error('Invalid password')
    }

    try {
      const bundle = await decryptBundle(
        vault.ciphertext,
        vault.iv,
        dek,
        vault.$id,
        identityId,
        vault.secretKind,
        vault.version,
      )
      return { identityId, vault, bundle, dek, access }
    } catch (error) {
      logger.error('AuthVaultService: Password unlock failed during bundle decrypt:', error)
      throw new Error('Failed to decrypt auth vault')
    }
  }

  async unlockWithPrf(identityId: string, access: AuthVaultAccessDocument, prfOutput: Uint8Array): Promise<AuthVaultUnlockResult> {
    const vault = await this.getVault(identityId)
    if (!vault) {
      throw new Error('No auth vault found')
    }

    if (!access.rpId) {
      throw new Error('Passkey record is missing rpId')
    }

    const dek = await unwrapDekWithPrf(
      access.wrappedDek,
      access.iv,
      prfOutput,
      identityId,
      vault.$id,
      access.rpId,
    )

    const bundle = await decryptBundle(
      vault.ciphertext,
      vault.iv,
      dek,
      vault.$id,
      identityId,
      vault.secretKind,
      vault.version,
    )

    return {
      identityId,
      vault,
      bundle,
      dek,
      access,
    }
  }

  async mergeSecrets(identityId: string, dek: Uint8Array, partialSecrets: MergeSecretsInput): Promise<AuthVaultUnlockResult | null> {
    const current = await this.decryptVault(identityId, dek).catch(() => null)
    if (!current) {
      return null
    }

    const nextBundle = mergeBundle(current.bundle, partialSecrets)
    if (!nextBundle) {
      return current
    }

    return this.createOrUpdateVaultBundle(identityId, nextBundle, dek)
  }

  async deleteVault(identityId: string): Promise<boolean> {
    if (!this.isConfigured()) return false

    const vault = await this.getVault(identityId)
    if (!vault) return true

    const accessDeleted = await authVaultAccessService.deleteAllForOwner(identityId)
    const vaultDeleted = await this.delete(vault.$id, identityId)
    return accessDeleted && vaultDeleted
  }

  async getStatus(identityId: string): Promise<AuthVaultStatus> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        hasVault: false,
        hasPasswordAccess: false,
        passkeyCount: 0,
        hasEncryptionKey: false,
        hasTransferKey: false,
      }
    }

    const vault = await this.getVault(identityId)
    const passwordAccess = await authVaultAccessService.getPasswordAccess(identityId)
    const passkeys = await authVaultAccessService.getPasskeyAccesses(identityId)

    if (!vault) {
      return {
        configured: true,
        hasVault: false,
        hasPasswordAccess: false,
        passkeyCount: passkeys.length,
        hasEncryptionKey: false,
        hasTransferKey: false,
      }
    }

    return {
      configured: true,
      hasVault: true,
      secretKind: vault.secretKind,
      hasPasswordAccess: Boolean(passwordAccess),
      passkeyCount: passkeys.length,
      hasEncryptionKey: false,
      hasTransferKey: false,
      updatedAt: vault.updatedAt,
    }
  }
}

function mergeBundle(current: AuthVaultBundle, partialSecrets: MergeSecretsInput): AuthVaultBundle | null {
  const normalizedLoginKey = normalizeLoginKey(partialSecrets.loginKey)

  const next: AuthVaultBundle = {
    ...current,
  }

  let changed = false

  if (normalizedLoginKey && current.loginKey !== normalizedLoginKey) {
    next.loginKey = normalizedLoginKey
    next.secretKind = 'login-key'
    changed = true
  }

  if (partialSecrets.authKeyWif && !current.authKeyWif) {
    next.authKeyWif = partialSecrets.authKeyWif
    changed = true
  }

  if (partialSecrets.encryptionKeyWif) {
    const existing = stringOrUndefined(current.encryptionKeyWif)
    if (existing && existing !== partialSecrets.encryptionKeyWif) {
      throw new Error('Auth vault already contains a different encryption key')
    }
    if (!existing) {
      next.encryptionKeyWif = partialSecrets.encryptionKeyWif
      changed = true
    }
  }

  if (partialSecrets.transferKeyWif) {
    const existing = stringOrUndefined(current.transferKeyWif)
    if (existing && existing !== partialSecrets.transferKeyWif) {
      throw new Error('Auth vault already contains a different transfer key')
    }
    if (!existing) {
      next.transferKeyWif = partialSecrets.transferKeyWif
      changed = true
    }
  }

  if (partialSecrets.source) {
    const nextSource = current.source === partialSecrets.source
      ? current.source
      : current.source && partialSecrets.source && current.source !== partialSecrets.source
        ? 'mixed'
        : partialSecrets.source

    if (nextSource !== current.source) {
      next.source = nextSource
      changed = true
    }
  }

  if (!changed) {
    return null
  }

  next.updatedAt = Date.now()

  if (next.secretKind === 'login-key' && !next.loginKey) {
    next.loginKey = current.loginKey
  }

  return next
}

export function createAuthVaultBundle(params: {
  identityId: string
  network: 'testnet' | 'mainnet'
  source: AuthVaultSource
  loginKey?: Uint8Array | string
  authKeyWif?: string
  encryptionKeyWif?: string
  transferKeyWif?: string
}): AuthVaultBundle {
  const loginKey = normalizeLoginKey(params.loginKey)
  const secretKind: AuthVaultSecretKind = loginKey ? 'login-key' : 'auth-key'

  return {
    version: DEFAULT_VERSION,
    identityId: params.identityId,
    network: params.network,
    secretKind,
    loginKey,
    authKeyWif: params.authKeyWif,
    encryptionKeyWif: params.encryptionKeyWif,
    transferKeyWif: params.transferKeyWif,
    source: params.source,
    updatedAt: Date.now(),
  }
}

export function getLoginKeyBytesFromBundle(bundle: AuthVaultBundle): Uint8Array | null {
  return bundle.loginKey ? decodeBinaryFromBase64(bundle.loginKey) : null
}

export function bundleContainsSecondaryKeys(bundle: AuthVaultBundle): { hasEncryptionKey: boolean; hasTransferKey: boolean } {
  return {
    hasEncryptionKey: Boolean(bundle.encryptionKeyWif),
    hasTransferKey: Boolean(bundle.transferKeyWif),
  }
}

export const authVaultService = new AuthVaultService()
