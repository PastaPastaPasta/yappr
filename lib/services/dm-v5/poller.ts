/**
 * The DM v5 client loop (docs/DM_V5.md §6.3): POLL, DRAIN, RECEIVE, BACKFILL.
 * Group documents (APPLY/SWITCH) live in `group-apply.ts`, invites in
 * `invites.ts`, grants in `grants.ts`; `pollOnce` runs them in the spec's
 * order.
 *
 * Streams are polled for their NEXT tag. A hit pulls the rest of that week
 * (DRAIN). A message whose `prev` points strictly backwards at something not
 * held triggers a walk back along `prev` (BACKFILL). An old week's or epoch's
 * next tag stays polled for the 10-minute stale window.
 */

import { bytesEqual, hexToBytes } from '@/lib/bytes'
import { weekOf } from '@/lib/dm/kdf'
import { epochBefore } from '@/lib/dm/keys'
import { isStrictlyBefore, messageTag, tryDecryptMessage } from '@/lib/dm/stream'
import type { Epoch, IdentityId, MessagePointer } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import {
  currentEpoch,
  isHeld,
  isMember,
  members,
  stream,
  type Conv,
  type GroupConv,
  type HeldMessage,
  type StreamState,
} from './conversation'
import { curWeek, isMe, type DmContext } from './context'
import type { ChainMessage } from './types'
import { MAX_LOOKBACK_WEEKS, STALE_WINDOW_MS, TAGS_PER_QUERY, groupBy, hexId, pointerKey, range } from './util'

/** Hard stop for one backfill walk, in queries. */
const MAX_BACKFILL_QUERIES = 60

type WantKind = 'next' | 'week' | 'stale' | 'resume'

export interface Want {
  conv: Conv
  st: StreamState
  w: number
  j: number
  kind: WantKind
  /** A history probe of an old epoch's stream from this week: recorded once the query succeeded. */
  historyFloor?: number
}

/** Stream order within one stream: week, then index. */
const byWeekThenIndex = (a: { w: number; j: number }, b: { w: number; j: number }) => a.w - b.w || a.j - b.j

// ---------------------------------------------------------------------------
// What to poll

/**
 * A conversation's streams are polled only when their keys are held and the
 * conversation is live. An ended group is still read while its thread is
 * open, so its history stays visible (§6.4); it is never polled in the
 * background.
 */
function pollable(conv: Conv): boolean {
  if (conv.kind === 'direct') return conv.convKey !== null
  return !conv.removed && !conv.unreadable && (!conv.ended || conv.open)
}

/**
 * The lowest week a stream with nothing held is probed from:
 * `max(week(readAt), since, curWeek − 52)`, or from `since` once the thread
 * was opened (§6.3).
 */
function historyFloor(conv: Conv, cw: number): number {
  const readWeek = conv.deepProbe ? 0 : weekOf(conv.entry.readAt)
  return Math.max(readWeek, conv.entry.since, cw - MAX_LOOKBACK_WEEKS)
}

/** `historyFloor`, and never before the current epoch's switch week. */
function probeFloor(conv: Conv, cw: number): number {
  const floor = historyFloor(conv, cw)
  return conv.kind === 'group' && conv.epochSinceWeek !== null ? Math.max(floor, conv.epochSinceWeek) : floor
}

/**
 * The epochs before the current one that the roster's epoch log names (§5.4),
 * each with the weeks it spans: from its start week to the next epoch's (a
 * message can be signed on the old epoch in the week the new one starts), or
 * to the current week for the last one.
 */
function pastEpochs(conv: GroupConv, cw: number): Array<{ epoch: Epoch; from: number; to: number }> {
  const log = conv.lastRoster?.epochLog ?? []
  return log.flatMap((entry, i) => (epochBefore(entry, conv.epoch) ? [{ epoch: entry, from: entry.startWeek, to: log[i + 1]?.startWeek ?? cw }] : []))
}

/**
 * History discovery (§6.3): probe each older epoch's stream of `senders` over
 * that epoch's weeks, cut to `floor`..`cw`, when this reader holds the epoch's
 * key. A hit drains its week and walks back along `prev`, so the older weeks
 * are reached from the newest message found. Each stream is probed once per
 * floor: a deeper floor (the thread opened) probes again, further back.
 */
export function historyWants(conv: Conv, senders: IdentityId[], floor: number, cw: number): Want[] {
  if (conv.kind !== 'group') return []
  const wants: Want[] = []
  for (const { epoch, from, to } of pastEpochs(conv, cw)) {
    const lo = Math.max(from, floor)
    const hi = Math.min(to, cw)
    if (lo > hi) continue
    for (const sender of senders) {
      const st = stream(conv, sender, epoch)
      if (!st || (st.historyFrom !== null && st.historyFrom <= lo)) continue
      wants.push(...streamWants(conv, st, lo, hi).map((want) => ({ ...want, historyFloor: lo })))
    }
  }
  return wants
}

