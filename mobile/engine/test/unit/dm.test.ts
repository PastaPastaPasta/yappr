/**
 * dm.* over both backends, offline: DM v5 on lib's in-memory test chain
 * (`lib/services/dm-v5/test-chain.ts`, several users on one ledger), and
 * legacy 1:1 over a fake `directMessageService`. Covers the DTOs, paging,
 * write tickets, events and the session and AppState lifecycle.
 */
import bs58 from 'bs58'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import type { DmEngine } from '@/lib/services/dm-v5/engine'
import type { MemoryChain } from '@/lib/services/dm-v5/test-chain'
import type { Conversation, DirectMessage } from '@/lib/types'
import type { AuthorDTO } from '../../src/api/dto'
import type { LegacyDmService } from '../../src/dm/legacy'
import type { DmEvents, MessageDTO } from '../../src/dm/types'
import type { WriteTicket } from '../../src/writes/types'
import type { SessionEvents } from '../../src/api/session'

// The settle before each v5 write reads lib's nonce reservations; here it only records its calls.
const settleSupersededReplaces = vi.hoisted(() => vi.fn(async () => 0))
vi.mock('@/lib/services/identity-nonce', async (load) => ({ ...await load<object>(), settleSupersededReplaces }))

// lib/store's persisted settings (read receipts) need the engine's storage before lib loads.
const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())
const { DmEngine: Engine } = await import('@/lib/services/dm-v5/engine')
const { MapKv, MemoryChain: Chain, MemoryLedger, manualScheduler } = await import('@/lib/services/dm-v5/test-chain')
const { useSettingsStore } = await import('@/lib/store')
const { createDmModule } = await import('../../src/api/dm')
const { avatarFromField } = await import('../../src/api/dto')
const { LEGACY_LIST_TTL_MS, LEGACY_OPEN_POLL_MS } = await import('../../src/dm/legacy')
const { WRITES_STORAGE_KEY, createTicketStore } = await import('../../src/writes/tickets')
const { RpcError } = await import('../../src/protocol/envelope')
const { conversationDTO, dmStatusDTO, messageDTO, page, validate } = await import('../../src/dto/validate')
type MemoryLedger = InstanceType<typeof MemoryLedger>

const alice = bs58.encode(ALICE_ID)
const bob = bs58.encode(BOB_ID)
const carol = bs58.encode(CAROL_ID)
const PRIV: Record<string, Uint8Array> = { [alice]: ALICE_PRIV, [bob]: BOB_PRIV, [carol]: CAROL_PRIV }

const expectValid = (check: Parameters<typeof validate>[0], value: unknown) => expect(validate(check, value)).toEqual([])

const authorOf = (id: string): AuthorDTO => ({ id, username: `u${id.slice(0, 4)}`, displayName: `Name ${id.slice(0, 4)}`, avatar: avatarFromField(undefined, id), resolved: true })

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  }
}

/** A ledger whose block time is now, so its messages count as new for `dm.message`. */
function ledgerNow(): MemoryLedger {
  const ledger = new MemoryLedger()
  ledger.time = Date.now()
  return ledger
}

type Event = { event: string; payload: unknown }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
})

/** A `session.changed` for a session that starts. */
const started = (identityId: string): SessionEvents['session.changed'] =>
  ({ session: { identityId, network: 'testnet', username: null, credits: 0n, hasEncryptionKey: true, method: 'key' }, reason: 'signed-in' })

