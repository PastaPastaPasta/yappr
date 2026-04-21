'use client'

import { logger } from '@/lib/logger'
import { DOCUMENT_TYPES, YAPPR_AUTH_VAULT_CONTRACT_ID } from '@/lib/constants'
import { BaseDocumentService } from '@/lib/services/document-service'
import { type DocumentWhereClause, normalizeBytes, requireIdentifierBytes } from '@/lib/services/sdk-helpers'
import bs58 from 'bs58'

export type AuthVaultAccessKind = 'password' | 'passkey-prf'
export type AuthVaultAccessStatus = 'active' | 'revoked'

export interface AuthVaultAccessDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $revision: number
  vaultId: Uint8Array
  kind: AuthVaultAccessKind
  label: string
  status: AuthVaultAccessStatus
  wrappedDek: Uint8Array
  iv: Uint8Array
  kdfType: string
  pbkdf2Salt?: Uint8Array
  pbkdf2Iterations?: number
  credentialId?: Uint8Array
  credentialIdHash?: Uint8Array
  prfInput?: Uint8Array
  rpId?: string
}

export interface CreatePasswordAccessInput {
  vaultId: string
  label: string
  wrappedDek: Uint8Array
  iv: Uint8Array
  pbkdf2Salt: Uint8Array
  pbkdf2Iterations: number
}

export interface CreatePasskeyAccessInput {
  vaultId: string
  label: string
  wrappedDek: Uint8Array
  iv: Uint8Array
  credentialId: Uint8Array
  credentialIdHash: Uint8Array
  prfInput: Uint8Array
  rpId: string
}

class AuthVaultAccessService extends BaseDocumentService<AuthVaultAccessDocument> {
  constructor() {
    super(DOCUMENT_TYPES.AUTH_VAULT_ACCESS, YAPPR_AUTH_VAULT_CONTRACT_ID)
  }

  isConfigured(): boolean {
    return Boolean(YAPPR_AUTH_VAULT_CONTRACT_ID && !YAPPR_AUTH_VAULT_CONTRACT_ID.includes('PLACEHOLDER'))
  }

  protected transformDocument(doc: Record<string, unknown>): AuthVaultAccessDocument {
    const data = (doc.data || doc) as Record<string, unknown>

    return {
      $id: doc.$id as string,
      $ownerId: doc.$ownerId as string,
      $createdAt: (doc.$createdAt as number) ?? Date.now(),
      $revision: (doc.$revision as number) ?? 1,
      vaultId: normalizeBytes(data.vaultId) ?? new Uint8Array(),
      kind: (data.kind as AuthVaultAccessKind) ?? 'password',
      label: (data.label as string) ?? 'Access',
      status: (data.status as AuthVaultAccessStatus) ?? 'active',
      wrappedDek: normalizeBytes(data.wrappedDek) ?? new Uint8Array(),
      iv: normalizeBytes(data.iv) ?? new Uint8Array(),
      kdfType: (data.kdfType as string) ?? '',
      pbkdf2Salt: normalizeBytes(data.pbkdf2Salt) ?? undefined,
      pbkdf2Iterations: data.pbkdf2Iterations as number | undefined,
      credentialId: normalizeBytes(data.credentialId) ?? undefined,
      credentialIdHash: normalizeBytes(data.credentialIdHash) ?? undefined,
      prfInput: normalizeBytes(data.prfInput) ?? undefined,
      rpId: data.rpId as string | undefined,
    }
  }

  protected extractContentFields(doc: AuthVaultAccessDocument): Record<string, unknown> {
    const data: Record<string, unknown> = {
      vaultId: Array.from(doc.vaultId),
      kind: doc.kind,
      label: doc.label,
      status: doc.status,
      wrappedDek: Array.from(doc.wrappedDek),
      iv: Array.from(doc.iv),
      kdfType: doc.kdfType,
    }

    if (doc.pbkdf2Salt) data.pbkdf2Salt = Array.from(doc.pbkdf2Salt)
    if (doc.pbkdf2Iterations !== undefined) data.pbkdf2Iterations = doc.pbkdf2Iterations
    if (doc.credentialId) data.credentialId = Array.from(doc.credentialId)
    if (doc.credentialIdHash) data.credentialIdHash = Array.from(doc.credentialIdHash)
    if (doc.prfInput) data.prfInput = Array.from(doc.prfInput)
    if (doc.rpId) data.rpId = doc.rpId

    return data
  }

