import { describe, expect, it } from 'vitest'
import { bytesEqual } from '@/lib/bytes'
import { createInvite } from '@/lib/dm/invite'
import { weekOf } from '@/lib/dm/kdf'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, BOB_PUB, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import type { IdentityId } from '@/lib/dm/types'
import { encodeSelfState, selfStateFits, selfStateKey } from '@/lib/dm/self-state'
import { sealPadded } from '@/lib/dm/seal'
import { SELF_STATE_CLASSES, splitFields } from '@/lib/dm/padding'
import { deriveSelfRoot, deriveStateKey } from '@/lib/dm/keys'
import { directConv } from './context'
import { scanInvites } from './invites'
import { MemoryChain, MemoryLedger, makeContext } from './test-chain'

/** A distinct 32-byte id per n (n < 65536). */
const peer = (n: number): IdentityId => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0x10 : i === 1 ? n >> 8 : i === 2 ? n & 0xff : i))
const direct = (id: IdentityId, readAt = 0) => ({ peer: id, since: 1, readAt, hiddenAt: 0 })

describe('self-state store', () => {
  it('saves, then merges and retries when another device saved first (40106)', async () => {
    const ledger = new MemoryLedger()
    const phone = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const laptop = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    phone.ctx.store.addDirect(direct(BOB_ID, 10))
    expect(await phone.ctx.store.flush()).toBe(true)

    await laptop.ctx.store.load()
    phone.ctx.store.addDirect(direct(CAROL_ID))
    expect(await phone.ctx.store.flush()).toBe(true)

    // The laptop is still on revision 1: its save is refused as stale, it merges, and saves again.
    let stale = 0
    const replace = laptop.chain.replaceSelfState.bind(laptop.chain)
    laptop.chain.replaceSelfState = async (ref, fields) => {
      const outcome = await replace(ref, fields)
      if (!outcome.ok && outcome.failure === 'stale') stale++
      return outcome
    }
    const bob = laptop.ctx.store.findDirect(BOB_ID)
    if (!bob) throw new Error('no entry')
    laptop.ctx.store.touch(bob, { readAt: 99 })
    expect(await laptop.ctx.store.flush()).toBe(true)
    expect(stale).toBe(1)

    const fresh = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await fresh.ctx.store.load()
    expect(fresh.ctx.store.directs().map((d) => d.peer)).toEqual([BOB_ID, CAROL_ID])
    expect(fresh.ctx.store.findDirect(BOB_ID)?.readAt).toBe(99)
  })

  it('merges a create race (40105 on the unique [$ownerId] index)', async () => {
    const ledger = new MemoryLedger()
    const a = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const b = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    a.ctx.store.addDirect(direct(BOB_ID))
    b.ctx.store.addDirect(direct(CAROL_ID))
    expect(await a.ctx.store.flush()).toBe(true)
    expect(await b.ctx.store.flush()).toBe(true)
    const check = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await check.ctx.store.load()
    expect(check.ctx.store.directs()).toHaveLength(2)
  })

  it('coalesces edits into one save and saves nothing without a signing key', async () => {
    const ledger = new MemoryLedger()
    const { ctx, chain } = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    ctx.store.addDirect(direct(BOB_ID))
    ctx.store.setBlocked(CAROL_ID, true, 5)
    ctx.store.setRetention('90d', 6)
    expect(ctx.store.isDirty).toBe(true)
    chain.writable = false
    expect(await ctx.store.flush()).toBe(false)
    expect(ledger.selfStates).toHaveLength(0)
    chain.writable = true
    expect(await ctx.store.flush()).toBe(true)
    expect(ledger.selfStates).toHaveLength(1)
    expect(ledger.selfStates[0].revision).toBe(1)
  })

  it('keeps an unblock through a merge (newer changedAt wins)', async () => {
    const ledger = new MemoryLedger()
    const a = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    a.ctx.store.setBlocked(BOB_ID, true, 100)
    await a.ctx.store.flush()
    const b = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await b.ctx.store.load()
    b.ctx.store.setBlocked(BOB_ID, false, 200)
    await b.ctx.store.flush()
    a.ctx.store.addDirect(direct(CAROL_ID))
    await a.ctx.store.flush()
    expect(a.ctx.store.isBlocked(BOB_ID)).toBe(false)
  })

  it('never overwrites a self-state written by a newer client', async () => {
    const ledger = new MemoryLedger()
    const a = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    a.ctx.store.addDirect(direct(BOB_ID))
    await a.ctx.store.flush()
    const saved = ledger.selfStates[0]
    const newer = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    // Re-seal the saved state with a version byte this client does not know.
    const bytes = encodeSelfState(a.ctx.store.state)
    bytes[0] = 2
    const [blob] = splitFields(await sealPadded(selfStateKey(deriveStateKey(deriveSelfRoot(ALICE_PRIV))), bytes, SELF_STATE_CLASSES))
    saved.fields = { blob, blob2: null, blob3: null }
    expect(await newer.ctx.store.load()).toBe('newer')
    newer.ctx.store.addDirect(direct(CAROL_ID))
    expect(await newer.ctx.store.flush()).toBe(false)
    expect(saved.revision).toBe(1)
  })

  it('keeps a block that does not fit on this device without breaking later saves', () => {
    const ledger = new MemoryLedger()
    const { ctx } = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    for (let n = 0; n < 1000 && ctx.store.addDirect(direct(peer(n))); n++);
    ctx.store.setBlocked(BOB_ID, true, 1)
    expect(ctx.store.isBlocked(BOB_ID)).toBe(true)
    expect(selfStateFits(ctx.store.state)).toBe(true)
  })

  it('holds conversations past the cap in memory without saving them, and says so', () => {
    const ledger = new MemoryLedger()
    const { ctx } = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    let saved = 0
    for (let n = 0; n < 400 && ctx.store.addDirect(direct(peer(n))); n++) saved++
    expect(saved).toBeGreaterThan(250)
    expect(saved).toBeLessThan(300)
    expect(ctx.store.capReached).toBe(true)
    // The one that did not fit is still listed (and polled), just not saved.
    expect(ctx.store.directs()).toHaveLength(saved + 1)
    const extra = ctx.store.directs()[saved]
    expect(ctx.store.isSaved(extra)).toBe(false)
  })
})

