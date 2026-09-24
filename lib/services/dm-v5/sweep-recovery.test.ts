import { describe, expect, it } from 'vitest'
import { bytesEqual } from '@/lib/bytes'
import { weekOf, weekStart } from '@/lib/dm/kdf'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import { timeline } from './conversation'
import { attachSaved, directConv, groupConv, type DmContext } from './context'
import { ensureStarted, openDirect } from './directs'
import { createGroup } from './groups'
import { pollOnce } from './loop'
import { recoverLostState, type RecoveryProgress } from './recovery'
import { sendContent } from './sender'
import { firstKeptWeek, orderTargets, planSweep, sweep, type SweepTarget } from './sweep'
import { MemoryLedger, makeContext } from './test-chain'
import { RETENTION_MS } from './util'

const DAY = 86_400_000
const WEEK = 7 * DAY

async function send(ctx: DmContext, peer: Uint8Array, text: string) {
  const conv = await openDirect(ctx, peer)
  await ensureStarted(ctx, conv)
  return sendContent(ctx, conv, { type: 'text', text })
}

describe('sweep week selection', () => {
  it('keeps any week that is not entirely older than the retention age', () => {
    const now = weekStart(3000) + 3 * DAY
    const keep = firstKeptWeek(now, RETENTION_MS['30d'])
    // The cutoff (now − 30 days) falls one day into week 2996: week 2995 ended before it and goes, 2996 stays.
    expect(now - 30 * DAY).toBe(weekStart(2996) + DAY)
    expect(keep).toBe(2996)
    expect(firstKeptWeek(now, RETENTION_MS.never)).toBeNull()
  })

  it('a message lives 30 to 37 days on the default', () => {
    for (const offset of [0, 1, 3, 6]) {
      const sent = weekStart(3000) + offset * DAY
      const w = weekOf(sent)
      // The first sweep that deletes it is the first `now` whose kept week is past w.
      let now = sent
      while ((firstKeptWeek(now, RETENTION_MS['30d']) ?? 0) <= w) now += DAY / 4
      const age = (now - sent) / DAY
      expect(age).toBeGreaterThanOrEqual(30)
      expect(age).toBeLessThanOrEqual(37.25)
    }
  })

  it('orders deletes oldest week first', () => {
    const t = (w: number, j: number) => ({ pointer: { w, j, b: 0, r: 0 }, docId: `${w}.${j}` }) as unknown as SweepTarget
    const ordered = orderTargets([t(5, 0), t(3, 0), t(5, 1), t(3, 1), t(4, 0)])
    expect(ordered.map((x) => x.pointer.w)).toEqual([3, 3, 4, 5, 5])
  })
})

