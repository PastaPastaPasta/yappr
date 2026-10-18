/**
 * Every private-feed document read (social v17, docs/SOCIAL_V17.md), each one
 * served by an index of the contract (lib/contract-query-conformance.test.ts):
 *
 *     privateFeed       feed        [$ownerId, feed]                 unique
 *     privateFeedGrant  recipient   [recipientId, $ownerId, feed]    unique
 *                       leaf        [$ownerId, feed, leafIndex]      unique
 *     privateFeedRekey  generation  [$ownerId, feed, keyGeneration]  unique
 *     followRequest     pair        [targetId, $ownerId]             unique
 *                       target      [targetId, $createdAt]
 *
 * Reads throw on failure: a failed read must never look like "no feed",
 * "no grant" or "no revocations".
 */

import { getEvoSdk } from './evo-sdk-service'
import { queryDocuments, identifierToBase58, RequestDeduplicator, type QueryDocumentsOptions } from './sdk-helpers'
import { paginateFetchAll } from './pagination-utils'
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants'
import { normalizeBytes, requireBytes } from '@/lib/bytes'

export interface PrivateFeedDocument {
  $id: string
  ownerId: string
  createdAt: number
  feed: number
  treeCapacity: number
  maxKeyGeneration: number
  /** The owner's identity key the seed is sealed to. */
  keyId: number
  encryptedSeed: Uint8Array
  /** The history link to the predecessor; absent on a first feed or a fresh start. */
  carry?: Uint8Array
  /** Absent means the main audience (the only one at launch). */
  audience?: number
}

export interface GrantDocument {
  $id: string
  ownerId: string
  createdAt: number
  feed: number
  recipientId: string
  leafIndex: number
  keyGeneration: number
  encryptedPayload: Uint8Array
}

export interface RekeyDocument {
  $id: string
  ownerId: string
  createdAt: number
  feed: number
  keyGeneration: number
  revokedLeaf: number
  packets: Uint8Array
  encryptedCEK: Uint8Array
}

export interface FollowRequestDocument {
  $id: string
  /** The requester. */
  $ownerId: string
  $createdAt: number
  $revision: number
  targetId: string
  publicKey?: Uint8Array
}

/** At most this many feeds are looked at to find an owner's current one (design §6.1). */
const FEED_SCAN = 16
const PAGE = 100

const contract = YAPPR_CONTRACT_ID
const id58 = (value: unknown) => identifierToBase58(value) || ''

function toFeed(doc: Record<string, unknown>): PrivateFeedDocument {
  const carry = doc.carry ? normalizeBytes(doc.carry) ?? undefined : undefined
  return {
    $id: doc.$id as string,
    ownerId: id58(doc.$ownerId),
    createdAt: doc.$createdAt as number,
    feed: Number(doc.feed),
    treeCapacity: Number(doc.treeCapacity),
    maxKeyGeneration: Number(doc.maxKeyGeneration),
    keyId: Number(doc.keyId),
    encryptedSeed: requireBytes(doc.encryptedSeed, 'encryptedSeed'),
    ...(carry ? { carry } : {}),
    ...(doc.audience !== undefined && doc.audience !== null ? { audience: Number(doc.audience) } : {}),
  }
}

function toGrant(doc: Record<string, unknown>): GrantDocument {
  return {
    $id: doc.$id as string,
    ownerId: id58(doc.$ownerId),
    createdAt: doc.$createdAt as number,
    feed: Number(doc.feed),
    recipientId: id58(doc.recipientId),
    leafIndex: Number(doc.leafIndex),
    keyGeneration: Number(doc.keyGeneration),
    encryptedPayload: requireBytes(doc.encryptedPayload, 'encryptedPayload'),
  }
}

function toRekey(doc: Record<string, unknown>): RekeyDocument {
  return {
    $id: doc.$id as string,
    ownerId: id58(doc.$ownerId),
    createdAt: doc.$createdAt as number,
    feed: Number(doc.feed),
    keyGeneration: Number(doc.keyGeneration),
    revokedLeaf: Number(doc.revokedLeaf),
    packets: requireBytes(doc.packets, 'packets'),
    encryptedCEK: requireBytes(doc.encryptedCEK, 'encryptedCEK'),
  }
}

function toRequest(doc: Record<string, unknown>): FollowRequestDocument {
  return {
    $id: doc.$id as string,
    $ownerId: id58(doc.$ownerId),
    $createdAt: doc.$createdAt as number,
    $revision: Number(doc.$revision ?? 1),
    targetId: id58(doc.targetId),
    publicKey: doc.publicKey ? requireBytes(doc.publicKey, 'publicKey') : undefined,
  }
}

