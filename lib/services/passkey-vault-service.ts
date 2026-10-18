import { logger } from '@/lib/logger'
import { bytesEqual, requireBytes } from '@/lib/bytes'
import { YAPPR_PASSKEY_VAULT_CONTRACT_ID } from '@/lib/constants'
import { VAULT_DOCUMENT_TYPE, type SealedVaultEntry } from '@/lib/crypto/passkey-vault'
import { BaseDocumentService } from './document-service'
import { bytesToBase64QueryOperand } from './sdk-helpers'
import { stateTransitionService, type CreateReceipt, type StateTransitionResult } from './state-transition-service'

/** A `vaultEntry` as read from chain (contracts/yappr-passkey-vault-contract.json). */
export interface VaultEntryDocument extends SealedVaultEntry {
  $id: string
  $ownerId: string
  $revision: number
  $createdAt: number
  $updatedAt: number
}

/**
 * Far over the 10-passkey cap. The list walks every page up to here, so
 * "Remove all" and the review see entries somebody else planted too.
 */
const LIST_LIMIT = 1000

function numberField(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new Error(`vaultEntry: ${field} is not an integer`)
  return number
}

function contentOf(entry: SealedVaultEntry): Record<string, unknown> {
  return {
    credentialId: entry.credentialId,
    recipientKey: entry.recipientKey,
    version: entry.version,
    authKeyId: entry.authKeyId,
    enc: entry.enc,
    sealed: entry.sealed,
  }
}

function assertWritten(result: StateTransitionResult, fallback: string): void {
  if (result.success) return
  logger.warn(`Passkey vault: ${fallback}:`, result.error)
  throw new Error(result.error ?? fallback)
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

  /**
   * Every entry `ownerId` has, by credential id. Rejects when the read fails,
   * so a failure never reads as "no passkeys", and when there are more than
   * it walks, so no list is ever silently partial. Removal passes `partial`:
   * it deletes what it read and reads again, so a flood of planted entries
   * cannot block it.
   */
  async list(ownerId: string, options: { partial?: boolean } = {}): Promise<VaultEntryDocument[]> {
    const { documents, reachedLimit } = await this.queryAll({
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc'], ['credentialId', 'asc']],
    }, LIST_LIMIT)
    if (reachedLimit && !options.partial) throw new Error(`more than ${LIST_LIMIT} passkey entries`)
    return documents.filter((entry) => entry.$ownerId === ownerId)
  }

  /** `ownerId`'s entry for one passkey, or null. */
  async find(ownerId: string, credentialId: Uint8Array): Promise<VaultEntryDocument | null> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', ownerId], ['credentialId', '==', bytesToBase64QueryOperand(credentialId)]],
      limit: 1,
    })
    const entry = documents[0]
    return entry && entry.$ownerId === ownerId && bytesEqual(entry.credentialId, credentialId) ? entry : null
  }

/**
   * Writes a new entry. Unconfirmed when it was sent but Platform has not
   * confirmed it yet (it may still land); its receipt settles it ({@link settleAdd}).
   */
  async add(ownerId: string, entry: SealedVaultEntry): Promise<{ confirmed: true } | { confirmed: false; receipt?: CreateReceipt }> {
    const result = await stateTransitionService.createDocument(this.contractId, this.documentType, ownerId, contentOf(entry))
    assertWritten(result, 'the passkey could not be saved')
    return result.confirmed === false ? { confirmed: false, receipt: result.receipt } : { confirmed: true }
  }

  /** Settles an unconfirmed {@link add}: `landed`, `not-recorded` (proved it never will), or null while unknown. */
  settleAdd(receipt: CreateReceipt): Promise<'landed' | 'not-recorded' | null> {
    return stateTransitionService.settleCreate(receipt)
  }

  /** Re-seals an entry in place; its credential and recipient key cannot change (the contract makes them immutable). */
  async reseal(existing: VaultEntryDocument, entry: SealedVaultEntry): Promise<void> {
    assertWritten(await stateTransitionService.updateDocument(
      this.contractId, this.documentType, existing.$id, existing.$ownerId, contentOf(entry), existing.$revision,
    ), 'the passkey could not be updated')
  }

  async remove(entry: Pick<VaultEntryDocument, '$id' | '$ownerId'>): Promise<void> {
    assertWritten(await stateTransitionService.deleteDocument(this.contractId, this.documentType, entry.$id, entry.$ownerId), 'the passkey could not be removed')
  }
}

export const passkeyVaultService = new PasskeyVaultService()
