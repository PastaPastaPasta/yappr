import { describe, expect, it } from 'vitest'
import { bytesEqual } from '@/lib/bytes'
import { weekOf, weekStart } from '@/lib/dm/kdf'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import { encryptMessage } from '@/lib/dm/stream'
import { directConv, type DmContext } from './context'
import { openDirect, ensureStarted } from './directs'
import { pollOnce } from './loop'
import { sendContent } from './sender'
import { stream, timeline } from './conversation'
import { MemoryLedger, makeContext } from './test-chain'
import { splitText, MAX_TEXT_BYTES } from './util'

const texts = (ctx: DmContext, peer: Uint8Array) =>
  timeline(directConv(ctx, peer) ?? (() => { throw new Error('no conversation') })())
    .map((m) => (m.content.type === 'text' ? m.content.text : `<${m.content.type}>`))

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

describe('sender', () => {
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