/** One user's engine: a dm module over a ticket store, signed in as `me`. */
function userOn(ledger: MemoryLedger, me: string, extra: Partial<Parameters<typeof createDmModule>[0]> = {}) {
  const events: Event[] = []
  const storage = memoryStorage()
  /** The engine's plain storage, where DM v5 keeps its per-device state. */
  const local = memoryStorage()
  const emit = (event: string, payload: unknown) => { events.push({ event, payload }) }
  let signedIn: string | null = me
  const keyRequired = vi.fn()
  const tickets = createTicketStore({ storage, emit, currentIdentity: () => signedIn, documentExists: async () => true, onKeyRequired: keyRequired })
  const engines = new Map<string, DmEngine>()
  let locked = false
  const source = {
    engineFor: vi.fn((id: string): DmEngine | null => {
      if (locked) return null
      let engine = engines.get(id)
      if (!engine) {
        const raw = bs58.decode(id)
        ledger.register(raw, PRIV[id])
        engine = new Engine({ chain: new Chain(ledger, raw), identityId: raw, encPriv: PRIV[id], kv: new MapKv(), cacheKey: 'dm', scheduler: manualScheduler })
        engines.set(id, engine)
      }
      return engine
    }),
    release: vi.fn(),
  }
  const authors = vi.fn(async (ids: string[]) => new Map(ids.map(id => [id, authorOf(id)])))
  const dm = createDmModule({ emit, tickets, backend: 'v5', v5Source: source, viewer: () => signedIn, authors, coalesceMs: 0, storage: local, ...extra })
  dm.hooks.sessionChanged(started(me))
  cleanups.push(() => dm.hooks.stop())
  return {
    dm: dm.api, hooks: dm.hooks, events, storage, local, source, authors, tickets, keyRequired,
    engine: () => engines.get(me) as DmEngine,
    signOut: () => { signedIn = null },
    /** Whether this device holds no encryption key (the engine source answers null). */
    setLocked: (value: boolean) => { locked = value },
    /** The ticket's last `write.status`, once settled. */
    async settled(ticket: WriteTicket): Promise<WriteTicket> {
      let last: WriteTicket | undefined
      await vi.waitFor(() => {
        last = events.filter(e => e.event === 'write.status').map(e => e.payload as WriteTicket).filter(t => t.id === ticket.id).at(-1)
        expect(last?.state).not.toBe('pending')
      })
      return last as WriteTicket
    },
    eventsOf<E extends keyof DmEvents>(event: E): DmEvents[E][] {
      return events.filter(e => e.event === event).map(e => e.payload as DmEvents[E])
    },
  }
}

async function ready(user: ReturnType<typeof userOn>) {
  await vi.waitFor(async () => expect((await user.dm.status()).ready).toBe(true))
  return user
}

