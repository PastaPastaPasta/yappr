/**
 * DM v5 client types (docs/DM_V5.md). Everything under lib/services/dm-v5/
 * talks to Platform only through a {@link DmChain}; the one SDK-backed
 * implementation is `sdk-chain.ts`, and tests use an in-memory one.
 *
 * Identity ids are raw 32-byte arrays here, as in lib/dm. Base58 strings exist
 * only at the UI boundary (`engine.ts` views) and inside the SDK adapter.
 */

import type { SelfStateFields } from '@/lib/dm/self-state'
import type { DmInvite, IdentityId } from '@/lib/dm/types'

/** System fields every v5 document read carries. `createdAt` is the Platform block time in ms. */
export interface ChainDoc {
  id: string
  ownerId: IdentityId
  createdAt: number
}

export interface ChainMessage extends ChainDoc {
  tag: Uint8Array
  body: Uint8Array
}

export interface ChainInvite extends ChainDoc, DmInvite {}

export interface ChainGroupDoc extends ChainDoc {
  handle: Uint8Array
  blob: Uint8Array
  revision: number
  updatedAt: number
}

export interface ChainSelfState {
  id: string
  revision: number
  fields: SelfStateFields
}

/**
 * Why a write was refused. `duplicate` is a unique-index collision (40105: a
 * taken tag, handle or self-state slot), `stale` a replace built on an old
 * revision (40106), `nonce` an identity-contract nonce another device of the
 * same identity used first (nothing written; retry). `transport` is a failure
 * to reach or hear from the network (a dead connection, stale quorums, a
 * gateway error): nothing is known to have been refused, so a retry may help.
 * Everything else (`other`) is a real refusal, such as too few credits, and
 * retrying it only burns fees.
 */
export type WriteFailure = 'duplicate' | 'stale' | 'nonce' | 'transport' | 'other'

export type WriteOutcome =
  /** `confirmed: false` means the broadcast went out but its execution was never proved (DAPI timeout). */
  | { ok: true; id: string; confirmed: boolean }
  | { ok: false; failure: WriteFailure; error: string }

/** One page of a newest-first invite scan; `next` continues it. */
export interface InvitePage {
  docs: ChainInvite[]
  next: string | null
}

/**
 * Everything DM v5 needs from Platform, for one signed-in identity: reads are
 * proved queries, writes are signed by that identity. Query shapes follow
 * docs/evidence/dm-v5-battery.json (every `in` needs an orderBy on its field).
 */
export interface DmChain {
  /** The newest Platform block time (ms) any read returned. Never the device clock once a read has happened. */
  now(): number
  /** Messages at any of `tags`, whatever their owner. Callers filter by `$ownerId`. */
  messagesByTags(tags: Uint8Array[]): Promise<ChainMessage[]>
  /** Every invite in `buckets` created at or after `since`, all pages. */
  invitesSince(buckets: number[], since: number): Promise<ChainInvite[]>
  /** One newest-first page of `bucket`, for lost-state recovery (§9). */
  invitesNewestFirst(bucket: number, startAfter: string | null): Promise<InvitePage>
  /** The owner's group documents at any of `handles`. */
  groupDocs(owner: IdentityId, handles: Uint8Array[]): Promise<ChainGroupDoc[]>
  /** The signed-in identity's self-state document, or null. */
  selfState(): Promise<ChainSelfState | null>
  /** True when the signed-in identity has ever written to the v5 contract. */
  hasWritten(): Promise<boolean>
  /** True when this device holds the signing key. Background writes check it so they never prompt for a key. */
  canWrite(): boolean
  createMessage(tag: Uint8Array, body: Uint8Array): Promise<WriteOutcome>
  deleteMessage(id: string): Promise<WriteOutcome>
  createInvite(invite: DmInvite): Promise<WriteOutcome>
  createGroupDoc(handle: Uint8Array, blob: Uint8Array): Promise<WriteOutcome>
  replaceGroupDoc(doc: { id: string; revision: number }, handle: Uint8Array, blob: Uint8Array): Promise<WriteOutcome>
  createSelfState(fields: SelfStateFields): Promise<WriteOutcome>
  replaceSelfState(doc: { id: string; revision: number }, fields: SelfStateFields): Promise<WriteOutcome>
  /** The identity's active ENCRYPTION key (compressed secp256k1), or null if it has none. */
  encryptionKey(identity: IdentityId): Promise<Uint8Array | null>
  /** Everyone the signed-in identity follows or is followed by (§9 recovery). */
  contacts(): Promise<IdentityId[]>
}

/** The signed-in user as DM v5 sees them. */
export interface DmIdentity {
  id: IdentityId
  /** The login-derived ENCRYPTION private key (§4.2). */
  encPriv: Uint8Array
  encPub: Uint8Array
  /** `selfRoot = HKDF(encPriv, "self\0")`. */
  selfRoot: Uint8Array
}

/** A small persistent key-value store (scoped localStorage in the app, a Map in tests). */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
}
