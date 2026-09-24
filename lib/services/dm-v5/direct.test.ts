import { describe, expect, it } from 'vitest'
import { bytesEqual } from '@/lib/bytes'
import { weekOf, weekStart } from '@/lib/dm/kdf'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import { encryptMessage } from '@/lib/dm/stream'
import { NoEncryptionKeyError, PeerKeyLookupError, attachSaved, directConv, type DmContext } from './context'
import { openDirect, ensureStarted } from './directs'
import { sendInvite } from './invites'
import { pollOnce } from './loop'
import { sendContent } from './sender'
import { stream, timeline } from './conversation'
import { MapKv, MemoryLedger, makeContext } from './test-chain'
import { splitText, MAX_TEXT_BYTES } from './util'
import { MAX_NONCE_RETRIES, classifyWriteFailure, nonceBackoffMs, withNonceRetry } from './write-failure'

const texts = (ctx: DmContext, peer: Uint8Array) =>
  timeline(directConv(ctx, peer) ?? (() => { throw new Error('no conversation') })())
    .map((m) => (m.content.type === 'text' ? m.content.text : `<${m.content.type}>`))

/** Let a device catch up on its own stream in a conversation (what an open thread does). */
async function syncOnce(ctx: DmContext, conv: Awaited<ReturnType<typeof openDirect>>) {
  conv.open = true
  await pollOnce(ctx)
  conv.open = false
}

async function sendText(ctx: DmContext, peer: Uint8Array, text: string) {
  const conv = await openDirect(ctx, peer)
  await ensureStarted(ctx, conv)
  return sendContent(ctx, conv, { type: 'text', text })
}

describe('1:1 first contact and messaging', () => {
  it('delivers through one invite and a normal first message, and writes no second invite', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)

    await sendText(alice.ctx, BOB_ID, 'hi bob')
    expect(ledger.invites).toHaveLength(1)
    expect(ledger.selfStates).toHaveLength(1) // saved immediately on start (§5.5)

    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['hi bob'])

    // Bob replies: a conversation already exists from Alice's invite, so no invite.
    await sendText(bob.ctx, ALICE_ID, 'hey alice')
    expect(ledger.invites).toHaveLength(1)
    await pollOnce(alice.ctx)
    expect(texts(alice.ctx, BOB_ID)).toEqual(['hi bob', 'hey alice'])

    // Alice again: still one invite.
    await sendText(alice.ctx, BOB_ID, 'second')
    expect(ledger.invites).toHaveLength(1)
  })

  it('refuses to start a chat with someone who has no encryption key', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await expect(openDirect(alice.ctx, CAROL_ID)).rejects.toThrow(/encryption key/)
  })

  it('reports a failed key lookup as retryable, not as a missing encryption key (review 5 #2)', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    let down = true
    const lookup = alice.chain.encryptionKey.bind(alice.chain)
    alice.chain.encryptionKey = async (id) => {
      if (down) throw new Error('DAPI timeout')
      return lookup(id)
    }
    await expect(openDirect(alice.ctx, BOB_ID)).rejects.toThrow(PeerKeyLookupError)
    await expect(openDirect(alice.ctx, BOB_ID)).rejects.not.toThrow(/no encryption key/)
    await expect(sendInvite(alice.ctx, BOB_ID)).rejects.toThrow(PeerKeyLookupError)
    down = false
    await expect(openDirect(alice.ctx, BOB_ID)).resolves.toBeTruthy()
    await expect(openDirect(alice.ctx, CAROL_ID)).rejects.toThrow(NoEncryptionKeyError)
    await expect(sendInvite(alice.ctx, CAROL_ID)).rejects.toThrow(NoEncryptionKeyError)
  })

  it('drops invites and messages from blocked senders', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    bob.ctx.store.setBlocked(ALICE_ID, true, ledger.time)
    await sendText(alice.ctx, BOB_ID, 'spam')
    await pollOnce(bob.ctx)
    expect(directConv(bob.ctx, ALICE_ID)).toBeNull()
  })

  it('ignores a document at the tag written by someone other than the stream sender', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await sendText(alice.ctx, BOB_ID, 'one')
    await pollOnce(bob.ctx)

    // Carol squats Alice's next tag (she cannot compute it in reality; the reader must ignore it anyway).
    const conv = directConv(bob.ctx, ALICE_ID)
    const st = conv && stream(conv, ALICE_ID, { b: 0, r: 0 })
    if (!st) throw new Error('no stream')
    const w = weekOf(ledger.time)
    const forged = await encryptMessage({ streamKey: st.key, senderId: ALICE_ID, w, j: 1 }, { prev: null, content: { type: 'text', text: 'forged' } })
    await carol.chain.createMessage(forged.tag, forged.body)
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['one'])
  })
})

