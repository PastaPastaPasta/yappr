import bs58 from 'bs58'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesEqual, bytesToHex } from '@/lib/bytes'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import { BACKGROUND_POLL_MS, DmEngine } from './engine'
import type { KeyValueStore } from './types'
import { MapKv, MemoryChain, MemoryLedger, makeContext, manualScheduler } from './test-chain'

const engines: DmEngine[] = []

function engine(ledger: MemoryLedger, id: Uint8Array, priv: Uint8Array, kv: KeyValueStore = new MapKv(), chain = new MemoryChain(ledger, id)): DmEngine {
  ledger.register(id, priv)
  const e = new DmEngine({ chain, identityId: id, encPriv: priv, kv, cacheKey: 'dm', scheduler: manualScheduler })
  engines.push(e)
  return e
}

async function started(e: DmEngine) {
  await e.start()
  e.stop()
  return e
}

afterEach(() => engines.splice(0).forEach((e) => e.stop()))

const alice58 = bs58.encode(ALICE_ID)
const bob58 = bs58.encode(BOB_ID)
const carol58 = bs58.encode(CAROL_ID)

describe('DmEngine views', () => {
  it('lists a new incoming 1:1 with its unread count, and clears it on read', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV))
    const key = await alice.startDirect(bob58)
    await alice.send(key, 'one')
    await alice.send(key, 'two')
    await bob.tick()
    const view = bob.getSnapshot().conversations.find((c) => c.peerId === alice58)
    expect(view?.unread).toBe(2)
    expect(view?.lastMessage?.text).toBe('two')
    expect(bob.getSnapshot().unreadTotal).toBe(2)
    bob.markRead(view?.key ?? '')
    expect(bob.getSnapshot().unreadTotal).toBe(0)
  })

  it('shows my send at the device clock, but keeps a reply after it below it and unread (QA D-L4i-007)', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV))
    // The engines' device clock (Date.now()) runs far ahead of this ledger's block time.
    const key = await alice.startDirect(bob58)
    await alice.openConversation(key)
    await alice.send(key, 'question')
    const [question] = alice.messages(key)
    expect(question.shownAt).toBe(question.createdAt + 3 * 60_000)
    await bob.tick()
    await bob.send(bob.getSnapshot().conversations[0].key, 'answer')
    await alice.tick()
    expect(alice.messages(key).map((m) => [m.text, m.shownAt === m.createdAt])).toEqual([['question', false], ['answer', true]])
    expect(alice.getSnapshot().conversations[0].unread).toBe(1)
  })

  it('shows a draft only while it is open, and never writes until the first send', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    engine(ledger, BOB_ID, BOB_PRIV)
    const key = await alice.startDirect(bob58)
    await alice.openConversation(key)
    expect(alice.getSnapshot().conversations.map((c) => c.draft)).toEqual([true])
    await alice.openConversation(null)
    expect(alice.getSnapshot().conversations).toEqual([])
    expect(ledger.invites).toHaveLength(0)
    expect(ledger.selfStates).toHaveLength(0)
  })

  it('hides a 1:1 that holds only grants until its first text, and shows the group instead', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV))
    await alice.createGroup('Team', [bob58])
    await bob.tick()
    const kinds = bob.getSnapshot().conversations.map((c) => c.kind)
    expect(kinds).toEqual(['group'])
    const aliceKey = await alice.startDirect(bob58)
    await alice.send(aliceKey, 'direct hello')
    await bob.tick()
    expect(bob.getSnapshot().conversations.map((c) => c.kind).sort()).toEqual(['direct', 'group'])
  })

  it('shows a group I left as no longer mine, refuses to send to it, and lets me back in when the owner re-adds me (QA D-L4a-003)', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV))
    await started(engine(ledger, CAROL_ID, CAROL_PRIV))
    const { key } = await alice.createGroup('Team', [bob58, carol58])
    await bob.tick()
    const group = () => bob.getSnapshot().conversations.find((c) => c.key === key)
    expect(group()?.removed).toBe(false)

    await bob.leaveGroup(key)
    // The owner has not removed Bob yet, but he left: no longer a member here (PRD DM-08).
    expect(group()).toMatchObject({ removed: true, hidden: true })
    const written = ledger.messages.length
    await expect(bob.send(key, 'still here?')).rejects.toThrow(/no longer a member/)
    expect(ledger.messages).toHaveLength(written)

    // The owner removes him on its next poll, then adds him back: he can send again.
    await alice.tick()
    await alice.addMember(key, bob58)
    await bob.tick()
    expect(group()?.removed).toBe(false)
    await bob.send(key, 'back again')
    expect(bob.messages(key).map((m) => m.text)).toContain('back again')
  })

  it('knows a group I left on a new device, or after a reinstall, before the owner removes me (QA NEW-R-A-03)', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV))
    await started(engine(ledger, CAROL_ID, CAROL_PRIV))
    const { key } = await alice.createGroup('Team', [bob58, carol58])
    await bob.tick()
    await bob.leaveGroup(key)

    // Bob signs in again with nothing on the device; Alice's client has not removed him yet.
    const fresh = await started(engine(ledger, BOB_ID, BOB_PRIV))
    const group = () => fresh.getSnapshot().conversations.find((c) => c.key === key)
    expect(group()?.memberIds).toContain(bob58)
    expect(group()?.removed).toBe(true)
    const written = ledger.messages.length
    await expect(fresh.send(key, 'still here?')).rejects.toThrow(/no longer a member/)
    expect(ledger.messages).toHaveLength(written)

    // Once the owner removes him and adds him back, a new device lets him write again: the old leave is on an old base.
    await alice.tick()
    await alice.addMember(key, bob58)
    const later = await started(engine(ledger, BOB_ID, BOB_PRIV))
    await later.openConversation(key)
    expect(later.getSnapshot().conversations.find((c) => c.key === key)?.removed).toBe(false)
    await later.send(key, 'back again')
    expect(later.messages(key).map((m) => m.text)).toContain('back again')
  })

  it('"delete conversation" hides it until a newer message arrives', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV))
    const key = await alice.startDirect(bob58)
    await alice.send(key, 'hi')
    await bob.tick()
    const bobKey = bob.getSnapshot().conversations[0].key
    bob.hide(bobKey)
    expect(bob.getSnapshot().conversations[0].hidden).toBe(true)
    await alice.send(key, 'again')
    await bob.tick()
    expect(bob.getSnapshot().conversations[0].hidden).toBe(false)
  })

  it('does not count or show messages from a blocked person, and unblocks', async () => {
    const ledger = new MemoryLedger()
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV))
    const key = await alice.startDirect(bob58)
    await alice.send(key, 'hi')
    await bob.tick()
    bob.setBlocked(alice58, true)
    expect(bob.getSnapshot().unreadTotal).toBe(0)
    expect(bob.getSnapshot().blocked).toEqual([alice58])
    const bobKey = bob.getSnapshot().conversations[0].key
    expect(bob.messages(bobKey)).toEqual([])
    await expect(bob.send(bobKey, 'x')).rejects.toThrow(/Unblock/)
    bob.setBlocked(alice58, false)
    expect(bob.messages(bobKey).map((m) => m.text)).toEqual(['hi'])
  })

  it('starts lost-state recovery when the user has written v5 documents but has no self-state', async () => {
    const ledger = new MemoryLedger()
    await started(engine(ledger, CAROL_ID, CAROL_PRIV))
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    await alice.send(await alice.startDirect(carol58), 'hello')
    ledger.follows.push({ from: ALICE_ID, to: CAROL_ID })
    ledger.selfStates = ledger.selfStates.filter((s) => !bytesEqual(s.owner, ALICE_ID))
    const fresh = engine(ledger, ALICE_ID, ALICE_PRIV)
    await fresh.start()
    // Recovery runs in the background on the engine queue (stopping the engine cancels it); wait for it.
    expect(fresh.getSnapshot().recovery).not.toBeNull()
    for (let i = 0; i < 100 && fresh.getSnapshot().recovery; i++) await new Promise((r) => setTimeout(r, 5))
    fresh.stop()
    expect(fresh.getSnapshot().recovery).toBeNull()
    expect(fresh.getSnapshot().conversations.map((c) => c.peerId)).toEqual([carol58])
    expect(fresh.messages(fresh.getSnapshot().conversations[0].key).map((m) => m.text)).toEqual(['hello'])
  })
})

