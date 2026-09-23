/**
 * `dmSelfState`: the user's encrypted cross-device state (docs/DM_V5.md §5.5).
 *
 * One document, one atomic replace, spread over up to three 5120-byte fields.
 * Binary layout (all integers big-endian):
 *
 *   u8  version (1)
 *   u16 count, then per 1:1:   peer (32) | U32 since | u64 readAt | u64 hiddenAt     = 52 B
 *   u16 count, then per group: gid (10) | owner (32) | S16 b | S16 r | key (32)
 *                              | U32 since | u64 readAt | u64 hiddenAt            = 98 B
 *   u16 count, then per block: identity id (32) | u8 blocked | u64 changedAt     = 41 B
 *   u8  retention | u64 settings updatedAt
 *   u64 invite scan cursor | U32 next group number
 *   u8  count, then per past key: private key (32)
 */

import { bytesEqual } from '@/lib/bytes'
import { ByteReader, IDENTITY_ID_LENGTH as ID_LENGTH, KEY_LENGTH, assertLength, concat, dmHkdf, s16, u32, u64 } from './kdf'
import { GID_LENGTH, epochBefore } from './keys'
import { SELF_STATE_CLASSES, joinFields, maxPlaintextLength, splitFields } from './padding'
import { openPadded, sealPadded } from './seal'
import type { BlockEntry, DirectConversation, GroupConversation, IdentityId, RetentionSetting, SelfState } from './types'

const VERSION = 1
const RETENTIONS: readonly RetentionSetting[] = ['30d', '90d', '1y', 'never']

export const DIRECT_ENTRY_LENGTH = ID_LENGTH + 4 + 8 + 8
export const GROUP_ENTRY_LENGTH = GID_LENGTH + ID_LENGTH + 2 + 2 + KEY_LENGTH + 4 + 8 + 8
export const BLOCK_ENTRY_LENGTH = ID_LENGTH + 1 + 8
/** The most encoded bytes a self-state can hold (three fields, sealed and padded). */
export const SELF_STATE_MAX_BYTES = maxPlaintextLength(SELF_STATE_CLASSES)

export function emptySelfState(): SelfState {
  return {
    directs: [],
    groups: [],
    blocks: [],
    settings: { retention: '30d', updatedAt: 0 },
    inviteScanCursor: 0,
    nextGroupNumber: 0,
    pastKeys: [],
  }
}

export function encodeSelfState(state: SelfState): Uint8Array {
  const retention = RETENTIONS.indexOf(state.settings.retention)
  if (retention < 0) throw new Error(`Unknown retention: ${state.settings.retention}`)
  if (state.pastKeys.length > 0xff) throw new Error('Too many past keys')
  const directs = state.directs.map((c) => {
    assertLength(c.peer, ID_LENGTH, 'peer')
    return concat(c.peer, u32(c.since), u64(c.readAt), u64(c.hiddenAt))
  })
  const groups = state.groups.map((g) => {
    assertLength(g.gid, GID_LENGTH, 'gid')
    assertLength(g.owner, ID_LENGTH, 'owner')
    assertLength(g.earliestKey, KEY_LENGTH, 'group key')
    return concat(
      g.gid,
      g.owner,
      s16(g.earliestEpoch.b),
      s16(g.earliestEpoch.r),
      g.earliestKey,
      u32(g.since),
      u64(g.readAt),
      u64(g.hiddenAt)
    )
  })
  assertUniqueBlocks(state.blocks)
  const blocks = state.blocks.map((entry) => {
    assertLength(entry.id, ID_LENGTH, 'blocked id')
    return concat(entry.id, new Uint8Array([entry.blocked ? 1 : 0]), u64(entry.changedAt))
  })
  state.pastKeys.forEach((key) => assertLength(key, KEY_LENGTH, 'past key'))
  return concat(
    new Uint8Array([VERSION]),
    s16(directs.length),
    ...directs,
    s16(groups.length),
    ...groups,
    s16(blocks.length),
    ...blocks,
    new Uint8Array([retention]),
    u64(state.settings.updatedAt),
    u64(state.inviteScanCursor),
    u32(state.nextGroupNumber),
    new Uint8Array([state.pastKeys.length]),
    ...state.pastKeys
  )
}

export function decodeSelfState(bytes: Uint8Array): SelfState {
  const reader = new ByteReader(bytes)
  const version = reader.u8()
  if (version !== VERSION) throw new Error(`Unsupported self-state version: ${version}`)
  const directs = Array.from({ length: reader.u16() }, (): DirectConversation => ({
    peer: reader.bytesOf(ID_LENGTH),
    since: reader.u32(),
    readAt: reader.u64(),
    hiddenAt: reader.u64(),
  }))
  const groups = Array.from({ length: reader.u16() }, (): GroupConversation => {
    const gid = reader.bytesOf(GID_LENGTH)
    const owner = reader.bytesOf(ID_LENGTH)
    const earliestEpoch = { b: reader.u16(), r: reader.u16() }
    const earliestKey = reader.bytesOf(KEY_LENGTH)
    return { gid, owner, earliestEpoch, earliestKey, since: reader.u32(), readAt: reader.u64(), hiddenAt: reader.u64() }
  })
  const blocks = Array.from({ length: reader.u16() }, (): BlockEntry => {
    const id = reader.bytesOf(ID_LENGTH)
    const flag = reader.u8()
    if (flag > 1) throw new Error('Invalid blocked flag')
    return { id, blocked: flag === 1, changedAt: reader.u64() }
  })
  assertUniqueBlocks(blocks)
  const retention = RETENTIONS[reader.u8()]
  if (!retention) throw new Error('Unknown retention code')
  const settings = { retention, updatedAt: reader.u64() }
  const inviteScanCursor = reader.u64()
  const nextGroupNumber = reader.u32()
  const pastKeys = Array.from({ length: reader.u8() }, () => reader.bytesOf(KEY_LENGTH))
  reader.end()
  return { directs, groups, blocks, settings, inviteScanCursor, nextGroupNumber, pastKeys }
}

