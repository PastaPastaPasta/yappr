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
import { applyGroups } from './group-apply'
import { fetchWants, historyWants, receive, streamWants } from './poller'
import type { ChainMessage } from './types'
import { GROUP_FRESHNESS_MS, MAX_LOOKBACK_WEEKS, hexId, pointerKey } from './util'
import { withNonceRetry } from './write-failure'

const MAX_J_ATTEMPTS = 20

export class SendError extends Error {}

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

/** Write one message of `content` on my stream. Returns what was held for it. */
export async function sendContent(ctx: DmContext, conv: Conv, content: DmContent): Promise<HeldMessage> {
  if (conv.kind === 'group') {
    // Never send on an old epoch: a refresh that did not reach the chain leaves the group as it
    // was, and a member removed since could read the message. The text stays in the composer.
    if (ctx.clock() - conv.appliedAt > GROUP_FRESHNESS_MS && !(await applyGroups(ctx, [conv]))) {
      throw new SendError('Could not check the group for changes. Try again in a moment.')
    }
    if (conv.removed || conv.ended) throw new SendError('You are no longer a member of this group.')
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
    const outcome = await withNonceRetry(() => ctx.chain.createMessage(tag, body), ctx.sleep)
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
        if (retriedUncertain) return hold(ctx, conv, st, pointer, outcome.id, content, prev)
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

function hold(ctx: DmContext, conv: Conv, st: StreamState, pointer: MessagePointer, docId: string, content: DmContent, prev: MessagePointer | null): HeldMessage {
  const held: HeldMessage = { sender: ctx.me.id, pointer, docId, createdAt: ctx.chain.now(), content, prev, local: true }
  conv.held.set(pointerKey(ctx.me.id, pointer), held)
  if (!st.cur || pointer.w > st.cur.w || (pointer.w === st.cur.w && pointer.j > st.cur.j)) st.cur = { w: pointer.w, j: pointer.j }
  ctx.cache.noteHead(conv.key, hexId(ctx.me.id), pointer)
  if (content.type === 'text') ctx.cache.noteText(conv.key)
  // Sending is reading: my own message moves the read position past everything before it.
  ctx.store.touch(conv.entry, { readAt: held.createdAt })
  return held
}
