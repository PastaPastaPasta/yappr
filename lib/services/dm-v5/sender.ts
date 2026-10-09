/**
 * Sending (docs/DM_V5.md §6.3 SEND, §6.1).
 *
 * A message goes to the next free `j` of this week on my stream in the
 * conversation's current epoch, with `prev` pointing at my newest message in
 * the conversation (any epoch). A unique-index rejection (40105: my other
 * device or a squatter took the tag) retries at `j + 1`. Only a broadcast
 * whose result is uncertain (the DAPI timeout) is read back, and only the
 * exact body counts as landed (my other device writes the same tags with the
 * same key): a slot someone else holds means this broadcast was refused, so
 * it moves on; an empty one is broadcast again with the same bytes, and a
 * 40105 on that second try is checked the same way, since it is usually the
 * first try landing.
 */

import { bytesEqual } from '@/lib/bytes'
import { encryptMessage, type EncryptedMessage } from '@/lib/dm/stream'
import type { DmContent, MessagePointer } from '@/lib/dm/types'
import { currentEpoch, newestOwn, stream, type Conv, type HeldMessage, type StreamState } from './conversation'
import { curWeek, type DmContext } from './context'
import { applyGroups, isFresh } from './group-apply'
import { fetchWants, historyWants, receive, streamWants } from './poller'
import type { BeforeWrite, ChainMessage } from './types'
import { MAX_LOOKBACK_WEEKS, STALE_WINDOW_MS, hexId, pointerKey } from './util'
import { withNonceRetry } from './write-failure'

const MAX_J_ATTEMPTS = 20

/**
 * How far the chain's clock can trail real time. `chain.now()` is the newest
 * block time a read returned, and a quiet Platform network makes a block only
 * every 3 minutes, so between messages it is up to that much behind.
 */
const BLOCK_TIME_LAG_MS = 3 * 60_000

export class SendError extends Error {}

/**
 * The time to show for a message I just wrote (QA D-L4i-007): it lands in a
 * block made after the send, so the chain's (stale) time is caught up to the
 * device clock, but never by more than the block time lag. Shown only: the
 * message's order, the read position and weeks stay on block time (§4.1), so
 * a device clock that runs fast moves none of them.
 */
function sentAt(ctx: DmContext): number {
  const chainTime = ctx.chain.now()
  return Math.max(chainTime, Math.min(ctx.wallClock(), chainTime + BLOCK_TIME_LAG_MS))
}

/**
 * Catch up on my own stream for this conversation before choosing `j`: a
 * closed conversation's own streams are not polled (§6.3), so without this a
 * send after my other device wrote would start with a collision.
 */
async function syncOwnStream(ctx: DmContext, conv: Conv, st: StreamState): Promise<void> {
  const cw = curWeek(ctx)
  // With nothing known, look back as far as a stream is ever probed, so `prev` links to my
  // real newest message and the sweep's chain stays whole (§5.6, §6.1). On a group that
  // includes my streams on the older epochs the roster's log names: my first send after an
  // epoch change links back across it.
  const floor = Math.max(conv.entry.since, cw - MAX_LOOKBACK_WEEKS)
  await fetchWants(ctx, [...streamWants(conv, st, floor, cw), ...historyWants(conv, [ctx.me.id], floor, cw)])
}

/**
 * What holds my slot after an uncertain broadcast: `landed` (this very body),
 * `taken` (any other document: my other device's message, or a squat) or
 * `empty`. One read, so a landing between two reads can never look like
 * someone else's. Only the exact body counts as landed: my other device
 * writes the same tags with the same key, and each seal draws a fresh IV.
 */
async function slotAfter(ctx: DmContext, tag: Uint8Array, body: Uint8Array): Promise<{ state: 'landed' | 'taken'; doc: ChainMessage } | { state: 'empty' }> {
  const [doc] = await ctx.chain.messagesByTags([tag])
  if (!doc) return { state: 'empty' }
  return { state: bytesEqual(doc.ownerId, ctx.me.id) && bytesEqual(doc.body, body) ? 'landed' : 'taken', doc }
}

