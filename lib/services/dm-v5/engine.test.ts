import bs58 from 'bs58'
import { afterEach, describe, expect, it } from 'vitest'
import { bytesEqual } from '@/lib/bytes'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import { DmEngine } from './engine'
import { MapKv, MemoryChain, MemoryLedger, manualScheduler } from './test-chain'

const engines: DmEngine[] = []

function engine(ledger: MemoryLedger, id: Uint8Array, priv: Uint8Array): DmEngine {
  ledger.register(id, priv)
  const e = new DmEngine({ chain: new MemoryChain(ledger, id), identityId: id, encPriv: priv, kv: new MapKv(), cacheKey: 'dm', scheduler: manualScheduler })
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