/** One entry per identity: a duplicate would let a stale block outlive an unblock. */
function assertUniqueBlocks(blocks: BlockEntry[]): void {
  blocks.forEach((entry, i) => {
    if (blocks.findIndex((other) => bytesEqual(other.id, entry.id)) !== i) throw new Error('Duplicate block entry')
  })
}

/** True when `id` is currently blocked. */
export function isBlocked(state: SelfState, id: IdentityId): boolean {
  return state.blocks.some((entry) => entry.blocked && bytesEqual(entry.id, id))
}

/** True when the state still fits the one self-state document (the ~300-conversation cap). */
export function selfStateFits(state: SelfState): boolean {
  return encodeSelfState(state).length <= SELF_STATE_MAX_BYTES
}

/** The self-state encryption key: `HKDF(stateKey, "state\0")`. */
export function selfStateKey(stateKey: Uint8Array): Uint8Array {
  return dmHkdf(stateKey, 'state')
}

/**
 * The document's three blob fields. Unused ones are null and must be written
 * as absent: a shrinking state that left an old `blob2`/`blob3` in place
 * would no longer decrypt.
 */
export interface SelfStateFields {
  blob: Uint8Array
  blob2: Uint8Array | null
  blob3: Uint8Array | null
}

/** Seal the state and split it into the document's `blob`, `blob2`, `blob3`. */
export async function encryptSelfState(stateKey: Uint8Array, state: SelfState): Promise<SelfStateFields> {
  const [blob, blob2 = null, blob3 = null] = splitFields(
    await sealPadded(selfStateKey(stateKey), encodeSelfState(state), SELF_STATE_CLASSES)
  )
  return { blob, blob2, blob3 }
}

/** Reassemble and open the document's fields. Throws on a wrong key, tampering or a gap between fields. */
export async function decryptSelfState(stateKey: Uint8Array, fields: SelfStateFields): Promise<SelfState> {
  if (!fields.blob2 && fields.blob3) throw new Error('blob3 without blob2')
  const parts = [fields.blob, fields.blob2, fields.blob3].filter((field): field is Uint8Array => field !== null)
  return decodeSelfState(await openPadded(selfStateKey(stateKey), joinFields(parts)))
}

// ---------------------------------------------------------------------------
// Merge (§5.5): resolve a lost revision race (error 40106) by re-reading and merging.

function unionBy<T>(first: T[], second: T[], same: (a: T, b: T) => boolean, combine: (a: T, b: T) => T): T[] {
  const out = [...first]
  for (const item of second) {
    const index = out.findIndex((existing) => same(existing, item))
    if (index < 0) out.push(item)
    else out[index] = combine(out[index], item)
  }
  return out
}

function mergeDirect(a: DirectConversation, b: DirectConversation): DirectConversation {
  return {
    peer: a.peer,
    since: Math.min(a.since, b.since),
    readAt: Math.max(a.readAt, b.readAt),
    hiddenAt: Math.max(a.hiddenAt, b.hiddenAt),
  }
}

function mergeGroup(a: GroupConversation, b: GroupConversation): GroupConversation {
  const earliest = epochBefore(b.earliestEpoch, a.earliestEpoch) ? b : a
  return {
    ...a,
    earliestEpoch: earliest.earliestEpoch,
    earliestKey: earliest.earliestKey,
    since: Math.min(a.since, b.since),
    readAt: Math.max(a.readAt, b.readAt),
    hiddenAt: Math.max(a.hiddenAt, b.hiddenAt),
  }
}

/** The newer change wins; the saved (first) entry on a tie. */
function newerBlock(a: BlockEntry, b: BlockEntry): BlockEntry {
  return b.changedAt > a.changedAt ? b : a
}

const keepFirst = <T>(a: T) => a

/**
 * Merge the saved state (`remote`) with this device's (`local`).
 * Conversations and past keys are unions; `readAt` and `hiddenAt` take the
 * maximum and `since` the minimum; a group keeps its earliest key. Each block
 * entry and the settings take the newer change (the saved state on a tie), so
 * an unblock survives. The next group number takes the
 * maximum, so `n` is never reused. The invite scan cursor takes the
 * MINIMUM: each device's cursor only covers the conversations it saved, so
 * the lower one is the only position both sets are known to cover, and a
 * rescan just re-finds known peers.
 *
 * Two states that each fit can merge into one that does not; check
 * `selfStateFits` on the result before saving (§5.5 cap handling).
 */
export function mergeSelfStates(remote: SelfState, local: SelfState): SelfState {
  return {
    directs: unionBy(remote.directs, local.directs, (a, b) => bytesEqual(a.peer, b.peer), mergeDirect),
    groups: unionBy(
      remote.groups,
      local.groups,
      (a, b) => bytesEqual(a.gid, b.gid) && bytesEqual(a.owner, b.owner),
      mergeGroup
    ),
    blocks: unionBy(remote.blocks, local.blocks, (a, b) => bytesEqual(a.id, b.id), newerBlock),
    settings: local.settings.updatedAt > remote.settings.updatedAt ? local.settings : remote.settings,
    inviteScanCursor: Math.min(remote.inviteScanCursor, local.inviteScanCursor),
    nextGroupNumber: Math.max(remote.nextGroupNumber, local.nextGroupNumber),
    pastKeys: unionBy(remote.pastKeys, local.pastKeys, bytesEqual, keepFirst),
  }
}