/** Every document of `documentTypeName` matching `where`, in `orderBy` order, read page by page. */
async function fetchAll<T>(
  documentTypeName: string,
  where: NonNullable<QueryDocumentsOptions['where']>,
  orderBy: NonNullable<QueryDocumentsOptions['orderBy']>,
  convert: (doc: Record<string, unknown>) => T,
): Promise<T[]> {
  const { documents } = await paginateFetchAll(await getEvoSdk(), (startAfter) => ({
    dataContractId: contract,
    documentTypeName,
    where,
    orderBy,
    limit: PAGE,
    ...(startAfter && { startAfter }),
  }), convert, { maxResults: Infinity })
  return documents
}

const feedsReads = new RequestDeduplicator<string, PrivateFeedDocument[]>(0)
/** Feeds are write-once, so an owner's list only ever grows; a short cache spares the private post cards a read each. */
const feedsCache = new Map<string, { at: number; feeds: PrivateFeedDocument[] }>()
const FEEDS_TTL_MS = 30_000

/** `ownerId`'s newest feeds (any audience), newest first. */
export async function fetchFeeds(ownerId: string, options: { fresh?: boolean } = {}): Promise<PrivateFeedDocument[]> {
  const cached = feedsCache.get(ownerId)
  if (!options.fresh && cached && Date.now() - cached.at < FEEDS_TTL_MS) return cached.feeds
  return feedsReads.dedupe(`${ownerId}:${options.fresh ? 'fresh' : ''}`, async () => {
    const documents = await queryDocuments(await getEvoSdk(), {
      dataContractId: contract,
      documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED,
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['feed', 'desc']],
      limit: FEED_SCAN,
    })
    const feeds = documents.map(toFeed)
    feedsCache.set(ownerId, { at: Date.now(), feeds })
    return feeds
  })
}

/** Forget the cached feed list of `ownerId` (after this device opened one). */
export function forgetFeeds(ownerId: string): void {
  feedsCache.delete(ownerId)
}

/** The feeds of the main audience (those without an `audience`; launch has no other), in the order given: newest first from {@link fetchFeeds}. */
export function mainFeeds(feeds: readonly PrivateFeedDocument[]): PrivateFeedDocument[] {
  return feeds.filter((feed) => feed.audience === undefined)
}

/** The current feed of the main audience: its highest-numbered feed (design §3). */
export async function fetchCurrentFeed(ownerId: string, options: { fresh?: boolean } = {}): Promise<PrivateFeedDocument | null> {
  return mainFeeds(await fetchFeeds(ownerId, options))[0] ?? null
}

/** One feed of `ownerId`, from the cached list when it is there. */
export async function fetchFeed(ownerId: string, feed: number): Promise<PrivateFeedDocument | null> {
  const listed = (await fetchFeeds(ownerId)).find((doc) => doc.feed === feed)
  if (listed) return listed
  const documents = await queryDocuments(await getEvoSdk(), {
    dataContractId: contract,
    documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED,
    where: [['$ownerId', '==', ownerId], ['feed', '==', feed]],
    limit: 1,
  })
  return documents.length > 0 ? toFeed(documents[0]) : null
}

/** The newest key generation of a feed: its last rekey's, or 1 when nothing was revoked. */
export async function fetchLatestKeyGeneration(ownerId: string, feed: number): Promise<number> {
  const documents = await queryDocuments(await getEvoSdk(), {
    dataContractId: contract,
    documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
    where: [['$ownerId', '==', ownerId], ['feed', '==', feed]],
    orderBy: [['keyGeneration', 'desc']],
    limit: 1,
  })
  return documents.length > 0 ? Number(documents[0].keyGeneration) : 1
}

/** A feed's rekeys above `afterKeyGeneration`, oldest first. */
export async function fetchRekeys(ownerId: string, feed: number, afterKeyGeneration = 1): Promise<RekeyDocument[]> {
  return fetchAll(
    DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
    [['$ownerId', '==', ownerId], ['feed', '==', feed], ['keyGeneration', '>', afterKeyGeneration]],
    [['keyGeneration', 'asc']],
    toRekey,
  )
}

const membersReads = new RequestDeduplicator<string, GrantDocument[]>(0)

/** A feed's grants, by leaf: its members. */
export async function fetchMembers(ownerId: string, feed: number): Promise<GrantDocument[]> {
  return membersReads.dedupe(`${ownerId}:${feed}`, () => fetchAll(
    DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
    [['$ownerId', '==', ownerId], ['feed', '==', feed]],
    [['leafIndex', 'asc']],
    toGrant,
  ))
}

/** `recipientId`'s grant in one feed, or null. */
export async function fetchGrant(ownerId: string, feed: number, recipientId: string): Promise<GrantDocument | null> {
  const documents = await queryDocuments(await getEvoSdk(), {
    dataContractId: contract,
    documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
    where: [['recipientId', '==', recipientId], ['$ownerId', '==', ownerId], ['feed', '==', feed]],
    limit: 1,
  })
  return documents.length > 0 ? toGrant(documents[0]) : null
}

