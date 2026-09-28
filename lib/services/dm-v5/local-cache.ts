/**
 * Per-device DM v5 cache (docs/DM_V5.md §6.3 "local cache per stream", §5.6
 * "caches the oldest surviving own message"). It holds positions, never
 * content or keys, so losing it costs only queries: every value can be
 * rediscovered from the chain.
 *
 * - `heads`: the newest message pointer seen per sender per conversation. On
 *   load it restores the poll cursor and gives backfill a starting point, so a
 *   reload does not re-probe weeks or lose history on old epochs.
 * - `oldestOwn`: where the last sweep stopped.
 * - `hasText`: a grant-only 1:1 stays hidden until its first text (§6.2).
 * - `inviteDays`: invites seen per day and bucket level, for the sender's `k`
 *   estimate (§5.1.2).
 * - `readAt`/`hiddenAt` per conversation and `blocks`: this device's latest
 *   self-state edits. The self-state save is coalesced and cannot finish once
 *   the page is closing (§5.5), so they are kept here and re-applied on load:
 *   a reload never loses a read position, a deleted conversation or a block.
 */

import { senderBucketLevel } from '@/lib/dm/invite'
import type { MessagePointer } from '@/lib/dm/types'
import type { KeyValueStore } from './types'
import { DAY_MS, comparePointers } from './util'

const RATE_WINDOW_DAYS = 30

interface ConvCache {
  heads: Record<string, MessagePointer>
  oldestOwn?: MessagePointer
  hasText?: boolean
  /** I sent a leave on this group: stop showing it while the owner removes me (§6.4). */
  left?: boolean
  readAt?: number
  hiddenAt?: number
}

export interface CachedBlock {
  /** Hex identity id. */
  id: string
  blocked: boolean
  changedAt: number
}

interface CacheData {
  convs: Record<string, ConvCache>
  /** day number → invites seen at bucket levels 0, 1, 2. */
  inviteDays: Record<string, [number, number, number]>
  lastSweep: number
  migrationNoticeSeen: boolean
  /** hex identity id → the newest block or unblock made on this device. */
  blocks: Record<string, { blocked: boolean; changedAt: number }>
}

const empty = (): CacheData => ({ convs: {}, inviteDays: {}, lastSweep: 0, migrationNoticeSeen: false, blocks: {} })

const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

function isPointer(value: unknown): value is MessagePointer {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return ['w', 'j', 'b', 'r'].every((k) => Number.isInteger(p[k]) && (p[k] as number) >= 0)
}

function parse(raw: string | null): CacheData {
  if (!raw) return empty()
  try {
    const value = JSON.parse(raw) as Partial<CacheData>
    const data = empty()
    for (const [key, conv] of Object.entries(value.convs ?? {})) {
      const heads: Record<string, MessagePointer> = {}
      for (const [sender, p] of Object.entries(conv?.heads ?? {})) if (isPointer(p)) heads[sender] = p
      data.convs[key] = {
        heads,
        ...(isPointer(conv?.oldestOwn) ? { oldestOwn: conv.oldestOwn } : {}),
        ...(conv?.hasText === true ? { hasText: true } : {}),
        ...(conv?.left === true ? { left: true } : {}),
        ...(isTime(conv?.readAt) ? { readAt: conv.readAt } : {}),
        ...(isTime(conv?.hiddenAt) ? { hiddenAt: conv.hiddenAt } : {}),
      }
    }
    for (const [id, block] of Object.entries(value.blocks ?? {})) {
      if (typeof block?.blocked === 'boolean' && isTime(block.changedAt)) data.blocks[id] = { blocked: block.blocked, changedAt: block.changedAt }
    }
    for (const [day, counts] of Object.entries(value.inviteDays ?? {})) {
      if (Array.isArray(counts) && counts.length === 3 && counts.every((n) => Number.isFinite(n))) {
        data.inviteDays[day] = [counts[0], counts[1], counts[2]]
      }
    }
    data.lastSweep = Number.isFinite(value.lastSweep) ? Number(value.lastSweep) : 0
    data.migrationNoticeSeen = value.migrationNoticeSeen === true
    return data
  } catch {
    return empty()
  }
}

/** The bucket level of a scanned invite: bucket 1 is level 0, 2–3 level 1, 4–7 level 2. */
function levelOf(bucket: number): 0 | 1 | 2 {
  return bucket >= 4 ? 2 : bucket >= 2 ? 1 : 0
}

export class LocalCache {
  private data: CacheData
  private dirty = false

  constructor(
    private readonly kv: KeyValueStore,
    private readonly key: string
  ) {
    this.data = parse(kv.get(key))
  }