describe('dm on DM v5: session lifecycle', () => {
  it('starts the engine on sign-in, and stops it with a flush and a release', async () => {
    const user = await ready(userOn(ledgerNow(), alice))
    expect(user.source.engineFor).toHaveBeenCalledWith(alice)
    const flush = vi.spyOn(user.engine(), 'flush')
    const stop = vi.spyOn(user.engine(), 'stop')
    await user.hooks.stop()
    expect(stop).toHaveBeenCalled()
    expect(flush).toHaveBeenCalled()
    expect(user.source.release).toHaveBeenCalled()
    // Stopping again (the signed-out session.changed) does nothing more.
    user.hooks.sessionChanged({ session: null, reason: 'signed-out' })
    await settle()
    expect(user.source.release).toHaveBeenCalledTimes(1)
  })

  it('releases the engine before waiting for its save, so a slow save never stops the next account', async () => {
    const user = await ready(userOn(ledgerNow(), alice))
    const engine = user.engine()
    let finish = () => undefined as void
    vi.spyOn(engine, 'flush').mockReturnValue(new Promise(resolve => { finish = () => resolve(true) }))
    const stopping = user.hooks.stop()
    await settle()
    expect(user.source.release).toHaveBeenCalledWith(alice, engine)
    finish()
    await stopping
  })

  it('removes the account\'s DM cache on sign-out, again after a save that outlived the sign-out (SR-10)', async () => {
    const user = await ready(userOn(ledgerNow(), alice))
    const cacheKey = `yappr_dm_v5:${alice}`
    user.local.setItem(cacheKey, '{"convs":{}}')
    user.local.setItem(`yappr_dm_v5:${bob}`, '{"convs":{}}')
    let finish = () => undefined as void
    // lib's save ends with a write of its cache (DmEngine.emit persists it).
    vi.spyOn(user.engine(), 'flush').mockReturnValue(new Promise(resolve => {
      finish = () => {
        user.local.setItem(cacheKey, '{"convs":{"rewritten":{}}}')
        resolve(true)
      }
    }))
    const stopping = user.hooks.stop()
    user.hooks.forget(alice)
    expect(user.local.getItem(cacheKey)).toBeNull()
    finish()
    await stopping
    await settle()
    expect(user.local.getItem(cacheKey)).toBeNull()
    // Another account's cache stays.
    expect(user.local.getItem(`yappr_dm_v5:${bob}`)).not.toBeNull()
  })

  it('saves the self-state before a background lifecycle resolves', async () => {
    const user = await ready(userOn(ledgerNow(), alice))
    const flush = vi.spyOn(user.engine(), 'flush')
    await user.hooks.lifecycle('background')
    expect(flush).toHaveBeenCalledTimes(1)
    const tick = vi.spyOn(user.engine(), 'tick')
    await user.hooks.lifecycle('active')
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('reports locked without an encryption key, and starts once one exists', async () => {
    const user = userOn(ledgerNow(), alice)
    await user.hooks.stop()
    user.setLocked(true)
    user.hooks.sessionChanged(started(alice))
    expect(await user.dm.status()).toMatchObject({ backend: 'v5', locked: true, ready: false, retention: null })
    await expect(user.dm.conversations()).rejects.toMatchObject({ code: 'NO_KEY' })
    user.setLocked(false)
    await vi.waitFor(async () => expect(await user.dm.status()).toMatchObject({ locked: false, ready: true, retention: '30d' }))
  })

  it('stays stopped through an account change until a session starts again', async () => {
    const user = await ready(userOn(ledgerNow(), alice))
    await user.hooks.stop()
    await expect(user.dm.status()).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
    user.hooks.sessionChanged({ ...started(alice), reason: 'balance' })
    await expect(user.dm.conversations()).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
    expect(user.source.release).toHaveBeenCalledTimes(1)
    user.hooks.sessionChanged({ ...started(alice), reason: 'restored' })
    expect((await user.dm.status()).locked).toBe(false)
  })

  it('rejects every call when signed out', async () => {
    const user = userOn(ledgerNow(), alice)
    user.signOut()
    await expect(user.dm.status()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    await expect(user.dm.send('d:x', 'hi')).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
  })
})

describe('dm on DM v5: 1:1', () => {
  it('round trip: start, send with a ticket, receive with events, read', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    const b = await ready(userOn(ledger, bob))

    await expect(a.dm.startDirect(alice)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: "You can't message yourself" })
    await expect(a.dm.startDirect('nope')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const key = await a.dm.startDirect(bob)
    await a.dm.open(key)
    expect((await a.dm.conversations()).map(c => [c.key, c.flags.draft])).toEqual([[key, true]])
    await expect(a.dm.send(key, '   ')).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    settleSupersededReplaces.mockClear()
    const ticket = await a.dm.send(key, 'hello bob')
    expect(ticket).toMatchObject({ op: 'dm.send', state: 'pending', identityId: alice, target: { conversationKey: key } })
    expect(await a.settled(ticket)).toMatchObject({ state: 'confirmed', error: null })
    // A lost-but-landed roster or self-state replace never holds this send back (PENDING_WRITE).
    expect(settleSupersededReplaces).toHaveBeenCalledWith(alice, expect.any(String))
    // The text never reaches the persisted tickets.
    expect(a.storage.items.get(WRITES_STORAGE_KEY)).not.toContain('hello bob')
    const [mine] = (await a.dm.messages(key)).items
    expect(mine).toMatchObject({ sender: alice, text: 'hello bob', own: true })

    await b.engine().tick()
    const [inbox] = await b.dm.conversations()
    expectValid(conversationDTO, inbox)
    expect(inbox).toMatchObject({ backend: 'v5', kind: 'direct', peer: { id: alice, displayName: authorOf(alice).displayName }, unread: 1, lastMessage: { text: 'hello bob', own: false } })
    expectValid(dmStatusDTO, await b.dm.status())
    expect(await b.dm.status()).toMatchObject({ unreadTotal: 1, unreadConversations: 1 })
    await vi.waitFor(() => expect(b.eventsOf('dm.message')).toEqual([{ key: inbox.key, message: expect.objectContaining({ text: 'hello bob', own: false }) }]))
    expect(b.eventsOf('dm.changed').at(-1)).toMatchObject({ unreadTotal: 1, unreadConversations: 1, ready: true, changedKeys: [inbox.key] })
    expect(b.authors).toHaveBeenCalledTimes(1)

    await b.dm.markRead(inbox.key)
    expect(await b.dm.status()).toMatchObject({ unreadTotal: 0 })
    await b.settled(await b.dm.send(inbox.key, 'hi alice'))
    await a.engine().tick()
    expect((await a.dm.messages(key)).items.map(m => [m.text, m.own])).toEqual([['hi alice', false], ['hello bob', true]])
    // Each incoming message is announced once; own messages never.
    await settle()
    expect(a.eventsOf('dm.message').map(e => e.message.text)).toEqual(['hi alice'])
  })

  it('leaves a send whose broadcast timed out unconfirmed, and proves it on check by reading the chain', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    await ready(userOn(ledger, bob))
    const key = await a.dm.startDirect(bob)
    await a.settled(await a.dm.send(key, 'first'))
    const chain = a.engine().ctx.chain as MemoryChain
    // The write lands, but the answer is a timeout.
    chain.hook = (method, args) => {
      if (method !== 'createMessage') return null
      chain.hook = null
      chain.createMessage(...(args as [Uint8Array, Uint8Array])).catch(() => undefined)
      return { ok: false, failure: 'transport', error: 'Request timeout after 8000ms' }
    }
    const ticket = await a.settled(await a.dm.send(key, 'maybe'))
    expect(ticket).toMatchObject({ state: 'unconfirmed', retryable: false })
    // Not held locally, and the conversation is not open: the check reads my streams from the chain.
    expect((await a.dm.messages(key)).items.map(m => m.text)).toEqual(['first'])
    expect(await a.tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
  })

  it('never proves a send by an earlier identical message', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    await ready(userOn(ledger, bob))
    const key = await a.dm.startDirect(bob)
    await a.dm.open(key)
    expect(await a.settled(await a.dm.send(key, 'ok'))).toMatchObject({ state: 'confirmed' })
    const chain = a.engine().ctx.chain as MemoryChain
    // Nothing lands this time, and the answer is a timeout.
    chain.hook = method => (method === 'createMessage' ? { ok: false, failure: 'transport', error: 'Request timeout after 8000ms' } : null)
    const second = await a.settled(await a.dm.send(key, 'ok'))
    expect(second.state).toBe('unconfirmed')
    expect(await a.tickets.check(second.id)).toMatchObject({ state: 'unconfirmed' })
  })

  it('never proves a send by a concurrent identical send that landed', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    await ready(userOn(ledger, bob))
    const key = await a.dm.startDirect(bob)
    await a.settled(await a.dm.send(key, 'hi'))
    const chain = a.engine().ctx.chain as MemoryChain
    let writes = 0
    // The first "ok" lands; the second never does, and times out.
    chain.hook = method => (method === 'createMessage' && ++writes === 2 ? { ok: false, failure: 'transport', error: 'Request timeout after 8000ms' } : null)
    const [first, second] = await Promise.all([a.dm.send(key, 'ok'), a.dm.send(key, 'ok')])
    expect(await a.settled(first)).toMatchObject({ state: 'confirmed' })
    expect(await a.settled(second)).toMatchObject({ state: 'unconfirmed' })
    expect(await a.tickets.check(second.id)).toMatchObject({ state: 'unconfirmed' })
  })

  it('keeps a delivered send confirmed when recording its messages fails afterwards', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    await ready(userOn(ledger, bob))
    const key = await a.dm.startDirect(bob)
    const engine = a.engine()
    const send = engine.send.bind(engine)
    // The message goes out, then the device locks before the run reads it back (NO_KEY).
    vi.spyOn(engine, 'send').mockImplementation(async (conversation, text) => {
      await send(conversation, text)
      a.setLocked(true)
    })
    const ticket = await a.settled(await a.dm.send(key, 'delivered'))
    expect(ticket).toMatchObject({ state: 'confirmed', retryable: false, error: null })
    expect(a.keyRequired).not.toHaveBeenCalled()
  })

  it('fails a send that finds the device locked as NO_KEY, and asks for the key', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    await ready(userOn(ledger, bob))
    const key = await a.dm.startDirect(bob)
    // Locked after the ticket was issued (the engine's key lookup answers NO_KEY).
    vi.spyOn(a.engine(), 'send').mockRejectedValue(new RpcError('Messages are locked', 'NO_KEY'))
    const ticket = await a.settled(await a.dm.send(key, 'hello'))
    expect(ticket).toMatchObject({ state: 'failed', retryable: true, error: expect.objectContaining({ code: 'NO_KEY', outcome: 'not-sent' }) })
    expect(a.keyRequired).toHaveBeenCalledWith(alice)
  })

  it('pages messages newest first, 50 at a time, with a cursor tied to the conversation', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    await ready(userOn(ledger, bob))
    const key = await a.dm.startDirect(bob)
    for (let i = 0; i < 55; i++) await a.engine().send(key, `m${i}`)
    const first = await a.dm.messages(key)
    expectValid(page(messageDTO), first)
    expect(first.items).toHaveLength(50)
    expect(first.items[0].text).toBe('m54')
    expect(first.hasMore).toBe(true)
    const second = await a.dm.messages(key, first.cursor)
    expect(second.items.map((m: MessageDTO) => m.text)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0'])
    expect(second).toMatchObject({ cursor: null, hasMore: false })
    await expect(a.dm.messages('d:other', first.cursor)).rejects.toMatchObject({ code: 'BAD_CURSOR' })
  })

  it('blocks in Messages, hides a conversation, sets retention and searches', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    const b = await ready(userOn(ledger, bob))
    const key = await a.dm.startDirect(bob)
    await a.settled(await a.dm.send(key, 'pizza tonight?'))
    await b.engine().tick()
    const [{ key: bobKey }] = await b.dm.conversations()

    expect((await b.dm.search('pizza')).map(c => c.key)).toEqual([bobKey])
    expect((await b.dm.search(authorOf(alice).username as string)).map(c => c.key)).toEqual([bobKey])
    expect(await b.dm.search('nothing like it')).toEqual([])

    await b.dm.setBlocked(alice, true)
    expect(await b.dm.status()).toMatchObject({ blocked: [alice], unreadTotal: 0 })
    expect((await b.dm.conversations())[0].flags.blocked).toBe(true)
    await expect(b.dm.send(bobKey, 'x')).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Unblock this person to message them.' })
    await b.dm.setBlocked(alice, false)

    await b.dm.hide(bobKey)
    expect((await b.dm.conversations())[0].flags.hidden).toBe(true)
    await b.dm.setRetention('90d')
    expect((await b.dm.status()).retention).toBe('90d')
    await expect(b.dm.setRetention('forever' as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('dm on DM v5: Message settings', () => {
  const pendingKey = `yappr_engine_dm_retention:${alice}`

  it('keeps a retention choice whose save failed on the device, and saves it on the next start (SR-23)', async () => {
    const ledger = ledgerNow()
    const first = await ready(userOn(ledger, alice))
    const chain = first.engine().ctx.chain as MemoryChain
    chain.hook = method => (method === 'createSelfState' || method === 'replaceSelfState'
      ? { ok: false, failure: 'transport', error: 'transport error: grpc error: Failed to fetch' }
      : null)
    await first.dm.setRetention('90d')
    expect((await first.dm.status()).retention).toBe('90d')
    await settle()
    expect(first.local.getItem(pendingKey)).not.toBeNull()

    // Killed before a retry: the next engine loads the saved state, which still says 30 days.
    const next = await ready(userOn(ledger, alice, { storage: first.local }))
    await vi.waitFor(async () => expect((await next.dm.status()).retention).toBe('90d'))
    await vi.waitFor(() => expect(first.local.getItem(pendingKey)).toBeNull())
    const reloaded = await ready(userOn(ledger, alice))
    expect((await reloaded.dm.status()).retention).toBe('90d')
  })

  it('drops the device copy once the save lands, and never restores one a newer choice overtook', async () => {
    const ledger = ledgerNow()
    const user = await ready(userOn(ledger, alice))
    await user.dm.setRetention('1y')
    await vi.waitFor(() => expect(user.local.getItem(pendingKey)).toBeNull())

    user.local.setItem(pendingKey, JSON.stringify({ retention: 'never', updatedAt: 1 }))
    const next = await ready(userOn(ledger, alice, { storage: user.local }))
    await vi.waitFor(() => expect(user.local.getItem(pendingKey)).toBeNull())
    expect((await next.dm.status()).retention).toBe('1y')
  })
})

describe('dm on DM v5: groups', () => {
  it('create, rename, add, then a member leaves; owner-only actions are refused to members', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    const b = await ready(userOn(ledger, bob))
    const c = await ready(userOn(ledger, carol))

    await expect(a.dm.createGroup('', [bob])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(a.dm.createGroup('Team', [alice])).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Pick at least one member.' })
    const creating = await a.dm.createGroup('Team', [bob, bob])
    expect(creating).toMatchObject({ op: 'dm.group', state: 'pending', target: null })
    await expect(a.dm.createGroup('Team', [bob])).rejects.toMatchObject({ code: 'ENGINE_BUSY' })
    expect(await a.settled(creating)).toMatchObject({ state: 'confirmed' })
    const { key, failed } = await a.dm.createdGroup(creating.id) ?? { key: '', failed: ['missing'] }
    expect(failed).toEqual([])
    expect(await a.settled(await a.dm.renameGroup(key, 'Dream team'))).toMatchObject({ op: 'dm.group', state: 'confirmed' })
    expect(await a.settled(await a.dm.addMember(key, carol))).toMatchObject({ state: 'confirmed' })
    await expect(a.dm.leaveGroup(key)).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    await b.engine().tick()
    const group = (await b.dm.conversations()).find(conv => conv.kind === 'group')
    expectValid(conversationDTO, group)
    expect(group).toMatchObject({ key, name: 'Dream team', ownerId: alice, isOwner: false, peer: null })
    expect([...(group?.members ?? [])].sort()).toEqual([alice, bob, carol].sort())
    await expect(b.dm.renameGroup(key, 'Mine now')).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Only the group owner can do this' })

    await c.engine().tick()
    expect((await c.dm.conversations()).some(conv => conv.key === key)).toBe(true)

    expect(await b.settled(await b.dm.leaveGroup(key))).toMatchObject({ state: 'confirmed' })
    // Left: hidden here until the owner removes the member (docs/DM_V5.md §6.4).
    expect((await b.dm.conversations()).find(conv => conv.key === key)?.flags.hidden).toBe(true)
  })

  it('reports a failed group write on its ticket', async () => {
    const ledger = ledgerNow()
    const a = await ready(userOn(ledger, alice))
    await ready(userOn(ledger, bob))
    const ticket = await a.settled(await a.dm.createGroup('Team', [bob]))
    const key = (await a.dm.createdGroup(ticket.id))?.key ?? ''
    const chain = (a.engine().ctx.chain as MemoryChain)
    chain.hook = method => (method === 'replaceGroupDoc' ? { ok: false, failure: 'other', error: 'Insufficient identity balance (code=30000)' } : null)
    const failed = await a.settled(await a.dm.renameGroup(key, 'Nope'))
    expect(failed).toMatchObject({ state: 'failed', error: expect.objectContaining({ code: expect.any(String), outcome: 'refused' }) })

    // A transport failure carries no verdict: the rename may have landed, so it is checked, never retried blind.
    // ('other' so lib's owner loop gives up at once instead of backing off for its transport retries.)
    chain.hook = method => (method === 'replaceGroupDoc' ? { ok: false, failure: 'other', error: 'transport error: grpc error: Failed to fetch' } : null)
    const uncertain = await a.settled(await a.dm.renameGroup(key, 'Maybe'))
    expect(uncertain).toMatchObject({ state: 'unconfirmed', retryable: false, error: expect.objectContaining({ code: 'NETWORK', outcome: 'unknown' }) })
  })
})

/** A fake legacy service: conversations keyed by id, messages per conversation, oldest first. */
function fakeLegacy(me: string) {
  const conversations = new Map<string, Conversation>()
  const threads = new Map<string, DirectMessage[]>()
  let failList = false
  const message = (conversationId: string, i: number, from: string, at: number): DirectMessage =>
    ({ id: `${conversationId}-${i}`, senderId: from, recipientId: from === me ? 'peer' : me, conversationId, content: `m${i}`, createdAt: new Date(at) })
  const service = {
    getConversations: vi.fn(async () => (failList ? [] : [...conversations.values()])),
    getConversationMessages: vi.fn(async (id: string) => (threads.get(id) ?? []).slice(0, 100)),
    pollNewMessages: vi.fn(async (id: string, startAfter: string | undefined) => {
      const all = threads.get(id) ?? []
      const from = startAfter ? all.findIndex(m => m.id === startAfter) + 1 : 0
      const messages = all.slice(from, from + 100)
      return { messages, cursor: messages.at(-1)?.id ?? startAfter }
    }),
    sendMessage: vi.fn(async (_sender: string, recipient: string, content: string) => {
      const conversationId = [...conversations.values()].find(c => c.participantId === recipient)?.id ?? `conv-${recipient}`
      return { success: true, message: { id: `sent-${content}`, senderId: me, recipientId: recipient, conversationId, content, createdAt: new Date(2_000_000) } }
    }),
    markAsRead: vi.fn(async () => undefined),
    getOrCreateConversation: vi.fn(async (_me: string, peer: string) => ({ conversationId: `conv-${peer}`, isNew: true })),
    getParticipantLastRead: vi.fn(async () => 1_500_000),
  } satisfies LegacyDmService
  return {
    service, conversations, threads, message,
    failLists: () => { failList = true },
    add(id: string, peer: string, count: number, unread = 0) {
      const list = Array.from({ length: count }, (_, i) => message(id, i, i % 2 ? me : peer, 1_000_000 + i * 1000))
      threads.set(id, list)
      conversations.set(id, { id, participantId: peer, unreadCount: unread, lastMessage: list.at(-1) ?? null, updatedAt: list.at(-1)?.createdAt ?? new Date(0) })
    },
  }
}

function legacyUser(me = alice) {
  const legacy = fakeLegacy(me)
  const user = userOn(ledgerNow(), me, { backend: 'legacy', legacyService: legacy.service })
  return { ...user, legacy }
}

describe('dm on legacy 1:1 (testnet)', () => {
  it('lists conversations with the same DTOs, keyed l:<conversationId>', async () => {
    const user = legacyUser()
    user.legacy.add('C1', bob, 3, 2)
    const [conversation] = await user.dm.conversations()
    expectValid(conversationDTO, conversation)
    expect(conversation).toMatchObject({ key: 'l:C1', backend: 'legacy', kind: 'direct', peer: { id: bob }, unread: 2, lastMessage: { text: 'm2', own: false } })
    expectValid(dmStatusDTO, await user.dm.status())
    expect(await user.dm.status()).toMatchObject({ backend: 'legacy', locked: false, ready: true, unreadTotal: 2, unreadConversations: 1, retention: null })
  })

  it('reads the whole thread across pages, and pages it newest first', async () => {
    const user = legacyUser()
    user.legacy.add('C1', bob, 230)
    await user.dm.conversations()
    const first = await user.dm.messages('l:C1')
    expect(first.items[0].text).toBe('m229')
    const pages = [first]
    while (pages.at(-1)?.cursor) pages.push(await user.dm.messages('l:C1', pages.at(-1)?.cursor))
    expect(pages.flatMap(p => p.items)).toHaveLength(230)
    expect(user.legacy.service.pollNewMessages).toHaveBeenCalledTimes(3)
  })

  it('sends through a ticket naming the document, and starts a draft conversation', async () => {
    const user = legacyUser()
    const key = await user.dm.startDirect(carol)
    expect(key).toBe(`l:conv-${carol}`)
    expect(await user.dm.conversations()).toEqual([])
    await user.dm.open(key)
    expect((await user.dm.conversations())[0].flags.draft).toBe(true)
    settleSupersededReplaces.mockClear()
    const ticket = await user.settled(await user.dm.send(key, 'hey'))
    expect(ticket).toMatchObject({ state: 'confirmed', documents: [{ type: 'directMessage', id: 'sent-hey', action: 'create', confirmed: true }] })
    expect(settleSupersededReplaces).not.toHaveBeenCalled()
    expect(user.legacy.service.sendMessage).toHaveBeenCalledWith(alice, carol, 'hey')
    expect((await user.dm.conversations())[0]).toMatchObject({ lastMessage: { text: 'hey', own: true }, flags: { draft: false } })
  })

  it('writes a read receipt only with read receipts on and something unread', async () => {
    const user = legacyUser()
    user.legacy.add('C1', bob, 2, 1)
    await user.dm.conversations()
    useSettingsStore.getState().setSendReadReceipts(false)
    await user.dm.markRead('l:C1')
    expect(user.legacy.service.markAsRead).not.toHaveBeenCalled()
    expect((await user.dm.conversations())[0].unread).toBe(0)

    user.legacy.add('C2', carol, 3, 1)
    await user.hooks.stop()
    user.hooks.sessionChanged(started(alice))
    useSettingsStore.getState().setSendReadReceipts(true)
    await user.dm.conversations()
    await user.dm.markRead('l:C2')
    await user.dm.markRead('l:C2')
    expect(user.legacy.service.markAsRead).toHaveBeenCalledTimes(1)
  })

  it('polls the open conversation every 3 s, announcing new messages and the peer receipt; pauses in the background', async () => {
    vi.useFakeTimers()
    const user = legacyUser()
    user.legacy.add('C1', bob, 2)
    await user.dm.conversations()
    useSettingsStore.getState().setSendReadReceipts(true)
    await user.dm.open('l:C1')
    expect((await user.dm.conversations())[0].peerReadAt).toEqual(new Date(1_500_000))
    user.legacy.threads.get('C1')?.push(user.legacy.message('C1', 2, bob, Date.now()))
    await vi.advanceTimersByTimeAsync(LEGACY_OPEN_POLL_MS + 10)
    expect(user.eventsOf('dm.message')).toEqual([{ key: 'l:C1', message: expect.objectContaining({ text: 'm2', own: false }) }])
    expect((await user.dm.messages('l:C1')).items[0].text).toBe('m2')

    await user.hooks.lifecycle('background')
    const polls = user.legacy.service.pollNewMessages.mock.calls.length
    await vi.advanceTimersByTimeAsync(LEGACY_OPEN_POLL_MS * 3)
    expect(user.legacy.service.pollNewMessages.mock.calls.length).toBe(polls)
    await user.hooks.lifecycle('active')
    await vi.advanceTimersByTimeAsync(LEGACY_OPEN_POLL_MS + 10)
    expect(user.legacy.service.pollNewMessages.mock.calls.length).toBe(polls + 1)
  })

  it('keeps a conversation whose page failed, and shows no badge without read receipts', async () => {
    vi.useFakeTimers()
    const user = legacyUser()
    user.legacy.add('C1', bob, 3, 2)
    useSettingsStore.getState().setSendReadReceipts(true)
    expect(await user.dm.status()).toMatchObject({ unreadTotal: 2, unreadConversations: 1 })
    user.legacy.conversations.set('C1', { id: 'C1', participantId: bob, unreadCount: 0, lastMessage: null, updatedAt: new Date() })
    await vi.advanceTimersByTimeAsync(LEGACY_LIST_TTL_MS + 1_000)
    expect((await user.dm.conversations())[0]).toMatchObject({ unread: 2, lastMessage: { text: 'm2' } })
    useSettingsStore.getState().setSendReadReceipts(false)
    expect(await user.dm.status()).toMatchObject({ unreadTotal: 0, unreadConversations: 0 })
    expect((await user.dm.conversations())[0].unread).toBe(2)
    useSettingsStore.getState().setSendReadReceipts(true)
  })

  it('keeps the list when lib reports a failed read as empty', async () => {
    vi.useFakeTimers()
    const user = legacyUser()
    user.legacy.add('C1', bob, 1)
    await user.dm.conversations()
    user.legacy.failLists()
    await vi.advanceTimersByTimeAsync(LEGACY_LIST_TTL_MS + 1_000)
    expect((await user.dm.conversations()).map(c => c.key)).toEqual(['l:C1'])
    expect((await user.dm.status()).error).toBe('Could not load conversations')
  })

  it('refuses the v5-only actions', async () => {
    const user = legacyUser()
    user.legacy.add('C1', bob, 1)
    for (const call of [
      () => user.dm.createGroup('Team', [bob]),
      () => user.dm.renameGroup('l:C1', 'x'),
      () => user.dm.hide('l:C1'),
      () => user.dm.setBlocked(bob, true),
      () => user.dm.setRetention('30d'),
    ]) await expect(call()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(user.dm.messages('l:nope')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