/**
 * A stream's wanted tags (§6.3 POLL): its next tag (or the cached `resume`
 * probe), then `j = 0` of every later week not yet found empty. With nothing
 * known, the weeks start at `floor`.
 */
export function streamWants(conv: Conv, st: StreamState, floor: number, cw: number): Want[] {
  const wants: Want[] = []
  const from = st.cur ?? st.resume
  if (st.cur) wants.push({ conv, st, w: st.cur.w, j: st.cur.j + 1, kind: 'next' })
  else if (st.resume) wants.push({ conv, st, w: st.resume.w, j: st.resume.j, kind: 'resume' })
  for (const w of range(from ? from.w + 1 : floor, cw)) {
    if (!st.probed.has(w)) wants.push({ conv, st, w, j: 0, kind: 'week' })
  }
  return wants
}

/** Every tag this poll asks for: each member's next tag, plus live stale tags. */
export function collectWants(ctx: DmContext, only?: Conv): Want[] {
  const now = ctx.chain.now()
  const cw = curWeek(ctx)
  const wants: Want[] = []
  for (const conv of only ? [only] : Array.from(ctx.convs.values())) {
    for (const st of Array.from(conv.streams.values())) {
      st.stale = st.stale.filter((s) => s.until > now)
      for (const s of st.stale) wants.push({ conv, st, w: s.w, j: s.j, kind: 'stale' })
    }
    if (!pollable(conv)) continue
    const epoch = currentEpoch(conv)
    // Own streams catch this user's other devices: only when it matters (§6.3).
    const senders = members(conv, ctx.me.id).filter((sender) => !isMe(ctx, sender) || conv.open || conv.probeOwn || ctx.appJustOpened)
    for (const sender of senders) {
      const st = stream(conv, sender, epoch)
      if (st) wants.push(...streamWants(conv, st, probeFloor(conv, cw), cw))
    }
    wants.push(...historyWants(conv, senders, historyFloor(conv, cw), cw))
  }
  return wants
}

// ---------------------------------------------------------------------------
// Fetching

/**
 * Fetch tags `(w, js)` of one stream. `found` holds the stream sender's
 * documents by index; `occupied` every index that holds any document, a
 * squat included (§6.1): never a message, but a slot the sender moved past.
 */
async function fetchStreamRange(ctx: DmContext, st: StreamState, w: number, js: number[]): Promise<{ found: Map<number, ChainMessage>; occupied: number[] }> {
  const tags = js.map((j) => messageTag(st.key, w, j))
  const byTag = new Map(tags.map((tag, i) => [hexId(tag), js[i]]))
  const found = new Map<number, ChainMessage>()
  const occupied: number[] = []
  for (const doc of await ctx.chain.messagesByTags(tags)) {
    const j = byTag.get(hexId(doc.tag))
    if (j === undefined) continue
    occupied.push(j)
    // Readers accept a document only if its $ownerId is the stream's sender (§6.1).
    if (bytesEqual(doc.ownerId, st.sender)) found.set(j, doc)
  }
  return { found, occupied }
}

// ---------------------------------------------------------------------------
// RECEIVE

export interface ReceiveOptions {
  /** Called from BACKFILL: do not start another walk. */
  backfilling?: boolean
}

export interface BackfillOptions {
  /** Walk past messages already read even while the thread is closed (the sweep). */
  full?: boolean
  /**
   * Oldest week to walk to. Defaults to the display lookback (52 weeks); the
   * sweep walks to the conversation's start so "1 year" retention, whose
   * deletable weeks lie beyond 52, still reaches its targets.
   */
  horizon?: number
}

/**
 * Decrypt and hold one document of `st` at `(w, j)` (§6.3 RECEIVE). Drops a
 * document that does not decrypt, and on a group, one written on an old base
 * by a sender no longer in the roster after the keyring removing them.
 */
