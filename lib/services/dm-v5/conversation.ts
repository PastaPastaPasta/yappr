/**
 * The in-memory model of DM v5 conversations (docs/DM_V5.md §6.3): a 1:1 is a
 * group with members {me, peer}, one fixed epoch and no group documents. Each
 * conversation holds its per-sender streams and the messages decrypted so far.
 */

import { bytesEqual } from '@/lib/bytes'
import { deriveDirectKeys } from '@/lib/dm/keys'
import { deriveStreamKey, directOwnerId } from '@/lib/dm/stream'
import type {
  DirectConversation,
  DmContent,
  Epoch,
  GroupConversation,
  IdentityId,
  MessagePointer,
  RosterContent,
} from '@/lib/dm/types'
import type { DmIdentity } from './types'
import { EpochKeys, directKey, groupKey, hexId, includesId, pointerKey, sameEpoch } from './util'

/** A stale tag (§6.3): an old week's or epoch's next tag, polled until `until` (chain time). */
export interface StaleTag {
  w: number
  j: number
  until: number
}

export interface StreamState {
  sender: IdentityId
  epoch: Epoch
  /** `SK` for this sender and epoch. */
  key: Uint8Array
  /** Newest `(w, j)` held, or null. */
  cur: { w: number; j: number } | null
  /** A message known from this device's cache to exist: probed once instead of the week scan. */
  resume: { w: number; j: number } | null
  /**
   * Weeks probed at `j = 0` and found empty after the stale window had passed
   * them. Senders only write in the current week, so such a week never gains
   * a message and is not asked again (a straggler is reached through `prev`).
   */
  probed: Set<number>
  stale: StaleTag[]
}

export interface HeldMessage {
  sender: IdentityId
  pointer: MessagePointer
  docId: string
  createdAt: number
  content: DmContent
  prev: MessagePointer | null
  /** Sent from this device and not yet read back from the chain. */
  local?: boolean
}

interface ConvBase {
  key: string
  held: Map<string, HeldMessage>
  streams: Map<string, StreamState>
  /** The thread is on screen: poll own streams and backfill fully. */
  open: boolean
  /** Probe and backfill back to `since` rather than `readAt` (opened once, or recovered, §6.3 / §9). */
  deepProbe: boolean
  /** Poll my own stream on the next poll only (a recovered conversation, §9). */
  probeOwn: boolean
  /** Backfills stopped at `readAt` while closed, resumed when the thread opens. */
  deferred: Array<{ sender: IdentityId; pointer: MessagePointer }>
}

export interface DirectConv extends ConvBase {
  kind: 'direct'
  peer: IdentityId
  entry: DirectConversation
  /** Opened by the user but no invite written and nothing saved yet. */
  draft: boolean
  /** `K`, null until the peer's encryption key is known. */
  convKey: Uint8Array | null
}

export interface GroupConv extends ConvBase {
  kind: 'group'
  owner: IdentityId
  gid: Uint8Array
  entry: GroupConversation
  keys: EpochKeys
  /** The newest epoch this reader has switched to. */
  epoch: Epoch
  /** Set on a live switch: streams on the new epoch start at this week (§6.3 SWITCH). */
  epochSinceWeek: number | null
  /** The last roster that opened, and the epoch it was written at (can trail `epoch` until the owner repairs it). */
  lastRoster: RosterContent | null
  roster: { id: string; revision: number } | null
  keyringAt: Map<number, number>
  /** Keyring blobs by base: the owner reads nonces and tests slots from them (§6.5). */
  keyrings: Map<number, Uint8Array>
  /** No keyring slot for me on a newer base: I was removed. */
  removed: boolean
  /** The roster is a tombstone (§6.4). */
  ended: boolean
  /** The roster never opened with the keys held: "ask the owner to resend your keys". */
  unreadable: boolean
  /** Chain time the group documents were last applied (§6.3 SEND freshness). */
  appliedAt: number
  /** Switches after the first apply are live and leave stale tags behind. */
  live: boolean
  /** The owner's group secret `S`, when I own the group. */
  secret: Uint8Array | null
}

export type Conv = DirectConv | GroupConv

const DIRECT_EPOCH: Epoch = { b: 0, r: 0 }

function baseConv(key: string): ConvBase {
  return { key, held: new Map(), streams: new Map(), open: false, deepProbe: false, probeOwn: false, deferred: [] }
}

