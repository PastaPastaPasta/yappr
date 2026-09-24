/** Small pure helpers shared by the DM v5 client modules. */

import { bytesEqual, bytesToHex } from '@/lib/bytes'
import { ratchetTo } from '@/lib/dm/keys'
import { MESSAGE_CLASSES, maxPlaintextLength } from '@/lib/dm/padding'
import { PREV_LENGTH } from '@/lib/dm/stream'
import type { Epoch, IdentityId, MessagePointer, RetentionSetting } from '@/lib/dm/types'

export const DAY_MS = 86_400_000

/** The §6.3 stale window: an old week's or epoch's next tag stays polled this long. */
export const STALE_WINDOW_MS = 10 * 60_000
/** How far back a stream is probed (§6.3), and the backfill horizon. */
export const MAX_LOOKBACK_WEEKS = 52
/** Tags or handles per `in` query. */
export const TAGS_PER_QUERY = 100
/** A group is re-read before a send if its documents were last polled longer ago than this (§6.3 SEND). */
export const GROUP_FRESHNESS_MS = 10_000

export const RETENTION_MS: Record<RetentionSetting, number | null> = {
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  '1y': 365 * DAY_MS,
  never: null,
}

/** Most UTF-8 bytes of text one message carries: the largest class minus length prefix, `prev` and type. */
export const MAX_TEXT_BYTES = maxPlaintextLength(MESSAGE_CLASSES) - PREV_LENGTH - 1

export const hexId = bytesToHex

/** Runs a task on the engine's serial queue, so background work never races the poll loop or a send. */
export type Exclusive = <T>(task: () => Promise<T>) => Promise<T>
/** No queue: run the task at once (tests, and callers already on the queue). */
export const runNow: Exclusive = (task) => task()

export const directKey = (peer: IdentityId): string => `d:${hexId(peer)}`
export const groupKey = (owner: IdentityId, gid: Uint8Array): string => `g:${hexId(owner)}:${hexId(gid)}`

export const pointerKey = (sender: IdentityId, p: MessagePointer): string => `${hexId(sender)}|${p.b}.${p.r}|${p.w}.${p.j}`

/** Stream order: epoch first, then week and index. */
export function comparePointers(a: MessagePointer, b: MessagePointer): number {
  return a.b - b.b || a.r - b.r || a.w - b.w || a.j - b.j
}

export const sameEpoch = (a: Epoch, b: Epoch): boolean => a.b === b.b && a.r === b.r

export const includesId = (ids: readonly IdentityId[], id: IdentityId): boolean => ids.some((m) => bytesEqual(m, id))

/**
 * Split text into pieces of at most `maxBytes` UTF-8 bytes on code point
 * boundaries (§5.7: longer text is split across messages).
 */
export function splitText(text: string, maxBytes = MAX_TEXT_BYTES): string[] {
  const encoder = new TextEncoder()
  const pieces: string[] = []
  let current = ''
  let size = 0
  for (const char of text) {
    const length = encoder.encode(char).length
    if (size + length > maxBytes && current) {
      pieces.push(current)
      current = ''
      size = 0
    }
    current += char
    size += length
  }
  if (current) pieces.push(current)
  return pieces
}

function randomBelow(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  do {
    crypto.getRandomValues(buf)
  } while (buf[0] >= limit)
  return buf[0] % n
}

/** A uniformly shuffled copy (the sweep deletes a week's messages in random order, §5.6). */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Items grouped by `keyOf`, in first-seen order. */
export function groupBy<K, T>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of Array.from(items)) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}

/** An inclusive integer range. Empty when `from > to`. */
export function range(from: number, to: number): number[] {
  return from > to ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/**
 * The group keys a reader holds: per base, the lowest ratchet step known and
 * its key. `K[b, r]` for any later `r` is one-way derivable (§4.4).
 */
export class EpochKeys {
  private readonly bases = new Map<number, { r: number; key: Uint8Array }>()
  private readonly memo = new Map<string, Uint8Array>()

  set(epoch: Epoch, key: Uint8Array): void {
    const known = this.bases.get(epoch.b)
    if (!known || epoch.r < known.r) this.bases.set(epoch.b, { r: epoch.r, key })
  }

  /**
   * Make `key` base `b`'s key at step 0, whatever was held for it: the
   * keyring on chain is the only real `K[b,0]` (a losing keyring race can
   * leave another one behind locally, §4.4).
   */
  replaceBase(b: number, key: Uint8Array): void {
    this.bases.set(b, { r: 0, key })
    for (const id of Array.from(this.memo.keys())) if (id.startsWith(`${b}.`)) this.memo.delete(id)
  }

  /** The lowest known step of base `b` and its key. */
  lowest(b: number): (Epoch & { key: Uint8Array }) | null {
    const known = this.bases.get(b)
    return known ? { b, r: known.r, key: known.key } : null
  }

  get(epoch: Epoch): Uint8Array | null {
    const known = this.bases.get(epoch.b)
    if (!known || epoch.r < known.r) return null
    const id = `${epoch.b}.${epoch.r}`
    const cached = this.memo.get(id)
    if (cached) return cached
    const key = ratchetTo(known.key, epoch.b, known.r, epoch.r)
    this.memo.set(id, key)
    return key
  }
}
