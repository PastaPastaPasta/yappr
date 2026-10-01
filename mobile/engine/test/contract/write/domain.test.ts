/**
 * The domain writes on sakura (ENGINE.md §12.3), with pool personas, serial,
 * through the real dispatcher, client and codec. Self-cleaning where the
 * topology deletes for real. Retries happen only on TIMEOUT, NETWORK and
 * RATE_LIMITED (at most twice, 5 s apart); a refusal fails the test at once.
 * The run's credit spend is written to `$EVIDENCE_DIR/contract-write-domain.json`.
 *
 * Skips with the reason until W-SAKURA lands (`.env.devnet` on sakura) and
 * `YAPPR_SAKURA_IDENTITIES` is set. Never testnet.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadPoolPersonas, type PoolPersona } from '../../../harness/pool'
import type { CapabilitiesDTO, TargetRef, WriteTicket } from '../../../src/api'
import { connectEngine } from '../engine'
import { writeSuiteSkipReason } from './env'

const skipReason = writeSuiteSkipReason()
const TRANSIENT = ['TIMEOUT', 'NETWORK', 'RATE_LIMITED']

type Engine = ReturnType<typeof connectEngine>

describe.skipIf(skipReason !== null)(`domain writes on sakura${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  let alice: PoolPersona
  let bob: PoolPersona
  let engine: Engine
  let caps: CapabilitiesDTO
  const spend: { identityId: string; before: bigint; after?: bigint }[] = []
  /** Everything this run posted, deleted at the end (newest first). */
  const created: TargetRef[] = []

  async function signIn(persona: PoolPersona): Promise<void> {
    await engine.api.session.signOut()
    await engine.api.session.signInWithKey({ key: persona.keyHex('high') })
    const { credits } = await engine.api.session.refreshBalance()
    if (!spend.some(entry => entry.identityId === persona.identityId)) spend.push({ identityId: persona.identityId, before: credits })
  }

  /** The ticket once settled: pending → anything else, waiting up to 2 minutes. */
  async function settled(ticketId: string): Promise<WriteTicket> {
    for (let i = 0; i < 240; i++) {
      const ticket = await engine.api.writes.get(ticketId)
      if (ticket && ticket.state !== 'pending') return ticket
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`ticket ${ticketId} still pending after 120 s`)
  }

  /**
   * Run a write to `confirmed`: an unconfirmed ticket is checked (twice at
   * most), a transient failure retried (twice at most, 5 s apart). Anything
   * else fails the test with the ticket's error.
   */
  async function confirmed(submit: () => Promise<WriteTicket>): Promise<WriteTicket> {
    let ticket = await settled((await submit()).id)
    for (let attempt = 0; attempt < 2 && ticket.state !== 'confirmed'; attempt++) {
      if (ticket.state === 'unconfirmed') {
        await new Promise(resolve => setTimeout(resolve, 3_000))
        ticket = await engine.api.writes.check(ticket.id)
      } else if (ticket.state === 'failed' && ticket.retryable && TRANSIENT.includes(ticket.error?.code ?? '')) {
        await new Promise(resolve => setTimeout(resolve, 5_000))
        ticket = await settled((await engine.api.writes.retry(ticket.id)).id)
      } else {
        break
      }
    }
    expect(ticket.state, JSON.stringify(ticket.error)).toBe('confirmed')
    return ticket
  }

  const ref = (ticket: WriteTicket, ownerId: string, part = 0): TargetRef => {
    const doc = ticket.documents.find(entry => entry.part === part)
    if (!doc) throw new Error(`part ${part} was not posted`)
    return { id: doc.id, kind: doc.type === 'reply' ? 'reply' : 'post', ownerId, rootPostId: null }
  }

  beforeAll(async () => {
    [alice, bob] = loadPoolPersonas().slice(4, 6)
    engine = connectEngine({ timeoutMs: 300_000 })
    caps = (await engine.api.engine.boot()).capabilities
    await signIn(alice)
  })

  afterAll(async () => {
    if (!engine) return
    await signIn(alice).catch(() => undefined)
    for (const target of created.reverse()) {
      await engine.api.posts.delete(target).then(ticket => settled(ticket.id)).catch(() => undefined)
    }
    for (const persona of [alice, bob]) {
      const entry = spend.find(item => item.identityId === persona.identityId)
      if (!entry) continue
      await signIn(persona).catch(() => undefined)
      entry.after = (await engine.api.session.refreshBalance().catch(() => ({ credits: entry.before }))).credits
    }
    const dir = process.env.EVIDENCE_DIR ?? path.resolve(__dirname, '../../../test-results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'contract-write-domain.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      spend: spend.map(entry => ({ identityId: entry.identityId, credits: String(entry.before - (entry.after ?? entry.before)) })),
    }, null, 2)}\n`)
    await engine.api.session.signOut()
  })

  it('posts, reads it back, emits content.created, and deletes it', async () => {
    const ticket = await confirmed(() => engine.api.posts.publish({ parts: [{ text: `mobile write suite ${Date.now()}` }] }))
    const target = ref(ticket, alice.identityId)
    expect(engine.events).toContainEqual(expect.objectContaining({ event: 'write.status', payload: expect.objectContaining({ id: ticket.id, state: 'confirmed' }) }))
    expect((await engine.api.posts.get(target.id))?.author.id).toBe(alice.identityId)
    await confirmed(() => engine.api.posts.delete(target))
    if (!caps.deletesAreTombstones) expect(await engine.api.posts.get(target.id)).toBeNull()
  })

  it('posts a 3-part thread, fails part 3 on purpose, and resumes it', async () => {
    const { replyService } = await import('@/lib/services/reply-service')
    const real = replyService.createReply.bind(replyService)
    let calls = 0
    // A refusal before anything is signed: the second reply (part 3) never leaves the device.
    const spy = vi.spyOn(replyService, 'createReply').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Identity does not have enough token balance, code=40700')
      return real(...args)
    })
    const parts = [{ text: `thread 1/3 ${Date.now()}` }, { text: 'thread 2/3' }, { text: 'thread 3/3' }]
    const failed = await settled((await engine.api.posts.publish({ parts })).id)
    spy.mockRestore()
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'INSUFFICIENT_YAPP' }, progress: { done: 2, total: 3 } })
    const postedIds = [0, 1, 2].map(part => failed.documents.find(doc => doc.part === part)?.id ?? null)
    expect(postedIds.slice(0, 2).every(Boolean)).toBe(true)
    const resumed = await confirmed(() => engine.api.posts.publish({ parts, resume: { postedIds } }))
    expect(resumed.documents).toEqual([expect.objectContaining({ part: 2, type: 'reply' })])
    created.push(ref(failed, alice.identityId), ref(failed, alice.identityId, 1), ref(resumed, alice.identityId, 2))
  })

  it('replies and quotes', async () => {
    const root = ref(await confirmed(() => engine.api.posts.publish({ parts: [{ text: `root ${Date.now()}` }] })), alice.identityId)
    created.push(root)
    const reply = await confirmed(() => engine.api.posts.publish({ parts: [{ text: 'a reply' }], replyTo: root }))
    expect(reply.documents[0]).toMatchObject({ type: 'reply' })
    created.push(ref(reply, alice.identityId))
    const quote = await confirmed(() => engine.api.posts.publish({ parts: [{ text: 'a quote' }], quote: root }))
    created.push(ref(quote, alice.identityId))
  })

  it('likes, reposts and bookmarks another persona\'s post, undoes each, and the author sees the like', async () => {
    await signIn(bob)
    const post = ref(await confirmed(() => engine.api.posts.publish({ parts: [{ text: `bob ${Date.now()}` }] })), bob.identityId)
    await signIn(alice)

    await confirmed(() => engine.api.engage.like(post))
    expect((await engine.api.engage.stats([{ id: post.id, kind: post.kind }]))[post.id].viewer?.liked).toBe(true)
    if (caps.repostable.post) {
      const repost = await confirmed(() => engine.api.engage.repost(post))
      if (caps.repostsAreQuotes) {
        // The slot is taken: a second bare repost recovers it instead of failing.
        const again = await confirmed(() => engine.api.engage.repost(post))
        expect(again.documents[0]?.id).toBe(repost.documents[0]?.id)
      }
      await confirmed(() => engine.api.engage.unrepost(post))
    }
    if (caps.bookmarkable.post) {
      await confirmed(() => engine.api.engage.bookmark(post))
      expect((await engine.api.engage.bookmarks()).items.map(item => item.id)).toContain(post.id)
      await confirmed(() => engine.api.engage.unbookmark(post))
    }

    await signIn(bob)
    const likes = await engine.api.notifications.list({ filter: 'like' })
    expect(likes.items.some(item => item.actor.id === alice.identityId && item.target?.id === post.id)).toBe(true)
    await engine.api.notifications.markVisibleRead()
    expect(await engine.api.notifications.unreadCount()).toBe(0)
    await confirmed(() => engine.api.posts.delete(post))
    await signIn(alice)
    await confirmed(() => engine.api.engage.unlike(post)).catch(() => undefined)
  })

  it('follows and unfollows, blocks and unblocks', async () => {
    await confirmed(() => engine.api.graph.follow(bob.identityId))
    expect((await engine.api.graph.status([bob.identityId]))[bob.identityId]).toBe(true)
    await confirmed(() => engine.api.graph.unfollow(bob.identityId))
    await confirmed(() => engine.api.safety.block(bob.identityId, { message: 'write suite' }))
    expect((await engine.api.safety.blocked()).items).toContainEqual(expect.objectContaining({ id: bob.identityId, message: 'write suite' }))
    await confirmed(() => engine.api.safety.unblock(bob.identityId))
  })

  it('reports a post where the contract takes reports', async () => {
    if (!caps.reports) return
    await signIn(bob)
    const post = ref(await confirmed(() => engine.api.posts.publish({ parts: [{ text: `report me ${Date.now()}` }] })), bob.identityId)
    await signIn(alice)
    await confirmed(() => engine.api.safety.report(post, 8, 'mobile write suite'))
    expect(await engine.api.safety.ownReport(post)).toMatchObject({ reason: 8, note: 'mobile write suite' })
    await signIn(bob)
    await confirmed(() => engine.api.posts.delete(post))
    await signIn(alice)
  })

  it('updates the profile and reads it back', async () => {
    const bio = `mobile write suite ${Date.now()}`
    await confirmed(() => engine.api.profiles.update({ bio, avatar: { dicebear: { style: 'bottts', seed: 'suite' } } }))
    expect((await engine.api.profiles.get(alice.identityId))?.bio).toBe(bio)
  })
})
