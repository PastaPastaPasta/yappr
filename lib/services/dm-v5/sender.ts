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
import { encryptMessage, messageTag, type EncryptedMessage } from '@/lib/dm/stream'
import type { DmContent, MessagePointer } from '@/lib/dm/types'
import { currentEpoch, newestOwn, stream, type Conv, type HeldMessage, type StreamState } from './conversation'
import { curWeek, type DmContext } from './context'
import { applyGroups } from './group-apply'
import { fetchWants, streamWants } from './poller'
import type { ChainMessage } from './types'
import { GROUP_FRESHNESS_MS, MAX_LOOKBACK_WEEKS, hexId, pointerKey } from './util'

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
  // real newest message and the sweep's chain stays whole (§5.6, §6.1).
  await fetchWants(ctx, streamWants(conv, st, Math.max(conv.entry.since, cw - MAX_LOOKBACK_WEEKS), cw))
}

/**
 * Did this broadcast land at `(w, j)`? (The read-back after an uncertain one.)
 * Only the exact body counts: my other device writes the same tags with the
 * same key, so a document that is mine and decrypts may be its message, not
 * this one. Each seal draws a fresh random IV, so another send never matches.
 */
async function landed(ctx: DmContext, st: StreamState, w: number, j: number, body: Uint8Array): Promise<ChainMessage | null> {
  const [doc] = await ctx.chain.messagesByTags([messageTag(st.key, w, j)])
  return doc && bytesEqual(doc.ownerId, ctx.me.id) && bytesEqual(doc.body, body) ? doc : null
}

/** Write one message of `content` on my stream. Returns what was held for it. */
export async function sendContent(ctx: DmContext, conv: Conv, content: DmContent): Promise<HeldMessage> {
  if (conv.kind === 'group') {
    if (ctx.chain.now() - conv.appliedAt > GROUP_FRESHNESS_MS) await applyGroups(ctx, [conv])
    if (conv.removed || conv.ended) throw new SendError('You are no longer a member of this group.')
    if (conv.unreadable) throw new SendError('Ask the group owner to resend your keys.')
  }
  const epoch = currentEpoch(conv)
  const st = stream(conv, ctx.me.id, epoch)
  if (!st) throw new SendError('This conversation cannot be written to yet: the other side has no encryption key.')
  await syncOwnStream(ctx, conv, st)

  const w = curWeek(ctx)
  let j = st.cur && st.cur.w === w ? st.cur.j + 1 : 0
  const prev: MessagePointer | null = newestOwn(conv, ctx.me.id)?.pointer ?? null
  let retriedUncertain = false

  // One sealed body per slot: a rebroadcast after an uncertain result must be the same bytes, so a
  // late landing of the first broadcast is recognised as this message (a fresh IV would not match).
  let sealed: (EncryptedMessage & { j: number }) | undefined
  for (let attempt = 0; attempt < MAX_J_ATTEMPTS; attempt++) {
    if (sealed?.j !== j) sealed = { j, ...(await encryptMessage({ streamKey: st.key, senderId: ctx.me.id, w, j }, { prev, content })) }
    const { tag, body } = sealed
    const outcome = await ctx.chain.createMessage(tag, body)
    if (outcome.ok) {
      if (!outcome.confirmed && !(await landed(ctx, st, w, j, body))) {
        // Not there as sent. If the slot holds someone else's document (my other device's, or a
        // squat), this broadcast was refused: move on. If it is empty, broadcast once more.
        const [taken] = await ctx.chain.messagesByTags([tag])
        if (taken) {
          j += 1
          continue
        }
        if (!retriedUncertain) {
          retriedUncertain = true
          attempt--
          continue
        }
      }
      return hold(ctx, conv, st, { w, j, b: epoch.b, r: epoch.r }, outcome.id, content, prev)
    }
    if (outcome.failure !== 'duplicate') throw new SendError(outcome.error)
    if (retriedUncertain) {
      // The first (uncertain) broadcast of this very body may be what took the slot.
      const doc = await landed(ctx, st, w, j, body)
      if (doc) return hold(ctx, conv, st, { w, j, b: epoch.b, r: epoch.r }, doc.id, content, prev)
      retriedUncertain = false
    }
    j += 1
  }
  throw new SendError('Could not find a free message slot. Try again in a moment.')
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