describe('DmEngine.pollOwn', () => {
  it('reads back my own message that landed although its send reported a failure, without the thread open', async () => {
    const ledger = new MemoryLedger()
    const chain = new MemoryChain(ledger, ALICE_ID)
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV, new MapKv(), chain))
    engine(ledger, BOB_ID, BOB_PRIV)
    const key = await alice.startDirect(bob58)
    await alice.send(key, 'first')
    // The write lands, but the answer is a transport failure: nothing is held locally.
    chain.hook = (method, args) => {
      if (method !== 'createMessage') return null
      chain.hook = null
      chain.createMessage(...(args as [Uint8Array, Uint8Array])).catch(() => undefined)
      return { ok: false, failure: 'transport', error: 'Request timeout after 8000ms' }
    }
    await expect(alice.send(key, 'second')).rejects.toThrow(/timeout/)
    expect(alice.messages(key).map((m) => m.text)).toEqual(['first'])
    await alice.pollOwn(key)
    expect(alice.messages(key).map((m) => m.text)).toEqual(['first', 'second'])
  })
})

describe('DmEngine self-state edits across a reload (§5.5)', () => {
  /** What a fresh device reads from the chain. */
  async function savedState(ledger: MemoryLedger, id: Uint8Array, priv: Uint8Array) {
    const { ctx } = makeContext(ledger, id, priv)
    await ctx.store.load()
    return ctx.store
  }

  /** A Bob whose self-state writes can be refused, as when the page closes before the save finishes. */
  async function bobWithChat(ledger: MemoryLedger) {
    const alice = await started(engine(ledger, ALICE_ID, ALICE_PRIV))
    const kv = new MapKv()
    const chain = new MemoryChain(ledger, BOB_ID)
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV, kv, chain))
    await alice.send(await alice.startDirect(bob58), 'hi')
    await bob.tick()
    expect(await bob.flush()).toBe(true)
    const refuse = () => {
      chain.hook = (method) => (method.endsWith('SelfState') ? { ok: false, failure: 'transport', error: 'page closed' } : null)
    }
    return { alice, bob, kv, key: bob.getSnapshot().conversations[0].key, refuse }
  }

  it('saves a block at once, not on the coalescing timer', async () => {
    const ledger = new MemoryLedger()
    const { bob } = await bobWithChat(ledger)
    bob.setBlocked(alice58, true)
    await vi.waitFor(async () => expect((await savedState(ledger, BOB_ID, BOB_PRIV)).isBlocked(ALICE_ID)).toBe(true))
  })

  it('keeps an unblock and a deleted conversation that were never saved, and saves them on the next load', async () => {
    const ledger = new MemoryLedger()
    const { bob, kv, key, refuse } = await bobWithChat(ledger)
    bob.setBlocked(alice58, true)
    await vi.waitFor(async () => expect((await savedState(ledger, BOB_ID, BOB_PRIV)).isBlocked(ALICE_ID)).toBe(true))
    refuse()
    bob.setBlocked(alice58, false)
    bob.hide(key)
    expect(await bob.flush()).toBe(false)

    const reloaded = await started(engine(ledger, BOB_ID, BOB_PRIV, kv))
    expect(reloaded.getSnapshot().blocked).toEqual([])
    expect(reloaded.getSnapshot().conversations.map((c) => c.hidden)).toEqual([true])
    await vi.waitFor(async () => expect((await savedState(ledger, BOB_ID, BOB_PRIV)).isBlocked(ALICE_ID)).toBe(false))
    expect((await savedState(ledger, BOB_ID, BOB_PRIV)).directs()[0].hiddenAt).toBeGreaterThan(0)
  })

  it('keeps a read position that was never saved', async () => {
    const ledger = new MemoryLedger()
    const { bob, kv, key, refuse } = await bobWithChat(ledger)
    expect(bob.getSnapshot().unreadTotal).toBe(1)
    refuse()
    bob.markRead(key)
    expect(await bob.flush()).toBe(false)

    const reloaded = await started(engine(ledger, BOB_ID, BOB_PRIV, kv))
    expect(reloaded.getSnapshot().unreadTotal).toBe(0)
  })

  it('keeps the read position a reply moved, when that was never saved', async () => {
    const ledger = new MemoryLedger()
    const { bob, kv, key, refuse } = await bobWithChat(ledger)
    expect(bob.getSnapshot().unreadTotal).toBe(1)
    refuse()
    await bob.send(key, 'reply')
    expect(bob.getSnapshot().unreadTotal).toBe(0)
    expect(await bob.flush()).toBe(false)

    const reloaded = await started(engine(ledger, BOB_ID, BOB_PRIV, kv))
    expect(reloaded.getSnapshot().unreadTotal).toBe(0)
  })

  it('skips a malformed cached block and still restores the rest', async () => {
    const ledger = new MemoryLedger()
    const kv = new MapKv()
    const alice = { blocked: true, changedAt: 1_000 }
    kv.set('dm', JSON.stringify({ blocks: { zz: alice, '': alice, [bytesToHex(ALICE_ID)]: alice } }))
    const bob = await started(engine(ledger, BOB_ID, BOB_PRIV, kv))
    expect(bob.getSnapshot().blocked).toEqual([alice58])
  })
})

describe('DmEngine.pause', () => {
  it('stops the poll cadence until resume, which polls at once and re-arms it', async () => {
    vi.useFakeTimers()
    try {
      const ledger = new MemoryLedger()
      const alice = engine(ledger, ALICE_ID, ALICE_PRIV)
      await alice.start()
      const tick = vi.spyOn(alice, 'tick')
      alice.pause()
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS * 3)
      expect(tick).not.toHaveBeenCalled()
      await alice.resume()
      expect(tick).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS + 10)
      expect(tick).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