export async function receive(
  ctx: DmContext,
  conv: Conv,
  st: StreamState,
  w: number,
  j: number,
  doc: ChainMessage,
  options: ReceiveOptions = {}
): Promise<HeldMessage | null> {
  if (!bytesEqual(doc.ownerId, st.sender)) return null
  const pointer: MessagePointer = { w, j, b: st.epoch.b, r: st.epoch.r }
  const key = pointerKey(st.sender, pointer)
  const existing = conv.held.get(key)
  if (existing) {
    if (existing.local) conv.held.set(key, { ...existing, docId: doc.id, createdAt: doc.createdAt, local: false })
    return null
  }
  const message = await tryDecryptMessage({ streamKey: st.key, senderId: st.sender, w, j }, doc.body)
  if (!message) return null

  if (conv.kind === 'group' && st.epoch.b < conv.epoch.b && !isMember(conv, st.sender, ctx.me.id)) {
    const removedAt = conv.keyringAt.get(st.epoch.b + 1)
    if (removedAt !== undefined && doc.createdAt > removedAt) return null
  }

  const held: HeldMessage = { sender: st.sender, pointer, docId: doc.id, createdAt: doc.createdAt, content: message.content, prev: message.prev }
  conv.held.set(key, held)
  ctx.cache.noteHead(conv.key, hexId(st.sender), pointer)
  onContent(ctx, conv, held)

  if (!options.backfilling && message.prev && isStrictlyBefore(message.prev, pointer) && !isHeld(conv, st.sender, message.prev)) {
    // A gap behind a message already read waits until the thread opens; one that may hide unread messages is filled now.
    if (conv.open || conv.deepProbe || doc.createdAt > conv.entry.readAt) await backfill(ctx, conv, st.sender, message.prev)
    else conv.deferred.push({ sender: st.sender, pointer: message.prev })
  }
  return held
}

/** Side effects of a message's type: text un-hides a 1:1; grants and leaves queue owner-side work. */
function onContent(ctx: DmContext, conv: Conv, held: HeldMessage): void {
  const { content } = held
  if (content.type === 'text') {
    ctx.cache.noteText(conv.key)
    return
  }
  if (content.type === 'grant' && conv.kind === 'direct' && !isMe(ctx, held.sender)) {
    const { grant } = content
    const id = `${hexId(held.sender)}:${hexId(grant.gid)}:${grant.b}.${grant.r}`
    if (!ctx.pendingGrants.has(id)) {
      ctx.pendingGrants.set(id, { from: held.sender, ...grant, createdAt: held.createdAt, firstSeen: ctx.chain.now() })
    }
    return
  }
  // A leave counts only on the current base: one from before a removal (reached later through `prev`,
  // e.g. after the member was added back) must not remove them again.
  if (content.type === 'leave' && conv.kind === 'group' && isMe(ctx, conv.owner) && !isMe(ctx, held.sender) && held.pointer.b === conv.epoch.b) {
    if (isMember(conv, held.sender, ctx.me.id)) ctx.pendingLeaves.set(`${conv.key}:${hexId(held.sender)}`, { conv, member: held.sender, retryAt: 0, failures: 0 })
  }
}

// ---------------------------------------------------------------------------
// BACKFILL

/**
 * Walk back along `prev` from `start` (§6.3 BACKFILL): fetch up to 100 tags
 * ending at the pointer, hold them, continue from the oldest one's `prev`.
 * Stops at a null `prev`, one that does not point strictly backwards, a
 * pointer already held, a key this reader lacks, or the lookback horizon.
 * While the thread is closed it stops at messages already read and leaves the
 * rest for when the thread opens.
 */
export async function backfill(ctx: DmContext, conv: Conv, sender: IdentityId, start: MessagePointer, options: BackfillOptions = {}): Promise<void> {
  const horizon = options.horizon ?? Math.max(conv.entry.since, curWeek(ctx) - MAX_LOOKBACK_WEEKS)
  let pointer: MessagePointer | null = start
  for (let queries = 0; pointer && queries < MAX_BACKFILL_QUERIES; queries++) {
    if (isHeld(conv, sender, pointer) || pointer.w < horizon) return
    const st = stream(conv, sender, pointer)
    if (!st) return
    const { found } = await fetchStreamRange(ctx, st, pointer.w, range(Math.max(0, pointer.j - (TAGS_PER_QUERY - 1)), pointer.j))
    if (!found.has(pointer.j)) return
    let oldest: HeldMessage | null = null
    for (const [j, doc] of Array.from(found.entries()).sort(([a], [b]) => b - a)) {
      const held = await receive(ctx, conv, st, pointer.w, j, doc, { backfilling: true })
      if (held) oldest = held
    }
    if (!oldest?.prev || !isStrictlyBefore(oldest.prev, oldest.pointer)) return
    if (!options.full && !conv.open && !conv.deepProbe && oldest.createdAt <= conv.entry.readAt) {
      conv.deferred.push({ sender, pointer: oldest.prev })
      return
    }
    pointer = oldest.prev
  }
}

/** Resume the backfills a closed thread stopped at `readAt` (called when it opens). */
export async function runDeferred(ctx: DmContext, conv: Conv): Promise<void> {
  const pending = conv.deferred.splice(0)
  for (const { sender, pointer } of pending) await backfill(ctx, conv, sender, pointer)
}