describe('sweep', () => {
  it('walks my prev chain and deletes whole weeks past retention, in every conversation', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await send(alice.ctx, BOB_ID, 'old to bob')
    await send(alice.ctx, CAROL_ID, 'old to carol')
    ledger.time += 6 * WEEK
    await send(alice.ctx, BOB_ID, 'new to bob')
    await send(bob.ctx, ALICE_ID, 'bob old reply stays: not mine')

    const plan = await planSweep(alice.ctx)
    expect(new Set(plan.targets.map((t) => t.conv.key)).size).toBe(2)
    const deleted = await sweep(alice.ctx)
    expect(deleted).toBe(2)
    const left = ledger.messages.filter((m) => bytesEqual(m.ownerId, ALICE_ID))
    expect(left).toHaveLength(1)
    // The oldest survivor is cached, so the next sweep stops there.
    const conv = directConv(alice.ctx, BOB_ID)
    expect(conv && alice.ctx.cache.oldestOwn(conv.key)).toEqual(expect.objectContaining({ j: 0 }))
    expect(await sweep(alice.ctx)).toBe(0)
  })

  it('retries a refused delete next time instead of hiding it behind the survivor cache', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    await send(alice.ctx, BOB_ID, 'old')
    ledger.time += 6 * WEEK
    await send(alice.ctx, BOB_ID, 'new')
    const remove = alice.chain.deleteMessage.bind(alice.chain)
    alice.chain.deleteMessage = async () => ({ ok: false, failure: 'other', error: 'network' })
    expect(await sweep(alice.ctx)).toBe(0)
    alice.chain.deleteMessage = remove
    expect(await sweep(alice.ctx)).toBe(1)
  })

  it('reaches own messages this device never held, through prev', async () => {
    const ledger = new MemoryLedger()
    const phone = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    await send(phone.ctx, BOB_ID, 'one')
    ledger.time += WEEK
    await send(phone.ctx, BOB_ID, 'two')
    ledger.time += 6 * WEEK
    await send(phone.ctx, BOB_ID, 'three')

    const laptop = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await laptop.ctx.store.load()
    await attachSaved(laptop.ctx)
    await pollOnce(laptop.ctx) // appJustOpened polls own streams: holds only "three"
    const conv = directConv(laptop.ctx, BOB_ID)
    expect(conv && timeline(conv).map((m) => (m.content.type === 'text' ? m.content.text : ''))).toContain('three')
    expect(await sweep(laptop.ctx)).toBe(2)
  })

  it('does nothing on "never"', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    await send(alice.ctx, BOB_ID, 'keep')
    alice.ctx.store.setRetention('never', ledger.time)
    ledger.time += 100 * WEEK
    expect(await sweep(alice.ctx)).toBe(0)
  })
})

describe('lost-state recovery', () => {
  const run = (ctx: DmContext) => {
    const phases: RecoveryProgress['phase'][] = []
    return recoverLostState(ctx, (task) => task(), (p) => {
      if (phases.at(-1) !== p.phase) phases.push(p.phase)
    }, () => false).then(() => phases)
  }

  it('rebuilds incoming 1:1s from invites, started ones from follows, owned groups, and joined groups from grants', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)

    // Bob started a chat with Alice (incoming for her), Alice started one with Carol (only a follow links them).
    await send(bob.ctx, ALICE_ID, 'from bob')
    await send(alice.ctx, CAROL_ID, 'to carol')
    ledger.follows.push({ from: ALICE_ID, to: CAROL_ID })
    // Alice owns a group with Bob; Carol owns one with Alice.
    const own = await createGroup(alice.ctx, 'Mine', [BOB_ID])
    const theirs = await createGroup(carol.ctx, 'Theirs', [ALICE_ID])

    // Alice's self-state is gone.
    ledger.selfStates = ledger.selfStates.filter((s) => !bytesEqual(s.owner, ALICE_ID))
    const fresh = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    expect(await fresh.ctx.store.load()).toBe('missing')

    const phases = await run(fresh.ctx)
    expect(phases).toEqual(['invites', 'contacts-recent', 'groups', 'contacts-older', 'done'])
    expect(directConv(fresh.ctx, BOB_ID)).not.toBeNull()
    expect(directConv(fresh.ctx, CAROL_ID)).not.toBeNull()
    expect(groupConv(fresh.ctx, ALICE_ID, own.conv.gid)).not.toBeNull()
    await pollOnce(fresh.ctx)
    expect(groupConv(fresh.ctx, CAROL_ID, theirs.conv.gid)).not.toBeNull()

    // Everything found is saved, and recovered conversations start as read.
    const check = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    expect(await check.ctx.store.load()).toBe('loaded')
    expect(check.ctx.store.directs()).toHaveLength(2)
    expect(check.ctx.store.findDirect(BOB_ID)?.readAt).toBeGreaterThan(0)
  })

  it('finds a started chat 30 weeks back in the background pass', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await send(alice.ctx, CAROL_ID, 'long ago')
    ledger.follows.push({ from: CAROL_ID, to: ALICE_ID })
    ledger.time += 30 * WEEK
    ledger.selfStates = []
    const fresh = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await run(fresh.ctx)
    expect(directConv(fresh.ctx, CAROL_ID)).not.toBeNull()
  })
})
