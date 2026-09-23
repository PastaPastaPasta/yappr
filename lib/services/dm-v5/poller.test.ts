import { describe, expect, it } from 'vitest'
import { weekOf, weekStart } from '@/lib/dm/kdf'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV } from '@/lib/dm/test-fixtures'
import { encryptMessage } from '@/lib/dm/stream'
import type { DmContent, MessagePointer } from '@/lib/dm/types'
import { stream, timeline, type DirectConv } from './conversation'
import { attachDirect, directConv, type DmContext } from './context'
import { ensureStarted, openDirect } from './directs'
import { pollOnce } from './loop'
import { collectWants, pollStreams, runDeferred } from './poller'
import { sendContent } from './sender'
import { MemoryLedger, makeContext, type MemoryChain } from './test-chain'
import { STALE_WINDOW_MS } from './util'

const WEEK = 604_800_000

function texts(ctx: DmContext, peer: Uint8Array): string[] {
  const conv = directConv(ctx, peer)
  return conv ? timeline(conv).flatMap((m) => (m.content.type === 'text' ? [m.content.text] : [])) : []
}

async function setup() {
  const ledger = new MemoryLedger()
  const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
  const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
  const conv = await openDirect(alice.ctx, BOB_ID)
  await ensureStarted(alice.ctx, conv)
  return { ledger, alice, bob, aliceConv: conv }
}

/**
 * Write a message on Alice's stream at an explicit (w, j) and prev, bypassing
 * the sender, the way a second device or a hostile client might.
 */
async function writeRaw(chain: MemoryChain, conv: DirectConv, w: number, j: number, prev: MessagePointer | null, content: DmContent) {
  const st = stream(conv, ALICE_ID, { b: 0, r: 0 })
  if (!st) throw new Error('no stream')
  const { tag, body } = await encryptMessage({ streamKey: st.key, senderId: ALICE_ID, w, j }, { prev, content })
  const outcome = await chain.createMessage(tag, body)
  if (!outcome.ok) throw new Error(outcome.error)
}

describe('POLL and DRAIN', () => {
  it('asks for one next tag per stream once caught up, and drains a whole week on a hit', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    for (const text of ['1', '2', '3']) await sendContent(alice.ctx, aliceConv, { type: 'text', text })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['1', '2', '3'])

    const conv = directConv(bob.ctx, ALICE_ID)
    if (!conv) throw new Error('no conversation')
    const st = stream(conv, ALICE_ID, { b: 0, r: 0 })
    expect(st?.cur).toEqual({ w: weekOf(ledger.time), j: 2 })
    // Closed conversation: Bob polls only Alice's next tag, not his own stream.
    const wants = collectWants(bob.ctx)
    expect(wants.map((w) => [w.kind, w.j])).toEqual([['next', 3]])
  })

  it('crosses a week rollover and keeps the old week next tag for the stale window', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'last week' })
    await pollOnce(bob.ctx)
    const oldWeek = weekOf(ledger.time)

    ledger.time = weekStart(oldWeek + 1) + 1000
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'new week' })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['last week', 'new week'])

    const conv = directConv(bob.ctx, ALICE_ID)
    const st = conv && stream(conv, ALICE_ID, { b: 0, r: 0 })
    expect(st?.cur).toEqual({ w: oldWeek + 1, j: 0 })
    expect(st?.stale).toEqual([{ w: oldWeek, j: 1, until: expect.any(Number) }])

    // A straggler signed just before the rollover lands late: the stale tag catches it.
    await writeRaw(alice.chain, aliceConv, oldWeek, 1, null, { type: 'text', text: 'straggler' })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toContain('straggler')

    // After ten minutes the stale tag is no longer polled.
    ledger.time += STALE_WINDOW_MS + 1
    await pollStreams(bob.ctx)
    expect(st?.stale).toEqual([])
  })

  it('probes every week since the conversation started, then stops re-asking settled empty weeks', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'old' })
    const sent = weekOf(ledger.time)
    ledger.time += 3 * WEEK
    const firstWants = async () => {
      await pollOnce(bob.ctx)
      const conv = directConv(bob.ctx, ALICE_ID)
      if (!conv) throw new Error('no conversation')
      return stream(conv, ALICE_ID, { b: 0, r: 0 })
    }
    const st = await firstWants()
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['old'])
    expect(st?.cur).toEqual({ w: sent, j: 0 })
    // Alice's stream: the next tag and the current week only; the two empty weeks in between are settled.
    const wants = collectWants(bob.ctx).filter((w) => w.st === st)
    expect(wants.map((w) => [w.kind, w.w, w.j])).toEqual([['next', sent, 1], ['week', sent + 3, 0]])
  })
})

