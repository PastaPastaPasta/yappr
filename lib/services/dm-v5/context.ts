/**
 * The runtime shared by the DM v5 client modules: the chain, the signed-in
 * identity, the self-state, the per-device cache and the live conversations.
 * Every module takes a `DmContext`, so each can be tested against an in-memory
 * chain.
 */

import { bytesEqual, hexToBytes } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { logger } from '@/lib/logger'
import { weekOf } from '@/lib/dm/kdf'
import { deriveGroupSecret, deriveSelfRoot, deriveStateKey, epochBefore } from '@/lib/dm/keys'
import type { DirectConversation, GroupConversation, IdentityId } from '@/lib/dm/types'
import { markStale, newDirectConv, newGroupConv, setPeerKey, stream, type Conv, type DirectConv, type GroupConv } from './conversation'
import type { LocalCache } from './local-cache'
import { SelfStateStore, type Scheduler } from './self-state-store'
import type { DmChain, DmIdentity } from './types'
import { directKey, groupKey, hexId } from './util'

export interface PendingGrant {
  /** The 1:1 the grant arrived on. */
  from: IdentityId
  gid: Uint8Array
  b: number
  r: number
  key: Uint8Array
  createdAt: number
  /** Chain time it was first seen; roster-unreadable grants are retried for a while (§6.2). */
  firstSeen: number
}

/** A retry schedule for background owner work: the next attempt's chain time and how many failed so far. */
export interface Backoff {
  retryAt: number
  failures: number
}

export interface DmContext {
  chain: DmChain
  me: DmIdentity
  store: SelfStateStore
  cache: LocalCache
  convs: Map<string, Conv>
  /** Peer encryption keys; null = the identity has none. */
  peerKeys: Map<string, Uint8Array | null>
  pendingGrants: Map<string, PendingGrant>
  /** Members who sent a leave (0x02) on a group I own, waiting for my client to remove them (§6.4). */
  pendingLeaves: Map<string, { conv: GroupConv; member: IdentityId }>
  /**
   * Background owner work (removing a member who left, repairing a roster,
   * §6.5) that failed, by group conversation key: one shared backoff per group.
   */
  ownerRepairs: Map<string, Backoff>
  /** In-memory invite scan position; equals the saved one except during lost-state recovery (§9). */
  scanCursor: number
  /** Invite ids already read at `scanCursor` (§6.3: skip ids already seen at the cursor). */
  seenAtCursor: Set<string>
  /** The first poll after the app opens also polls own streams (§6.3). */
  appJustOpened: boolean
  /** Lost-state recovery (§9) is running: conversations it finds start as read. */
  recovering: boolean
  /** Called whenever anything visible changed. */
  changed(): void
  /** Waits between write retries (a nonce clash); tests pass one that does not really wait. */
  sleep?: (ms: number) => Promise<void>
  /**
   * A local monotonic clock (ms) for how long ago something happened on this
   * device. The chain's block time only moves when a read returns a newer
   * block, so it cannot measure elapsed time (§6.3 SEND freshness).
   */
  clock: () => number
  /** Wall-clock time (ms). A monotonic clock can pause during system sleep; freshness checks use both. */
  wallClock: () => number
}

/** A fresh context for `identityId`, with its self-state store and nothing attached yet. */
export function createContext(options: {
  chain: DmChain
  identityId: IdentityId
  encPriv: Uint8Array
  cache: LocalCache
  scheduler?: Scheduler
  changed?: () => void
}): DmContext {
  const { chain, encPriv } = options
  const selfRoot = deriveSelfRoot(encPriv)
  return {
    chain,
    me: { id: options.identityId, encPriv, encPub: getPublicKey(encPriv), selfRoot },
    store: new SelfStateStore(chain, deriveStateKey(selfRoot), options.scheduler),
    cache: options.cache,
    convs: new Map(),
    peerKeys: new Map(),
    pendingGrants: new Map(),
    pendingLeaves: new Map(),
    ownerRepairs: new Map(),
    scanCursor: 0,
    seenAtCursor: new Set(),
    appJustOpened: true,
    recovering: false,
    changed: options.changed ?? (() => undefined),
    clock: () => performance.now(),
    wallClock: () => Date.now(),
  }
}

export const curWeek = (ctx: DmContext): number => weekOf(ctx.chain.now())

export const isMe = (ctx: DmContext, id: IdentityId): boolean => bytesEqual(id, ctx.me.id)

/**
 * The identity's encryption key, fetched once per session. A lookup that
 * fails (network) returns null without caching, so a later call retries; an
 * identity that has no key is cached as null.
 */
export async function peerKey(ctx: DmContext, id: IdentityId): Promise<Uint8Array | null> {
  if (isMe(ctx, id)) return ctx.me.encPub
  const cacheKey = hexId(id)
  if (ctx.peerKeys.has(cacheKey)) return ctx.peerKeys.get(cacheKey) ?? null
  let key: Uint8Array | null
  try {
    key = await ctx.chain.encryptionKey(id)
  } catch (error) {
    logger.debug('DM v5: encryption key lookup failed, will retry:', error)
    return null
  }
  ctx.peerKeys.set(cacheKey, key)
  return key
}