describe('squatted tags (§6.1)', () => {
  it('a reader polling live reads on past a squatted next tag to the sender\'s retry', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await sendText(alice.ctx, BOB_ID, 'one')
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['one'])

    // Carol takes Alice's next tag (in a group any member can compute it).
    const conv = directConv(alice.ctx, BOB_ID)
    const st = conv && stream(conv, ALICE_ID, { b: 0, r: 0 })
    if (!st) throw new Error('no stream')
    const w = weekOf(ledger.time)
    const squat = await encryptMessage({ streamKey: st.key, senderId: ALICE_ID, w, j: 1 }, { prev: null, content: { type: 'text', text: 'squat' } })
    await carol.chain.createMessage(squat.tag, squat.body)

    // Alice's send is refused at j = 1 and lands at j = 2.
    const held = await sendText(alice.ctx, BOB_ID, 'two')
    expect(held.pointer.j).toBe(2)

    // Bob, polling without a reload, still reaches it in the same week.
    await pollOnce(bob.ctx)
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['one', 'two'])
  })

  it('reads and writes past a run of squatted slots longer than the retry budget', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await sendText(alice.ctx, BOB_ID, 'one')
    await pollOnce(bob.ctx)
    const conv = directConv(alice.ctx, BOB_ID)
    const st = conv && stream(conv, ALICE_ID, { b: 0, r: 0 })
    if (!st) throw new Error('no stream')
    const w = weekOf(ledger.time)
    // Carol fills j = 1..30 (more than the 20 attempts one send makes).
    for (let j = 1; j <= 30; j++) {
      const squat = await encryptMessage({ streamKey: st.key, senderId: ALICE_ID, w, j }, { prev: null, content: { type: 'text', text: `squat ${j}` } })
      await carol.chain.createMessage(squat.tag, squat.body)
    }
    let attempts = 0
    alice.chain.hook = (method) => {
      if (method === 'createMessage') attempts++
      return null
    }
    const held = await sendText(alice.ctx, BOB_ID, 'two')
    expect(held.pointer.j).toBe(31)
    expect(attempts).toBe(1)
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['one', 'two'])
  })

  it('does not let squats past a free slot hide the sender\'s next message there', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await sendText(alice.ctx, BOB_ID, 'zero')
    await pollOnce(bob.ctx)
    const conv = directConv(alice.ctx, BOB_ID)
    const st = conv && stream(conv, ALICE_ID, { b: 0, r: 0 })
    if (!st) throw new Error('no stream')
    const w = weekOf(ledger.time)
    // Carol squats j = 3..5, leaving j = 1 and 2 free.
    for (let j = 3; j <= 5; j++) {
      const squat = await encryptMessage({ streamKey: st.key, senderId: ALICE_ID, w, j }, { prev: null, content: { type: 'text', text: `squat ${j}` } })
      await carol.chain.createMessage(squat.tag, squat.body)
    }
    await sendText(alice.ctx, BOB_ID, 'one') // j = 1
    await pollOnce(bob.ctx)
    await sendText(alice.ctx, BOB_ID, 'two') // j = 2: must not be behind Bob's cursor
    await pollOnce(bob.ctx)
    expect(texts(bob.ctx, ALICE_ID)).toEqual(['zero', 'one', 'two'])
  })

  it('skips a squatted slot on the next send instead of paying for a refused write', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const carol = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    await sendText(alice.ctx, BOB_ID, 'one')
    const conv = directConv(alice.ctx, BOB_ID)
    const st = conv && stream(conv, ALICE_ID, { b: 0, r: 0 })
    if (!st) throw new Error('no stream')
    const w = weekOf(ledger.time)
    const squat = await encryptMessage({ streamKey: st.key, senderId: ALICE_ID, w, j: 1 }, { prev: null, content: { type: 'text', text: 'squat' } })
    await carol.chain.createMessage(squat.tag, squat.body)
    // Alice's device catches up on its own stream before choosing j, and the squatted slot counts as taken.
    let attempts = 0
    alice.chain.hook = (method) => {
      if (method === 'createMessage') attempts++
      return null
    }
    const held = await sendText(alice.ctx, BOB_ID, 'two')
    expect(held.pointer.j).toBe(2)
    expect(attempts).toBe(1)
  })
})