describe('BACKFILL', () => {
  it('catches up across several weeks after being away', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'a' })
    await pollOnce(bob.ctx)
    // Bob goes away; Alice writes over three weeks.
    ledger.time += WEEK
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'b' })
    ledger.time += WEEK
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'c' })
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'd' })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reaches a straggler the stale window missed through the next message prev', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    const w = weekOf(ledger.time)
    await writeRaw(alice.chain, aliceConv, w, 0, null, { type: 'text', text: 'a' })
    ledger.time = weekStart(w + 1) + 1000
    await writeRaw(alice.chain, aliceConv, w + 1, 0, { w, b: 0, r: 0, j: 0 }, { type: 'text', text: 'b' })
    await pollOnce(bob.ctx)
    // Long after the window, a message signed at (w, 1) finally lands, and Alice's next message links to it.
    ledger.time += STALE_WINDOW_MS * 3
    await pollOnce(bob.ctx)
    await writeRaw(alice.chain, aliceConv, w, 1, { w, b: 0, r: 0, j: 0 }, { type: 'text', text: 'late' })
    await writeRaw(alice.chain, aliceConv, w + 1, 1, { w, b: 0, r: 0, j: 1 }, { type: 'text', text: 'c' })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID).sort()).toEqual(['a', 'b', 'c', 'late'])
  })

  it('never backfills along a prev that points forward', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    const w = weekOf(ledger.time)
    // A message in a future week exists, and the current message claims it as its predecessor.
    await writeRaw(alice.chain, aliceConv, w + 1, 0, null, { type: 'text', text: 'bait' })
    await writeRaw(alice.chain, aliceConv, w, 0, { w: w + 1, b: 0, r: 0, j: 0 }, { type: 'text', text: 'first' })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['first'])
  })

  it('stops a backfill at a prev that does not point strictly backwards', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    const w = weekOf(ledger.time)
    ledger.time += 2 * WEEK
    const now = weekOf(ledger.time)
    // Current-week message links back to w; the one at w links "forward" to the current week: a loop.
    await writeRaw(alice.chain, aliceConv, w, 0, { w: now, b: 0, r: 0, j: 0 }, { type: 'text', text: 'loop' })
    await writeRaw(alice.chain, aliceConv, now, 0, { w, b: 0, r: 0, j: 0 }, { type: 'text', text: 'head' })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID).sort()).toEqual(['head', 'loop'])
  })

  it('does not walk past the lookback horizon', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'ancient' })
    ledger.time += 60 * WEEK
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'now' })
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['now'])
  })

  it('defers history behind read messages until the thread opens', async () => {
    const { ledger, alice, bob, aliceConv } = await setup()
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'old' })
    ledger.time += 2 * WEEK
    await sendContent(alice.ctx, aliceConv, { type: 'text', text: 'new' })
    await pollOnce(bob.ctx)
    const first = directConv(bob.ctx, ALICE_ID)
    if (!first) throw new Error('no conversation')
    bob.ctx.store.touch(first.entry, { readAt: ledger.time })
    await bob.ctx.store.flush()

    // A second device of Bob's, with the saved read position and no local cache.
    const tablet = makeContext(ledger, BOB_ID, BOB_PRIV)
    await tablet.ctx.store.load()
    for (const entry of tablet.ctx.store.directs()) await attachDirect(tablet.ctx, entry)
    tablet.ctx.scanCursor = tablet.ctx.store.state.inviteScanCursor
    await pollOnce(tablet.ctx)
    expect(texts(tablet.ctx, ALICE_ID)).toEqual(['new'])

    const conv = directConv(tablet.ctx, ALICE_ID)
    if (!conv) throw new Error('no conversation')
    conv.open = true
    await runDeferred(tablet.ctx, conv)
    expect(texts(tablet.ctx, ALICE_ID)).toEqual(['old', 'new'])
  })
})