const newestGrantReads = new RequestDeduplicator<string, GrantDocument | null>(0)

/** `recipientId`'s grant in `ownerId`'s newest feed that has one (design §6.2), or null. */
export async function fetchNewestGrant(ownerId: string, recipientId: string): Promise<GrantDocument | null> {
  return newestGrantReads.dedupe(`${ownerId}:${recipientId}`, async () => {
    const documents = await queryDocuments(await getEvoSdk(), {
      dataContractId: contract,
      documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
      where: [['recipientId', '==', recipientId], ['$ownerId', '==', ownerId]],
      orderBy: [['feed', 'desc']],
      limit: 1,
    })
    return documents.length > 0 ? toGrant(documents[0]) : null
  })
}

/** Every grant `recipientId` holds, by owner then feed: "the feeds I can read" on any device (D32). */
export async function fetchGrantsHeldBy(recipientId: string): Promise<GrantDocument[]> {
  return fetchAll(
    DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
    [['recipientId', '==', recipientId]],
    [['$ownerId', 'asc'], ['feed', 'asc']],
    toGrant,
  )
}

/** Every grant `ownerId` has out to `recipientId`, in any feed, oldest feed first. */
export async function fetchGrantsTo(ownerId: string, recipientId: string): Promise<GrantDocument[]> {
  return fetchAll(
    DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
    [['recipientId', '==', recipientId], ['$ownerId', '==', ownerId]],
    [['feed', 'asc']],
    toGrant,
  )
}

/**
 * The grants of one feed still in force: a revocation keeps its grant as the
 * record that the request it answered was answered (requests persist, PF8),
 * and only a rekey of the grant's leaf at a later generation says it is
 * revoked. A grant written on that leaf after the rekey is a new member.
 */
export function activeGrants<T extends Pick<GrantDocument, 'leafIndex' | 'keyGeneration'>>(grants: readonly T[], rekeys: readonly Pick<RekeyDocument, 'revokedLeaf' | 'keyGeneration'>[]): T[] {
  const revokedAt = new Map<number, number>()
  for (const rekey of rekeys) revokedAt.set(rekey.revokedLeaf, Math.max(revokedAt.get(rekey.revokedLeaf) ?? 0, rekey.keyGeneration))
  return grants.filter((grant) => (revokedAt.get(grant.leafIndex) ?? 0) <= grant.keyGeneration)
}

/** True when a rekey of `grant`'s feed revoked its leaf after it was written. */
export async function grantIsRevoked(grant: GrantDocument): Promise<boolean> {
  return (await answeredThrough(grant)).revoked
}

/**
 * When a grant last answered its holder's request: its writing, or the rekey
 * that revoked it. Only a request made after that asks again.
 */
export async function answeredThrough(grant: GrantDocument, rekeys?: readonly RekeyDocument[]): Promise<{ at: number; revoked: boolean }> {
  const later = (rekeys ?? await fetchRekeys(grant.ownerId, grant.feed, grant.keyGeneration))
    .filter((rekey) => rekey.revokedLeaf === grant.leafIndex && rekey.keyGeneration > grant.keyGeneration)
  return later.length > 0 ? { at: Math.max(grant.createdAt, ...later.map((rekey) => rekey.createdAt)), revoked: true } : { at: grant.createdAt, revoked: false }
}

const requestReads = new RequestDeduplicator<string, FollowRequestDocument | null>(0)

/** `requesterId`'s follow request to `ownerId`: their standing consent while they follow privately (PF8). */
export async function fetchFollowRequest(ownerId: string, requesterId: string): Promise<FollowRequestDocument | null> {
  return requestReads.dedupe(`${ownerId}:${requesterId}`, async () => {
    const documents = await queryDocuments(await getEvoSdk(), {
      dataContractId: contract,
      documentTypeName: DOCUMENT_TYPES.FOLLOW_REQUEST,
      where: [['targetId', '==', ownerId], ['$ownerId', '==', requesterId]],
      limit: 1,
    })
    return documents.length > 0 ? toRequest(documents[0]) : null
  })
}

const requestsReads = new RequestDeduplicator<string, FollowRequestDocument[]>(0)

/** Every follow request to `ownerId`, newest first. */
export async function fetchFollowRequestsTo(ownerId: string): Promise<FollowRequestDocument[]> {
  return requestsReads.dedupe(ownerId, () => fetchAll(
    DOCUMENT_TYPES.FOLLOW_REQUEST,
    [['targetId', '==', ownerId]],
    [['targetId', 'asc'], ['$createdAt', 'desc']],
    toRequest,
  ))
}