/** Write one message of `content` on my stream. Returns what was held for it. `beforeWrite` runs before each broadcast. */
export async function sendContent(ctx: DmContext, conv: Conv, content: DmContent, beforeWrite?: BeforeWrite): Promise<HeldMessage> {
  if (conv.kind === 'group') {
    // Never send on an old epoch: a refresh that did not reach the chain leaves the group as it
    // was, and a member removed since could read the message. The text stays in the composer.
    if (!isFresh(ctx, conv) && !(await applyGroups(ctx, [conv]))) {
      throw new SendError('Could not check the group for changes. Try again in a moment.')
    }
    // Left: the owner removes me later (§6.4), but nothing more goes out from here meanwhile.
    if (conv.removed || conv.ended || ctx.cache.hasLeft(conv.key)) throw new SendError('You are no longer a member of this group.')
    if (conv.unreadable) throw new SendError('Ask the group owner to resend your keys.')
  }
  const epoch = currentEpoch(conv)
  const st = stream(conv, ctx.me.id, epoch)
  if (!st) throw new SendError('This conversation cannot be written to yet: the other side has no encryption key.')
  await syncOwnStream(ctx, conv, st)

  const w = curWeek(ctx)
  let j = st.cur && st.cur.w === w ? st.cur.j + 1 : 0
  let prev: MessagePointer | null = newestOwn(conv, ctx.me.id)?.pointer ?? null
  let retriedUncertain = false

  // One sealed body per slot: a rebroadcast after an uncertain result must be the same bytes, so a
  // late landing of the first broadcast is recognised as this message (a fresh IV would not match).
  let sealed: (EncryptedMessage & { j: number }) | undefined
  for (let attempt = 0; attempt < MAX_J_ATTEMPTS; attempt++) {
    if (sealed?.j !== j) sealed = { j, ...(await encryptMessage({ streamKey: st.key, senderId: ctx.me.id, w, j }, { prev, content })) }
    const { tag, body } = sealed
    // A nonce clash with my other device writes nothing: the same slot is retried after a backoff
    // (with a fresh nonce); if its message took the slot, the 40105 path below moves on.
    const outcome = await withNonceRetry(() => {
      beforeWrite?.()
      return ctx.chain.createMessage(tag, body)
    }, ctx.sleep)
    const pointer = { w, j, b: epoch.b, r: epoch.r }
    if (outcome.ok && outcome.confirmed) return hold(ctx, conv, st, pointer, outcome.id, content, prev)
    // A refusal other than a taken slot ends the send, unless an earlier uncertain broadcast of this
    // same body is what landed (then the user's retry would send it twice).
    if (!outcome.ok && outcome.failure !== 'duplicate') {
      const slot = retriedUncertain ? await slotAfter(ctx, tag, body) : null
      if (slot?.state === 'landed') return hold(ctx, conv, st, pointer, slot.doc.id, content, prev)
      throw new SendError(outcome.error)
    }
    if (outcome.ok) {
      // Uncertain (a timeout): one read of the slot decides.
      const slot = await slotAfter(ctx, tag, body)
      if (slot.state === 'landed') return hold(ctx, conv, st, pointer, slot.doc.id, content, prev)
      if (slot.state === 'taken') await adopt(ctx, conv, st, w, j, slot.doc)
      if (slot.state === 'empty') {
        // Nothing there yet: broadcast the same bytes once more, so a late landing reads as `landed`.
        // A second uncertain result with nothing visible is taken on trust (the DAPI quirk).
        if (retriedUncertain) return hold(ctx, conv, st, pointer, outcome.id, content, prev, body)
        retriedUncertain = true
        attempt--
        continue
      }
    } else {
      // A taken slot (40105). After an uncertain broadcast, that broadcast may be what took it.
      const slot = await slotAfter(ctx, tag, body)
      if (slot.state === 'landed') return hold(ctx, conv, st, pointer, slot.doc.id, content, prev)
      if (slot.state === 'taken') await adopt(ctx, conv, st, w, j, slot.doc)
    }
    // Someone else's document holds the slot (my other device's message, or a squat): move on,
    // linking `prev` to my other device's message if that is what it was, so the stream stays one chain.
    prev = newestOwn(conv, ctx.me.id)?.pointer ?? null
    j += 1
    retriedUncertain = false
  }
  throw new SendError('Could not find a free message slot. Try again in a moment.')
}

/**
 * Hold the document that took my slot if it is my other device's message
 * (`receive` accepts only the stream sender's documents that decrypt), so the
 * next attempt's `prev` points at it. A squat is ignored.
 */
async function adopt(ctx: DmContext, conv: Conv, st: StreamState, w: number, j: number, doc: ChainMessage): Promise<void> {
  if (bytesEqual(doc.ownerId, ctx.me.id)) await receive(ctx, conv, st, w, j, doc, { backfilling: true })
}

/**
 * Hold my message at `pointer`. A confirmed create, or a slot read that found
 * this very body, is on the chain. One held on trust (two uncertain
 * broadcasts, the slot empty after each; `trustBody` is what they sent) is
 * not known to be: it stays `local` until a poll reads exactly that body
 * back. The cursor moves past it all the same (the next send must not reuse
 * its slot), so its slot is polled as a stale tag for the stale window: the
 * stream's next tag never asks for it again.
 */
function hold(
  ctx: DmContext,
  conv: Conv,
  st: StreamState,
  pointer: MessagePointer,
  docId: string,
  content: DmContent,
  prev: MessagePointer | null,
  trustBody?: Uint8Array
): HeldMessage {
  const trust = trustBody ? { local: true, body: trustBody } : {}
  const held: HeldMessage = { sender: ctx.me.id, pointer, docId, createdAt: ctx.chain.now(), sentAt: sentAt(ctx), content, prev, ...trust }
  conv.held.set(pointerKey(ctx.me.id, pointer), held)
  if (!st.cur || pointer.w > st.cur.w || (pointer.w === st.cur.w && pointer.j > st.cur.j)) st.cur = { w: pointer.w, j: pointer.j }
  if (trustBody) st.stale.push({ w: pointer.w, j: pointer.j, until: ctx.chain.now() + STALE_WINDOW_MS, held: true })
  ctx.cache.noteHead(conv.key, hexId(ctx.me.id), pointer)
  if (content.type === 'text') ctx.cache.noteText(conv.key)
  // Sending is reading: my own message moves the read position past everything before it.
  ctx.store.touch(conv.entry, { readAt: held.createdAt })
  ctx.cache.notePositions(conv.key, conv.entry.readAt, conv.entry.hiddenAt)
  return held
}
