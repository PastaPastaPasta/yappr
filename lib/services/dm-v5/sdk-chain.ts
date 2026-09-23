/**
 * The DM v5 chain adapter: the ONLY module under lib/services/dm-v5/ that
 * touches the SDK. Query shapes are the ones docs/evidence/dm-v5-battery.json
 * proved on moutai: every `in` carries an orderBy on its `in` field, the
 * invite scan orders by [bucket, $createdAt] and so returns bucket by bucket,
 * and pages continue with `startAfter` = the last document id.
 *
 * Reads go through `queryWithProof` so the response metadata's block time can
 * drive `now()` (§4.1: weeks come from Platform block time, never the device
 * clock).
 */

import bs58 from 'bs58'
import { Identifier } from '@dashevo/evo-sdk'
import { logger } from '@/lib/logger'
import { YAPPR_DM_V5_CONTRACT_ID } from '@/lib/constants'
import { normalizeBytes } from '@/lib/bytes'
import { KeyType } from '@/lib/crypto/identity-keys'
import { findEncryptionKey } from '@/lib/crypto/encryption-key-lookup'
import { extractErrorMessage, isTimeoutError } from '@/lib/error-utils'
import type { SelfStateFields } from '@/lib/dm/self-state'
import type { DmInvite, IdentityId } from '@/lib/dm/types'
import { hasPrivateKey } from '@/lib/secure-storage'
import { getEvoSdk } from '../evo-sdk-service'
import { stateTransitionService, type StateTransitionResult } from '../state-transition-service'
import { identityService } from '../identity-service'
import { followService } from '../follow-service'
import { bytesToBase64QueryOperand, documentToPlainObject, type DocumentWhereClause, type DocumentOrderByClause } from '../sdk-helpers'
import { chunk } from '../pagination-utils'
import { classifyWriteFailure } from './write-failure'
import type {
  ChainGroupDoc,
  ChainInvite,
  ChainMessage,
  ChainSelfState,
  DmChain,
  InvitePage,
  WriteOutcome,
} from './types'

const PAGE = 100
const ENCRYPTION_KEY_LENGTH = 33

type Raw = Record<string, unknown>

interface Query {
  documentTypeName: string
  where: DocumentWhereClause[]
  orderBy?: DocumentOrderByClause[]
  limit?: number
  startAfter?: string
}

function bytesField(doc: Raw, field: string): Uint8Array {
  const bytes = normalizeBytes(doc[field])
  if (!bytes) throw new Error(`Document ${String(doc.$id)} has no ${field}`)
  return bytes
}

function optionalBytes(doc: Raw, field: string): Uint8Array | null {
  const value = doc[field]
  return value === undefined || value === null ? null : normalizeBytes(value)
}

function base(doc: Raw) {
  return {
    id: String(doc.$id),
    ownerId: bs58.decode(String(doc.$ownerId)),
    createdAt: Number(doc.$createdAt ?? 0),
  }
}

function fromResult(result: StateTransitionResult): WriteOutcome {
  if (result.success) {
    return { ok: true, id: String(result.document?.$id ?? result.transactionHash ?? ''), confirmed: result.confirmed !== false }
  }
  const error = result.error ?? 'Unknown error'
  return { ok: false, failure: classifyWriteFailure(error), error }
}

/**
 * A replace whose confirmation timed out may still land (the DAPI 504 quirk),
 * so it is reported as unconfirmed rather than refused: the caller re-reads
 * the revision before its next replace.
 */
function fromReplace(result: StateTransitionResult, id: string): WriteOutcome {
  if (!result.success && result.error && isTimeoutError(result.error)) return { ok: true, id, confirmed: false }
  return fromResult(result)
}

/** Only the fields in use: an absent `blob2`/`blob3` must be written as absent (lib/dm/self-state.ts). */
function selfStateData(fields: SelfStateFields): Record<string, unknown> {
  return {
    blob: fields.blob,
    ...(fields.blob2 ? { blob2: fields.blob2 } : {}),
    ...(fields.blob3 ? { blob3: fields.blob3 } : {}),
  }
}