  private conv(convKey: string): ConvCache {
    const existing = this.data.convs[convKey]
    if (existing) return existing
    const created: ConvCache = { heads: {} }
    this.data.convs[convKey] = created
    return created
  }

  heads(convKey: string): Record<string, MessagePointer> {
    return this.data.convs[convKey]?.heads ?? {}
  }

  /** Remember `p` as the sender's newest message if it is newer than what is known. */
  noteHead(convKey: string, senderHex: string, p: MessagePointer): void {
    const conv = this.conv(convKey)
    const known = conv.heads[senderHex]
    if (known && comparePointers(known, p) >= 0) return
    conv.heads[senderHex] = { w: p.w, j: p.j, b: p.b, r: p.r }
    this.dirty = true
  }

  hasText(convKey: string): boolean {
    return this.data.convs[convKey]?.hasText === true
  }

  noteText(convKey: string): void {
    const conv = this.conv(convKey)
    if (conv.hasText) return
    conv.hasText = true
    this.dirty = true
  }

  hasLeft(convKey: string): boolean {
    return this.data.convs[convKey]?.left === true
  }

  noteLeft(convKey: string): void {
    this.conv(convKey).left = true
    this.dirty = true
  }

  /** The read and hidden positions last set on this device, if any. */
  positions(convKey: string): { readAt?: number; hiddenAt?: number } | null {
    const conv = this.data.convs[convKey]
    if (!conv || (conv.readAt === undefined && conv.hiddenAt === undefined)) return null
    return { readAt: conv.readAt, hiddenAt: conv.hiddenAt }
  }

  /** Remember a conversation's positions; like the self-state merge, each only moves forward. */
  notePositions(convKey: string, readAt: number, hiddenAt: number): void {
    const known = this.data.convs[convKey]
    const read = readAt > (known?.readAt ?? 0)
    const hidden = hiddenAt > (known?.hiddenAt ?? 0)
    if (!read && !hidden) return
    const conv = this.conv(convKey)
    if (read) conv.readAt = readAt
    if (hidden) conv.hiddenAt = hiddenAt
    this.dirty = true
  }

  blocks(): CachedBlock[] {
    return Object.entries(this.data.blocks).map(([id, block]) => ({ id, ...block }))
  }

  /** Remember a block entry; the newer change wins, as in the self-state merge. */
  noteBlock(block: CachedBlock): void {
    const known = this.data.blocks[block.id]
    if (known && known.changedAt >= block.changedAt) return
    this.data.blocks[block.id] = { blocked: block.blocked, changedAt: block.changedAt }
    this.dirty = true
  }

  oldestOwn(convKey: string): MessagePointer | null {
    return this.data.convs[convKey]?.oldestOwn ?? null
  }

  setOldestOwn(convKey: string, p: MessagePointer | null): void {
    const conv = this.conv(convKey)
    if (p) conv.oldestOwn = { w: p.w, j: p.j, b: p.b, r: p.r }
    else delete conv.oldestOwn
    this.dirty = true
  }

  get lastSweep(): number {
    return this.data.lastSweep
  }

  set lastSweep(value: number) {
    this.data.lastSweep = value
    this.dirty = true
  }

  get migrationNoticeSeen(): boolean {
    return this.data.migrationNoticeSeen
  }

  set migrationNoticeSeen(value: boolean) {
    this.data.migrationNoticeSeen = value
    this.dirty = true
  }

  /** Count an invite a scan saw, by the day it was created and its bucket level. */
  recordInvite(bucket: number, createdAt: number, now: number): void {
    const day = Math.floor(createdAt / DAY_MS)
    const today = Math.floor(now / DAY_MS)
    if (day <= today - RATE_WINDOW_DAYS) return
    const counts = this.data.inviteDays[day] ?? [0, 0, 0]
    counts[levelOf(bucket)] += 1
    this.data.inviteDays[day] = counts
    for (const key of Object.keys(this.data.inviteDays)) {
      if (Number(key) <= today - RATE_WINDOW_DAYS) delete this.data.inviteDays[key]
    }
    this.dirty = true
  }

  /** The sender's bucket level `k` from this device's last 30 days of scans; 0 with no history (§5.1.2). */
  bucketLevel(): number {
    const days = Object.values(this.data.inviteDays)
    if (days.length === 0) return senderBucketLevel(null)
    const sum = (i: 0 | 1 | 2) => days.reduce((total, counts) => total + counts[i], 0) / RATE_WINDOW_DAYS
    return senderBucketLevel({ level0: sum(0), level1: sum(1), level2: sum(2) })
  }

  persist(): void {
    if (!this.dirty) return
    this.kv.set(this.key, JSON.stringify(this.data))
    this.dirty = false
  }
}