// ---------------------------------------------------------------------------
// DRAIN

/**
 * Take the rest of week `w` after a hit at `(w, j)` (§6.3 DRAIN): 100 tags per
 * query, holes are fine, until a page returns nothing. Returns the last index
 * found. `first` is null when the slot at `j` is squatted (§6.1): it holds no
 * message, but it is taken, so the stream reads on past it.
 */
async function drain(ctx: DmContext, conv: Conv, st: StreamState, w: number, j: number, first: ChainMessage | null): Promise<number> {
  if (first) await receive(ctx, conv, st, w, j, first)
  let last = j
  for (let from = j + 1; ; from += TAGS_PER_QUERY) {
    const { found, occupied } = await fetchStreamRange(ctx, st, w, range(from, from + TAGS_PER_QUERY - 1))
    if (occupied.length === 0) return last
    for (const [k, doc] of Array.from(found.entries()).sort(([a], [b]) => a - b)) {
      await receive(ctx, conv, st, w, k, doc)
      last = Math.max(last, k)
    }
    // Squatted slots right after the newest one held count as passed: the sender skips a squat only
    // when it meets it at its own next slot. One after a free slot does not, or the sender's later
    // message in that free slot would be behind the cursor.
    const taken = new Set(occupied)
    while (taken.has(last + 1)) last += 1
  }
}

/** Move a stream's cursor after a drain; a move into a later week keeps the old week's next tag stale. */
function advance(ctx: DmContext, st: StreamState, want: Want, last: number): void {
  if (want.kind === 'stale') {
    const entry = st.stale.find((s) => s.w === want.w && s.j === want.j)
    if (entry) entry.j = last + 1
    return
  }
  const cur = st.cur
  if (cur && want.w > cur.w) {
    st.stale.push({ w: cur.w, j: cur.j + 1, until: ctx.chain.now() + STALE_WINDOW_MS })
  }
  if (!cur || want.w > cur.w || (want.w === cur.w && last > cur.j)) st.cur = { w: want.w, j: last }
  st.resume = null
}

/** Ask for every wanted tag in one pass, then drain each hit, oldest first per stream. */
export async function fetchWants(ctx: DmContext, wants: Want[]): Promise<void> {
  if (wants.length === 0) return
  const byTag = new Map<string, Want>()
  for (const want of wants) byTag.set(hexId(messageTag(want.st.key, want.w, want.j)), want)
  const docs = await ctx.chain.messagesByTags(Array.from(byTag.keys()).map((hex) => hexToBytes(hex)))
  for (const { st, historyFloor } of wants) {
    if (historyFloor !== undefined && (st.historyFrom === null || historyFloor < st.historyFrom)) st.historyFrom = historyFloor
  }

  // A document at a wanted tag from anyone but the stream's sender is a squat (§6.1): never a
  // message, but the slot is taken and the sender has moved on to j + 1, so it counts as a hit
  // whose drain skips it. Otherwise a live reader would ask for that one tag until the week ends.
  const hitList: Array<{ want: Want; doc: ChainMessage | null }> = []
  for (const doc of docs) {
    const want = byTag.get(hexId(doc.tag))
    if (want) hitList.push({ want, doc: bytesEqual(doc.ownerId, want.st.sender) ? doc : null })
  }
  const hitWants = new Set(hitList.map((hit) => hit.want))
  const hits = groupBy(hitList, (hit) => hit.want.st)

  for (const [st, list] of Array.from(hits.entries())) {
    list.sort((a, b) => byWeekThenIndex(a.want, b.want))
    for (const { want, doc } of list) {
      try {
        const last = await drain(ctx, want.conv, st, want.w, want.j, doc)
        advance(ctx, st, want, last)
      } catch (error) {
        logger.warn('DM v5: draining a stream failed:', error)
      }
    }
  }

  // A resume probe that missed (the message was swept, or the cache is stale): fall back to the week scan.
  // An empty week the stale window has passed is never asked again (see StreamState.probed).
  const settled = weekOf(Math.max(0, ctx.chain.now() - STALE_WINDOW_MS))
  for (const want of wants) {
    if (hitWants.has(want)) continue
    if (want.kind === 'resume') want.st.resume = null
    if (want.kind === 'week' && want.w < settled) want.st.probed.add(want.w)
  }
}

/** One stream round: every wanted tag, drained. `only` limits it to one conversation. */
export async function pollStreams(ctx: DmContext, only?: Conv): Promise<void> {
  await fetchWants(ctx, collectWants(ctx, only))
}