export function newDirectConv(me: DmIdentity, entry: DirectConversation, peerPub: Uint8Array | null, draft = false): DirectConv {
  const conv: DirectConv = { ...baseConv(directKey(entry.peer)), kind: 'direct', peer: entry.peer, entry, draft, convKey: null }
  if (peerPub) setPeerKey(conv, me, peerPub)
  return conv
}

export function setPeerKey(conv: DirectConv, me: DmIdentity, peerPub: Uint8Array): void {
  conv.convKey = deriveDirectKeys(me.encPriv, peerPub, me.id, conv.peer).key
}

export function newGroupConv(entry: GroupConversation, secret: Uint8Array | null = null): GroupConv {
  const keys = new EpochKeys()
  keys.set(entry.earliestEpoch, entry.earliestKey)
  return {
    ...baseConv(groupKey(entry.owner, entry.gid)),
    kind: 'group',
    owner: entry.owner,
    gid: entry.gid,
    entry,
    keys,
    epoch: { ...entry.earliestEpoch },
    epochSinceWeek: null,
    lastRoster: null,
    roster: null,
    keyringAt: new Map(),
    keyrings: new Map(),
    removed: false,
    ended: false,
    unreadable: false,
    appliedAt: 0,
    live: false,
    secret,
  }
}

export function currentEpoch(conv: Conv): Epoch {
  return conv.kind === 'direct' ? DIRECT_EPOCH : conv.epoch
}

/** The members whose streams are polled: me and the peer, or the roster. */
export function members(conv: Conv, me: IdentityId): IdentityId[] {
  return conv.kind === 'direct' ? [me, conv.peer] : conv.lastRoster?.members ?? [conv.owner, me]
}

export function isMember(conv: Conv, id: IdentityId, me: IdentityId): boolean {
  return includesId(members(conv, me), id)
}

/** The conversation key for `epoch`, or null when this reader does not hold it. */
export function epochKey(conv: Conv, epoch: Epoch): Uint8Array | null {
  if (conv.kind === 'direct') return sameEpoch(epoch, DIRECT_EPOCH) ? conv.convKey : null
  return conv.keys.get(epoch)
}

const streamId = (sender: IdentityId, epoch: Epoch) => `${hexId(sender)}|${epoch.b}.${epoch.r}`

/** The stream of `sender` on `epoch`, created on first use; null without the epoch's key. */
export function stream(conv: Conv, sender: IdentityId, epoch: Epoch): StreamState | null {
  const id = streamId(sender, epoch)
  const existing = conv.streams.get(id)
  if (existing) return existing
  const key = epochKey(conv, epoch)
  if (!key) return null
  const ownerId = conv.kind === 'direct' ? directOwnerId() : conv.owner
  const created: StreamState = {
    sender,
    epoch: { b: epoch.b, r: epoch.r },
    key: deriveStreamKey(key, ownerId, sender),
    cur: null,
    resume: null,
    probed: new Set(),
    stale: [],
  }
  conv.streams.set(id, created)
  return created
}

export function isHeld(conv: Conv, sender: IdentityId, p: MessagePointer): boolean {
  return conv.held.has(pointerKey(sender, p))
}

/** Held messages oldest first. */
export function timeline(conv: Conv): HeldMessage[] {
  return Array.from(conv.held.values()).sort((a, b) => a.createdAt - b.createdAt || a.pointer.j - b.pointer.j)
}

function newestBy(conv: Conv, keep: (held: HeldMessage) => boolean): HeldMessage | null {
  let newest: HeldMessage | null = null
  for (const held of Array.from(conv.held.values())) {
    if (!keep(held)) continue
    if (!newest || held.createdAt > newest.createdAt || (held.createdAt === newest.createdAt && held.pointer.j > newest.pointer.j)) newest = held
  }
  return newest
}

/** The newest message I sent in the conversation, any epoch: the next send's `prev` (§6.1). */
export function newestOwn(conv: Conv, me: IdentityId): HeldMessage | null {
  return newestBy(conv, (held) => bytesEqual(held.sender, me))
}

/** The newest text message, for previews and ordering. */
export function newestText(conv: Conv, visible: (held: HeldMessage) => boolean): HeldMessage | null {
  return newestBy(conv, (held) => held.content.type === 'text' && visible(held))
}

export function unreadCount(conv: Conv, me: IdentityId, isBlocked: (id: IdentityId) => boolean): number {
  let count = 0
  for (const held of Array.from(conv.held.values())) {
    if (held.content.type !== 'text' || bytesEqual(held.sender, me) || isBlocked(held.sender)) continue
    if (held.createdAt > conv.entry.readAt) count++
  }
  return count
}
