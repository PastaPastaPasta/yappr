import { logger } from '@/lib/logger'
import { bytesToBase64, requireBytes } from '@/lib/bytes'
import { YAPPR_PASSKEY_VAULT_CONTRACT_ID } from '@/lib/constants'
import { VAULT_DOCUMENT_TYPE, type SealedVaultEntry } from '@/lib/crypto/passkey-vault'
import { BaseDocumentService } from './document-service'
import { stateTransitionService } from './state-transition-service'

/** A `vaultEntry` as read from chain (contracts/yappr-passkey-vault-contract.json). */
export interface VaultEntryDocument extends SealedVaultEntry {
  $id: string
  $ownerId: string
  $revision: number
  $createdAt: number
  $updatedAt: number
}

/** More than the cap: a list over it still shows every entry, so a planted one can be seen and removed. */
const LIST_LIMIT = 100

function numberField(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new Error(`vaultEntry: ${field} is not an integer`)
  return number
}

/**
 * The passkey vault's documents: one `vaultEntry` per passkey, written and
 * read only by its owner's session. Reads are never cached: an entry decides
 * a sign-in, and a stale list could hide one somebody else planted.
 */
class PasskeyVaultService extends BaseDocumentService<VaultEntryDocument> {
  constructor() {
    super(VAULT_DOCUMENT_TYPE, YAPPR_PASSKEY_VAULT_CONTRACT_ID)
  }

  protected transformDocument(doc: Record<string, unknown>): VaultEntryDocument {
    const id = doc.$id
    const ownerId = doc.$ownerId
    if (typeof id !== 'string' || typeof ownerId !== 'string') throw new Error('vaultEntry: missing $id or $ownerId')
    return {
      $id: id,
      $ownerId: ownerId,
      $revision: numberField(doc.$revision, '$revision'),
      $createdAt: numberField(doc.$createdAt, '$createdAt'),
      $updatedAt: numberField(doc.$updatedAt, '$updatedAt'),
      version: numberField(doc.version, 'version'),
      authKeyId: numberField(doc.authKeyId, 'authKeyId'),
      credentialId: requireBytes(doc.credentialId, 'credentialId'),
      recipientKey: requireBytes(doc.recipientKey, 'recipientKey'),
      enc: requireBytes(doc.enc, 'enc'),
      sealed: requireBytes(doc.sealed, 'sealed'),
    }
  }

  /** Every entry `ownerId` has, by credential id. Rejects when the read fails, so a failure never reads as "no passkeys". */
  async list(ownerId: string): Promise<VaultEntryDocument[]> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc'], ['credentialId', 'asc']],
      limit: LIST_LIMIT,
    })
    return documents
  }

  /** `ownerId`'s entry for one passkey, or null. A byte-array operand must be base64 (hex silently matches nothing). */
  async find(ownerId: string, credentialId: Uint8Array): Promise<VaultEntryDocument | null> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', ownerId], ['credentialId', '==', bytesToBase64(credentialId)]],
      limit: 1,
    })
    return documents[0] ?? null
  }

  private contentOf(entry: SealedVaultEntry): Record<string, unknown> {
    return {
      credentialId: entry.credentialId,
      recipientKey: entry.recipientKey,
      version: entry.version,
      authKeyId: entry.authKeyId,
      enc: entry.enc,
      sealed: entry.sealed,
    }
  }

  async add(ownerId: string, entry: SealedVaultEntry): Promise<void> {
    const result = await stateTransitionService.createDocument(this.contractId, this.documentType, ownerId, this.contentOf(entry))
    if (!result.success) throw new Error(result.error ?? 'The passkey could not be saved')
  }

  /** Re-seals an entry in place; its credential and recipient key cannot change (the contract makes them immutable). */
  async reseal(existing: VaultEntryDocument, entry: SealedVaultEntry): Promise<void> {
    const result = await stateTransitionService.updateDocument(
      this.contractId, this.documentType, existing.$id, existing.$ownerId, this.contentOf(entry), existing.$revision,
    )
    if (!result.success) throw new Error(result.error ?? 'The passkey could not be updated')
  }

  async remove(entry: Pick<VaultEntryDocument, '$id' | '$ownerId'>): Promise<void> {
    const result = await stateTransitionService.deleteDocument(this.contractId, this.documentType, entry.$id, entry.$ownerId)
    if (!result.success) {
      logger.warn('Passkey vault: removing an entry failed:', result.error)
      throw new Error(result.error ?? 'The passkey could not be removed')
    }
  }
}

export const passkeyVaultService = new PasskeyVaultService()