describe('sender', () => {
  it('does not mistake my other device\'s message at the same tag for its own uncertain send', async () => {
    const ledger = new MemoryLedger()
    const phone = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const laptop = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const laptopConv = await openDirect(laptop.ctx, BOB_ID)
    laptopConv.draft = false
    await sendText(phone.ctx, BOB_ID, 'from phone')
    // Both devices chose j = 0 at the same moment: the laptop's catch-up missed the phone's message,
    // and its own broadcast was refused on chain but the client only saw the DAPI timeout.
    const read = laptop.chain.messagesByTags.bind(laptop.chain)
    let catchUp = true
    laptop.chain.messagesByTags = async (tags) => (catchUp ? [] : read(tags))
    let first = true
    laptop.chain.hook = (method) => {
      if (method !== 'createMessage') return null
      catchUp = false
      if (!first) return null
      first = false
      return { ok: true, id: 'timed-out', confirmed: false }
    }
    const held = await sendContent(laptop.ctx, laptopConv, { type: 'text', text: 'from laptop' })
    // The phone's message at j = 0 is not the laptop's: the laptop's text must be on chain, at j = 1.
    expect(held.pointer.j).toBe(1)
    expect(ledger.messages).toHaveLength(2)
  })

  it('links the retry to my other device\'s message that took the slot, so a reader resuming from its head finds both', async () => {
    const ledger = new MemoryLedger()
    const phone = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const laptop = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bobKv = new MapKv()
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV, bobKv)
    await sendText(phone.ctx, BOB_ID, 'zero')
    await pollOnce(bob.ctx)
    const laptopConv = await openDirect(laptop.ctx, BOB_ID)
    laptopConv.draft = false
    await syncOnce(laptop.ctx, laptopConv)
    // Both devices pick j = 1: the phone wins, the laptop's catch-up had not seen it yet.
    const read = laptop.chain.messagesByTags.bind(laptop.chain)
    let catchUp = true
    laptop.chain.messagesByTags = async (tags) => (catchUp ? [] : read(tags))
    laptop.chain.hook = (method) => {
      if (method === 'createMessage') catchUp = false
      return null
    }
    await sendText(phone.ctx, BOB_ID, 'from phone')
    const held = await sendContent(laptop.ctx, laptopConv, { type: 'text', text: 'from laptop' })
    expect(held.pointer.j).toBe(2)
    // Bob caches the newest head (j = 2), then reloads with nothing else: he resumes at that head and
    // reaches the rest only by walking prev back from it, so a fork past j = 1 would lose it.
    await pollOnce(bob.ctx)
    bob.ctx.cache.persist()
    const reloaded = makeContext(ledger, BOB_ID, BOB_PRIV, bobKv)
    await reloaded.ctx.store.load()
    await attachSaved(reloaded.ctx)
    await pollOnce(reloaded.ctx)
    expect(texts(reloaded.ctx, ALICE_ID)).toEqual(['zero', 'from phone', 'from laptop'])
  })

  it('retries the same slot when my other device used the identity nonce first', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const conv = await openDirect(alice.ctx, BOB_ID)
    await ensureStarted(alice.ctx, conv)
    let calls = 0
    alice.chain.hook = (method) => {
      if (method !== 'createMessage') return null
      calls++
      return calls === 1
        ? { ok: false, failure: 'nonce', error: 'invalid identity nonce … nonce already present at tip' }
        : null
    }
    const held = await sendContent(alice.ctx, conv, { type: 'text', text: 'after a nonce clash' })
    expect(calls).toBe(2)
    expect(held.pointer.j).toBe(0)
    expect(ledger.messages).toHaveLength(1)
    // It waited before the retry, rather than hitting the lagging node again at once.
    expect(alice.chain.sleeps).toHaveLength(1)
    expect(alice.chain.sleeps[0]).toBeGreaterThanOrEqual(250)
  })

  it('backs off 250 ms · 2^n plus jitter between nonce retries, and gives up after three', async () => {
    expect([0, 1, 2].map((n) => nonceBackoffMs(n, () => 0))).toEqual([250, 500, 1000])
    expect([0, 1, 2].map((n) => nonceBackoffMs(n, () => 0.999))).toEqual([499, 999, 1999])
    const waits: number[] = []
    let calls = 0
    const outcome = await withNonceRetry(
      async () => {
        calls++
        return { ok: false as const, failure: 'nonce' as const, error: 'nonce already present at tip' }
      },
      async (ms) => {
        waits.push(ms)
      }
    )
    expect(outcome.ok).toBe(false)
    expect(calls).toBe(1 + MAX_NONCE_RETRIES)
    expect(waits).toHaveLength(MAX_NONCE_RETRIES)
    waits.forEach((ms, n) => {
      expect(ms).toBeGreaterThanOrEqual(250 * 2 ** n)
      expect(ms).toBeLessThan(500 * 2 ** n)
    })
  })

  it('retries the first-contact invite after a nonce clash instead of failing the send', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    let clashes = 0
    alice.chain.hook = (method) => {
      if (method !== 'createInvite' || clashes >= 2) return null
      clashes++
      return { ok: false, failure: 'nonce', error: 'invalid identity nonce … nonce already present at tip' }
    }
    await sendText(alice.ctx, BOB_ID, 'first contact')
    expect(ledger.invites).toHaveLength(1)
    expect(ledger.messages).toHaveLength(1)
    expect(alice.chain.sleeps).toHaveLength(2)
  })

  it('classifies write refusals from their error text', () => {
    expect(classifyWriteFailure('Document X has duplicate unique properties ["tag"] with other documents')).toBe('duplicate')
    expect(classifyWriteFailure('Document X has invalid revision Some(2). The desired revision is 2 | code=40106')).toBe('stale')
    expect(classifyWriteFailure('Protocol error: Identity Y is trying to set an invalid identity nonce. The current identity nonce is 764, we are setting 764, error is nonce already present at tip')).toBe('nonce')
    expect(classifyWriteFailure('insufficient balance')).toBe('other')
    // Never reached a verdict: retryable, unlike a real refusal.
    expect(classifyWriteFailure('context provider error: invalid quorum: Quorum not found in cache for hash: 00ab')).toBe('transport')
    expect(classifyWriteFailure('No available addresses to retry')).toBe('transport')
    expect(classifyWriteFailure('gRPC status UNAVAILABLE: transport is closing')).toBe('transport')
    expect(classifyWriteFailure('Identity has insufficient balance to pay for the state transition')).toBe('other')
    // Browser and SDK network failures (review 3 #2), including one captured from a devnet run.
    for (const message of [
      'TypeError: Failed to fetch',
      'TypeError: Load failed',
      'NetworkError when attempting to fetch resource.',
      'missing response message',
      'Deadline exceeded',
      'connect ECONNREFUSED 127.0.0.1:1443',
      'connect ETIMEDOUT 10.0.0.1:1443',
      'transport collapsed — reconnecting: context provider error: invalid quorum: Quorum not found in cache for hash: 0000026347a3d552515e317b7b37763311b157547a1cc9d0e27916a4a40fe4b0',
    ]) {
      expect(classifyWriteFailure(message), message).toBe('transport')
    }
  })

  it('retries at j + 1 when another device took the tag (40105)', async () => {
    const ledger = new MemoryLedger()
    const phone = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const laptop = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const laptopConv = await openDirect(laptop.ctx, BOB_ID)
    laptopConv.draft = false
    await sendText(phone.ctx, BOB_ID, 'from phone')
    // The laptop's own-stream catch-up misses the phone's message (a lagging node), so it picks j = 0.
    const read = laptop.chain.messagesByTags.bind(laptop.chain)
    laptop.chain.messagesByTags = async () => []
    const writes: number[] = []
    laptop.chain.hook = (method) => {
      if (method === 'createMessage') writes.push(ledger.messages.length)
      return null
    }
    const held = await sendContent(laptop.ctx, laptopConv, { type: 'text', text: 'from laptop' })
    laptop.chain.messagesByTags = read
    expect(writes).toHaveLength(2)
    expect(held.pointer.j).toBe(1)
    expect(ledger.messages).toHaveLength(2)
  })

  it('rebroadcasts after an uncertain broadcast whose tag is not found', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const conv = await openDirect(alice.ctx, BOB_ID)
    await ensureStarted(alice.ctx, conv)
    let calls = 0
    alice.chain.hook = (method) => {
      if (method !== 'createMessage') return null
      calls++
      return calls === 1 ? { ok: true, id: 'lost', confirmed: false } : null
    }
    const held = await sendContent(alice.ctx, conv, { type: 'text', text: 'x' })
    expect(calls).toBe(2)
    expect(ledger.messages).toHaveLength(1)
    expect(held.pointer.j).toBe(0)
  })

  it('recognises a late landing of its own first broadcast when the rebroadcast is refused (40105)', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const conv = await openDirect(alice.ctx, BOB_ID)
    await ensureStarted(alice.ctx, conv)
    // The first broadcast times out and is not visible yet; it lands while the rebroadcast is in flight.
    const bodies: Uint8Array[] = []
    let late: (() => Promise<unknown>) | null = null
    const create = alice.chain.createMessage.bind(alice.chain)
    alice.chain.createMessage = async (tag, body) => {
      bodies.push(body)
      if (bodies.length === 1) {
        late = () => create(tag, body)
        return { ok: true, id: 'timed-out', confirmed: false }
      }
      await late?.()
      return create(tag, body)
    }
    const held = await sendContent(alice.ctx, conv, { type: 'text', text: 'x' })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0]) // the same bytes, so the late landing is recognised
    expect(held.pointer.j).toBe(0)
    expect(ledger.messages).toHaveLength(1)
  })

  it('does not send twice when an uncertain broadcast becomes visible during the read-back', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const conv = await openDirect(alice.ctx, BOB_ID)
    await ensureStarted(alice.ctx, conv)
    // The broadcast times out; the node lags, so the transition becomes visible only after the first read.
    const create = alice.chain.createMessage.bind(alice.chain)
    const read = alice.chain.messagesByTags.bind(alice.chain)
    let pending: (() => Promise<unknown>) | null = null
    alice.chain.createMessage = async (tag, body) => {
      pending = () => create(tag, body)
      return { ok: true, id: 'timed-out', confirmed: false }
    }
    alice.chain.messagesByTags = async (tags) => {
      const docs = await read(tags)
      if (pending) {
        const land = pending
        pending = null
        await land()
      }
      return docs
    }
    const held = await sendContent(alice.ctx, conv, { type: 'text', text: 'once' })
    alice.chain.messagesByTags = read
    expect(ledger.messages).toHaveLength(1)
    expect(held.pointer.j).toBe(0)
  })

  it('does not rebroadcast an uncertain broadcast that landed', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const conv = await openDirect(alice.ctx, BOB_ID)
    await ensureStarted(alice.ctx, conv)
    alice.chain.unconfirmed = 1
    await sendContent(alice.ctx, conv, { type: 'text', text: 'x' })
    expect(ledger.messages).toHaveLength(1)
  })

  it('links prev to the newest own message, across a week rollover', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    makeContext(ledger, BOB_ID, BOB_PRIV)
    const first = await sendText(alice.ctx, BOB_ID, 'a')
    ledger.time = weekStart(weekOf(ledger.time) + 1) + 5
    const second = await sendText(alice.ctx, BOB_ID, 'b')
    expect(second.pointer.w).toBe(first.pointer.w + 1)
    expect(second.pointer.j).toBe(0)
    expect(second.prev).toEqual(first.pointer)
  })

  it('splits long text into messages that each fit the largest class', () => {
    const pieces = splitText('é'.repeat(MAX_TEXT_BYTES))
    // 'é' is two bytes, so each piece holds floor(MAX / 2) of them.
    expect(pieces.length).toBe(Math.ceil(MAX_TEXT_BYTES / Math.floor(MAX_TEXT_BYTES / 2)))
    for (const piece of pieces) expect(new TextEncoder().encode(piece).length).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    expect(pieces.join('')).toBe('é'.repeat(MAX_TEXT_BYTES))
  })
})

describe('peers', () => {
  it('computes the same conversation from both sides', async () => {
    const ledger = new MemoryLedger()
    const alice = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const bob = makeContext(ledger, BOB_ID, BOB_PRIV)
    const a = await openDirect(alice.ctx, BOB_ID)
    const b = await openDirect(bob.ctx, ALICE_ID)
    expect(a.convKey && b.convKey && bytesEqual(a.convKey, b.convKey)).toBe(true)
  })
})