  async getActiveAccesses(identityId: string, kind?: AuthVaultAccessKind): Promise<AuthVaultAccessDocument[]> {
    if (!this.isConfigured()) return []

    try {
      const where: DocumentWhereClause[] = [['$ownerId', '==', identityId], ['status', '==', 'active']]
      if (kind) {
        where.unshift(['kind', '==', kind])
      }

      const result = await this.query({
        where,
        orderBy: [['$createdAt', 'desc']],
        limit: 100,
      })

      return result.documents
    } catch (error) {
      logger.error('AuthVaultAccessService: Failed to load access docs:', error)
      return []
    }
  }

  async getPasswordAccess(identityId: string): Promise<AuthVaultAccessDocument | null> {
    const documents = await this.getActiveAccesses(identityId, 'password')
    return documents[0] ?? null
  }

  async getPasskeyAccesses(identityId: string): Promise<AuthVaultAccessDocument[]> {
    return this.getActiveAccesses(identityId, 'passkey-prf')
  }

  async countActivePasskeys(identityId: string): Promise<number> {
    const documents = await this.getPasskeyAccesses(identityId)
    return documents.length
  }

  async upsertPasswordAccess(identityId: string, input: CreatePasswordAccessInput): Promise<AuthVaultAccessDocument> {
    if (!this.isConfigured()) {
      throw new Error('Auth vault access contract is not configured')
    }

    const existing = await this.getPasswordAccess(identityId)
    const data = {
      vaultId: Array.from(requireIdentifierBytes(input.vaultId, 'vaultId')),
      kind: 'password',
      label: input.label,
      status: 'active',
      wrappedDek: Array.from(input.wrappedDek),
      iv: Array.from(input.iv),
      kdfType: 'pbkdf2-sha256',
      pbkdf2Salt: Array.from(input.pbkdf2Salt),
      pbkdf2Iterations: input.pbkdf2Iterations,
    }

    if (existing) {
      return this.update(existing.$id, identityId, data)
    }

    return this.create(identityId, data)
  }

  async createPasskeyAccess(identityId: string, input: CreatePasskeyAccessInput): Promise<AuthVaultAccessDocument> {
    if (!this.isConfigured()) {
      throw new Error('Auth vault access contract is not configured')
    }

    return this.create(identityId, {
      vaultId: Array.from(requireIdentifierBytes(input.vaultId, 'vaultId')),
      kind: 'passkey-prf',
      label: input.label,
      status: 'active',
      wrappedDek: Array.from(input.wrappedDek),
      iv: Array.from(input.iv),
      kdfType: 'webauthn-prf-hkdf-sha256',
      credentialId: Array.from(input.credentialId),
      credentialIdHash: Array.from(input.credentialIdHash),
      prfInput: Array.from(input.prfInput),
      rpId: input.rpId,
    })
  }

  async revokeAccess(identityId: string, accessId: string): Promise<boolean> {
    const current = await this.get(accessId)
    if (!current) return false

    try {
      await this.update(accessId, identityId, {
        status: 'revoked',
      })
      return true
    } catch (error) {
      logger.error('AuthVaultAccessService: Failed to revoke access:', error)
      return false
    }
  }

  async deleteAllForOwner(identityId: string): Promise<boolean> {
    if (!this.isConfigured()) return false

    const allDocs = await this.query({
      where: [['$ownerId', '==', identityId]],
      limit: 100,
    })

    const results = await Promise.all(allDocs.documents.map((doc) => this.delete(doc.$id, identityId)))
    return results.every(Boolean)
  }

  getVaultIdAsString(document: AuthVaultAccessDocument): string | null {
    try {
      return document.vaultId.length === 32 ? bs58.encode(document.vaultId) : null
    } catch {
      return null
    }
  }
}

export const authVaultAccessService = new AuthVaultAccessService()