describe('invite scan', () => {
  function inviteFrom(chain: MemoryChain, to: IdentityId, toPub: Uint8Array) {
    return chain.createInvite(createInvite({ recipientPublicKey: toPub, recipientId: to, senderId: chain.me, bucketLevel: 0 }))
  }

  it('finds invites addressed to me, skips others, and does not re-read ids at the cursor', async () => {
    const ledger = new MemoryLedger()
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await inviteFrom(alice.chain, BOB_ID, BOB_PUB)
    await inviteFrom(carol.chain, ALICE_ID, alice.ctx.me.encPub) // not Bob's

    await scanInvites(bob.ctx)
    expect(directConv(bob.ctx, ALICE_ID)).not.toBeNull()
    expect(directConv(bob.ctx, CAROL_ID)).toBeNull()
    const cursor = bob.ctx.scanCursor
    expect(cursor).toBe(Math.max(...ledger.invites.map((i) => i.createdAt)))

    // Another invite to Bob lands in the SAME block as the cursor: found, and the ones already read are skipped.
    ledger.step = 0
    await inviteFrom(carol.chain, BOB_ID, BOB_PUB)
    let trials = 0
    const scan = bob.chain.invitesSince.bind(bob.chain)
    bob.chain.invitesSince = async (buckets, since) => {
      const docs = await scan(buckets, since)
      trials = docs.filter((d) => d.createdAt > since || !bob.ctx.seenAtCursor.has(d.id)).length
      return docs
    }
    await scanInvites(bob.ctx)
    expect(directConv(bob.ctx, CAROL_ID)).not.toBeNull()
    expect(trials).toBe(1)
    expect(bob.ctx.scanCursor).toBe(cursor)
    expect(bob.ctx.seenAtCursor.size).toBe(2)
  })

  it('never moves the saved cursor past an invite whose conversation could not be saved', async () => {
    const ledger = new MemoryLedger()
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    // Fill Bob's state to the cap.
    for (let n = 0; n < 1000 && bob.ctx.store.addDirect(direct(peer(n))); n++);
    const capped = bob.ctx.store.directs().length
    await inviteFrom(alice.chain, BOB_ID, BOB_PUB)
    const inviteAt = ledger.invites[0].createdAt
    await scanInvites(bob.ctx)
    expect(bob.ctx.store.directs()).toHaveLength(capped + 1)
    expect(directConv(bob.ctx, ALICE_ID)).not.toBeNull()
    expect(bob.ctx.store.state.inviteScanCursor).toBeLessThanOrEqual(inviteAt)
  })

  it('takes the minimum cursor on merge, so no device skips an invite', async () => {
    const ledger = new MemoryLedger()
    const a = makeContext(ledger, BOB_ID, BOB_PRIV)
    a.ctx.store.addDirect(direct(ALICE_ID))
    a.ctx.store.setScanCursor(500)
    await a.ctx.store.flush()
    const b = makeContext(ledger, BOB_ID, BOB_PRIV)
    b.ctx.store.addDirect(direct(CAROL_ID))
    b.ctx.store.setScanCursor(900)
    await b.ctx.store.flush()
    expect(b.ctx.store.state.inviteScanCursor).toBe(500)
  })

  it('writes nothing when a scan finds no invite for me (the cursor alone never saves)', async () => {
    const ledger = new MemoryLedger()
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await inviteFrom(alice.chain, CAROL_ID, carol.ctx.me.encPub) // someone else's invite in bucket 1
    await scanInvites(bob.ctx)
    expect(bob.ctx.scanCursor).toBeGreaterThan(0)
    expect(bob.ctx.store.isDirty).toBe(false)
    expect(await bob.ctx.store.flush()).toBe(true)
    expect(ledger.selfStates.filter((s) => bytesEqual(s.owner, BOB_ID))).toHaveLength(0)
  })

  it('adds an incoming 1:1 with since = the invite week, unread from the start', async () => {
    const ledger = new MemoryLedger()
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await inviteFrom(alice.chain, BOB_ID, BOB_PUB)
    await scanInvites(bob.ctx)
    const entry = bob.ctx.store.findDirect(ALICE_ID)
    expect(entry && bytesEqual(entry.peer, ALICE_ID)).toBe(true)
    expect(entry?.since).toBe(weekOf(ledger.invites[0].createdAt))
    expect(entry?.readAt).toBe(0)
  })
})