/** The identity was fetched and has no encryption key: messaging it cannot work until it adds one. */
export class NoEncryptionKeyError extends Error {
  constructor() {
    super('This account has no encryption key yet, so it cannot receive encrypted messages.')
  }
}

/** The identity could not be fetched (network, DAPI): nothing is known yet, so trying again can work. */
export class PeerKeyLookupError extends Error {
  constructor() {
    super("Couldn't look up this account right now. Check your connection and try again.")
  }
}

/** `peerKey`, throwing `NoEncryptionKeyError` or the retryable `PeerKeyLookupError` instead of returning null. */
export async function requirePeerKey(ctx: DmContext, id: IdentityId): Promise<Uint8Array> {
  const key = await peerKey(ctx, id)
  if (key) return key
  // peerKey caches an identity that has no key; a lookup that failed is not cached.
  throw ctx.peerKeys.has(hexId(id)) ? new NoEncryptionKeyError() : new PeerKeyLookupError()
}

/** Retry the peer keys of 1:1s whose key lookup failed earlier. */
export async function retryPeerKeys(ctx: DmContext): Promise<void> {
  for (const conv of Array.from(ctx.convs.values())) {
    if (conv.kind !== 'direct' || conv.convKey || ctx.peerKeys.has(hexId(conv.peer))) continue
    const key = await peerKey(ctx, conv.peer)
    if (key) {
      setPeerKey(conv, ctx.me, key)
      seedHeads(ctx, conv)
    }
  }
}

export function directConv(ctx: DmContext, peer: IdentityId): DirectConv | null {
  const conv = ctx.convs.get(directKey(peer))
  return conv?.kind === 'direct' ? conv : null
}

export function groupConv(ctx: DmContext, owner: IdentityId, gid: Uint8Array): GroupConv | null {
  const conv = ctx.convs.get(groupKey(owner, gid))
  return conv?.kind === 'group' ? conv : null
}

/**
 * Restore this device's stream positions from the cache: each cached head
 * becomes a one-tag probe (`resume`), so a reload finds the latest messages
 * even when nothing arrived since `readAt`. A group is seeded after its first
 * apply, once its epochs are known.
 */
export function seedHeads(ctx: DmContext, conv: Conv): void {
  for (const [senderHex, head] of Object.entries(ctx.cache.heads(conv.key))) {
    const sender = hexToBytes(senderHex)
    if (sender.length !== 32) continue
    const st = stream(conv, sender, head)
    if (st && !st.cur) st.resume = { w: head.w, j: head.j }
  }
}

/** Register a 1:1 from the self-state (or a newly found one). The peer key is fetched lazily. */
export async function attachDirect(ctx: DmContext, entry: DirectConversation, draft = false): Promise<DirectConv> {
  const existing = directConv(ctx, entry.peer)
  if (existing) {
    // A draft the user opened becomes the real conversation once one is saved or found (their invite).
    if (existing.draft && !draft) {
      existing.entry = entry
      existing.draft = false
    }
    return existing
  }
  const conv = newDirectConv(ctx.me, entry, null, draft)
  ctx.convs.set(conv.key, conv)
  const key = await peerKey(ctx, entry.peer)
  if (key) setPeerKey(conv, ctx.me, key)
  seedHeads(ctx, conv)
  return conv
}

/**
 * Take a saved anchor into an attached group's keys. Another device's save can
 * bring one this device lacks (a re-add key, §5.5); its grant may already be
 * swept, so this is the only way it arrives. A group marked removed or
 * unreadable is re-judged by the next apply, which walks the keyrings again
 * with the new key (a removed group is otherwise never applied again). An
 * anchor older than the live epoch cannot change that verdict and only adds
 * history.
 */
function adoptAnchor(conv: GroupConv, entry: GroupConversation): void {
  if (conv.keys.get(entry.earliestEpoch)) return
  conv.keys.set(entry.earliestEpoch, entry.earliestKey)
  if (epochBefore(entry.earliestEpoch, conv.epoch)) return
  conv.removed = false
  conv.unreadable = false
  markStale(conv)
}

export function attachGroup(ctx: DmContext, entry: GroupConversation): GroupConv {
  const existing = groupConv(ctx, entry.owner, entry.gid)
  if (existing) {
    adoptAnchor(existing, entry)
    return existing
  }
  const secret = isMe(ctx, entry.owner) ? deriveGroupSecret(ctx.me.encPriv, entry.gid) : null
  const conv = newGroupConv(entry, secret)
  ctx.convs.set(conv.key, conv)
  return conv
}

/**
 * Register every conversation the self-state knows, and point live ones at the
 * store's current entries. Peer keys are fetched in parallel; a failed lookup
 * leaves the 1:1 unpolled until `retryPeerKeys` succeeds.
 */
export async function attachSaved(ctx: DmContext): Promise<void> {
  await Promise.all(ctx.store.directs().map(async (entry) => {
    const conv = await attachDirect(ctx, entry)
    conv.entry = entry
  }))
  for (const entry of ctx.store.groups()) attachGroup(ctx, entry).entry = entry
}