/** A follow list for recovery, or nothing when it cannot be read. */
function orEmpty<T>(list: Promise<T[]>, label: string): Promise<T[]> {
  return list.catch((error: unknown) => {
    logger.warn(`DM v5 recovery: ${label} unavailable:`, extractErrorMessage(error))
    return []
  })
}

export class SdkDmChain implements DmChain {
  private blockTime = 0
  private readonly me: string

  constructor(me: IdentityId, private readonly contractId = YAPPR_DM_V5_CONTRACT_ID) {
    this.me = bs58.encode(me)
  }

  now(): number {
    return this.blockTime || Date.now()
  }

  private async query(query: Query): Promise<Raw[]> {
    const sdk = await getEvoSdk()
    const response = await sdk.documents.queryWithProof({ dataContractId: this.contractId, ...query })
    const time = Number(response.metadata.timeMs)
    if (Number.isFinite(time) && time > this.blockTime) this.blockTime = time
    return Array.from(response.data.values())
      .filter((doc) => doc !== undefined)
      .map((doc) => documentToPlainObject(doc))
  }

  /** Every page of `query`, continuing after the last document id. */
  private async queryAll(query: Query): Promise<Raw[]> {
    const out: Raw[] = []
    let startAfter: string | undefined
    for (;;) {
      const page = await this.query({ ...query, limit: PAGE, ...(startAfter ? { startAfter } : {}) })
      out.push(...page)
      if (page.length < PAGE) return out
      startAfter = String(page[page.length - 1].$id)
    }
  }

  async messagesByTags(tags: Uint8Array[]): Promise<ChainMessage[]> {
    const pages = await Promise.all(
      chunk(tags, PAGE).map((batch) =>
        this.query({
          documentTypeName: 'dmMessage',
          where: [['tag', 'in', batch.map(bytesToBase64QueryOperand)]],
          orderBy: [['tag', 'asc']],
          limit: PAGE,
        })
      )
    )
    return pages.flat().map((doc) => ({ ...base(doc), tag: bytesField(doc, 'tag'), body: bytesField(doc, 'body') }))
  }

  private toInvite(doc: Raw): ChainInvite {
    return { ...base(doc), bucket: Number(doc.bucket), epk: bytesField(doc, 'epk'), check: bytesField(doc, 'check') }
  }

  async invitesSince(buckets: number[], since: number): Promise<ChainInvite[]> {
    const docs = await this.queryAll({
      documentTypeName: 'dmInvite',
      where: [['bucket', 'in', buckets], ['$createdAt', '>=', since]],
      orderBy: [['bucket', 'asc'], ['$createdAt', 'asc']],
    })
    return docs.map((doc) => this.toInvite(doc))
  }

  async invitesNewestFirst(bucket: number, startAfter: string | null): Promise<InvitePage> {
    const docs = await this.query({
      documentTypeName: 'dmInvite',
      where: [['bucket', '==', bucket]],
      orderBy: [['$createdAt', 'desc']],
      limit: PAGE,
      ...(startAfter ? { startAfter } : {}),
    })
    return { docs: docs.map((doc) => this.toInvite(doc)), next: docs.length < PAGE ? null : String(docs[docs.length - 1].$id) }
  }

  async groupDocs(owner: IdentityId, handles: Uint8Array[]): Promise<ChainGroupDoc[]> {
    const pages = await Promise.all(
      chunk(handles, PAGE).map((batch) =>
        this.query({
          documentTypeName: 'dmGroupDoc',
          where: [['$ownerId', '==', bs58.encode(owner)], ['handle', 'in', batch.map(bytesToBase64QueryOperand)]],
          orderBy: [['handle', 'asc']],
          limit: PAGE,
        })
      )
    )
    return pages.flat().map((doc) => ({
      ...base(doc),
      handle: bytesField(doc, 'handle'),
      blob: bytesField(doc, 'blob'),
      revision: Number(doc.$revision ?? 1),
      updatedAt: Number(doc.$updatedAt ?? doc.$createdAt ?? 0),
    }))
  }

  async selfState(): Promise<ChainSelfState | null> {
    const [doc] = await this.query({ documentTypeName: 'dmSelfState', where: [['$ownerId', '==', this.me]], limit: 1 })
    if (!doc) return null
    return {
      id: String(doc.$id),
      revision: Number(doc.$revision ?? 1),
      fields: { blob: bytesField(doc, 'blob'), blob2: optionalBytes(doc, 'blob2'), blob3: optionalBytes(doc, 'blob3') },
    }
  }

  async hasWritten(): Promise<boolean> {
    const sdk = await getEvoSdk()
    const nonce = await sdk.identities.contractNonce(this.me, this.contractId)
    return nonce !== undefined && nonce > BigInt(0)
  }

  canWrite(): boolean {
    return hasPrivateKey(this.me)
  }

  /**
   * After a nonce clash, drop the SDK's cached identity nonce, so a retry
   * signs with a fresh one. Creates read the nonce anew each time, but
   * replaces and deletes go through the SDK's own cache.
   */
  private async afterWrite(outcome: WriteOutcome): Promise<WriteOutcome> {
    if (!outcome.ok && outcome.failure === 'nonce') {
      try {
        const sdk = await getEvoSdk()
        await sdk.wasm.refreshIdentityNonce(new Identifier(this.me))
      } catch (error) {
        logger.debug('DM v5: identity nonce refresh failed:', error)
      }
    }
    return outcome
  }

  private create(type: string, data: Record<string, unknown>): Promise<WriteOutcome> {
    return stateTransitionService.createDocument(this.contractId, type, this.me, data).then(fromResult).then((o) => this.afterWrite(o))
  }

  createMessage(tag: Uint8Array, body: Uint8Array): Promise<WriteOutcome> {
    return this.create('dmMessage', { tag, body })
  }

  async deleteMessage(id: string): Promise<WriteOutcome> {
    return this.afterWrite(fromResult(await stateTransitionService.deleteDocument(this.contractId, 'dmMessage', id, this.me)))
  }

  createInvite(invite: DmInvite): Promise<WriteOutcome> {
    return this.create('dmInvite', { bucket: invite.bucket, epk: invite.epk, check: invite.check })
  }

  createGroupDoc(handle: Uint8Array, blob: Uint8Array): Promise<WriteOutcome> {
    return this.create('dmGroupDoc', { handle, blob })
  }

  async replaceGroupDoc(doc: { id: string; revision: number }, handle: Uint8Array, blob: Uint8Array): Promise<WriteOutcome> {
    const result = await stateTransitionService.updateDocument(this.contractId, 'dmGroupDoc', doc.id, this.me, { handle, blob }, doc.revision)
    return this.afterWrite(fromReplace(result, doc.id))
  }

  createSelfState(fields: SelfStateFields): Promise<WriteOutcome> {
    return this.create('dmSelfState', selfStateData(fields))
  }

  async replaceSelfState(doc: { id: string; revision: number }, fields: SelfStateFields): Promise<WriteOutcome> {
    const result = await stateTransitionService.updateDocument(this.contractId, 'dmSelfState', doc.id, this.me, selfStateData(fields), doc.revision)
    return this.afterWrite(fromReplace(result, doc.id))
  }

  async encryptionKey(identity: IdentityId): Promise<Uint8Array | null> {
    const info = await identityService.getIdentity(bs58.encode(identity))
    if (!info) return null
    const key = findEncryptionKey(info.publicKeys)
    if (!key || key.type !== KeyType.ECDSA_SECP256K1) return null
    const bytes = normalizeBytes(key.data)
    return bytes?.length === ENCRYPTION_KEY_LENGTH ? bytes : null
  }

  async contacts(): Promise<IdentityId[]> {
    const [followers, following] = await Promise.all([
      orEmpty(followService.getFollowers(this.me), 'followers'),
      orEmpty(followService.getFollowing(this.me), 'following'),
    ])
    const ids = new Set([...followers.map((f) => f.$ownerId), ...following.map((f) => f.followingId)])
    ids.delete(this.me)
    return Array.from(ids).filter(Boolean).map((id) => bs58.decode(id))
  }
}
