/**
 * Write tickets against sakura (ENGINE.md §12.3, §7.2): a real follow, forced
 * `unconfirmed` as if the confirmation wait had timed out, then proved by
 * `writes.check`; then the unfollow, proved absent the same way. Self-cleaning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadPoolPersonas, type PoolPersona } from '../../../harness/pool'
import { connectEngine } from './engine'
import { writeSuiteSkipReason } from './env'

const skipReason = writeSuiteSkipReason()

describe.skipIf(skipReason !== null)(`write tickets on sakura${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  let viewer: PoolPersona
  let target: PoolPersona
  let engine: ReturnType<typeof connectEngine>
  let store: import('../../../src/writes/tickets').TicketStore
  let writes: ReturnType<typeof import('../../../src/api/writes').createWritesModule>

  async function settled(ticketId: string) {
    for (let i = 0; i < 240; i++) {
      const ticket = store.get(ticketId)
      if (ticket && ticket.state !== 'pending') return ticket
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`ticket ${ticketId} still pending after 120 s`)
  }

  beforeAll(async () => {
    const personas = loadPoolPersonas()
    viewer = personas[2]
    target = personas[3]
    engine = connectEngine()
    await engine.api.engine.boot()
    await engine.api.session.signOut()
    await engine.api.session.signInWithKey({ key: viewer.keyHex('high') })

    const { YAPPR_CONTRACT_ID } = await import('@/lib/constants')
    const { followService } = await import('@/lib/services/follow-service')
    const { createEngineTicketStore, createWritesModule } = await import('../../../src/api/writes')
    const { fromTransitionResult } = await import('../../../src/writes/lib-results')
    store = createEngineTicketStore(() => undefined)
    writes = createWritesModule(store)

    const followDoc = async () => {
      const follow = await followService.getFollow(target.identityId, viewer.identityId)
      return follow ? [{ contractId: YAPPR_CONTRACT_ID, type: 'follow', id: follow.$id, action: 'create' as const, confirmed: false }] : []
    }
    // Forced unconfirmed: the result a DAPI wait timeout gives, so check has to prove it.
    store.register('follow', {
      async run() {
        const result = fromTransitionResult(await followService.followUser(viewer.identityId, target.identityId))
        return result.state === 'failed' ? result : { state: 'unconfirmed', documents: await followDoc() }
      },
    })
    store.register('unfollow', {
      async run(_args, ctx) {
        const documents = (await followDoc()).map(doc => ({ ...doc, action: 'delete' as const }))
        ctx.documents(documents)
        const result = fromTransitionResult(await followService.unfollowUser(viewer.identityId, target.identityId))
        return result.state === 'failed' ? result : { state: 'unconfirmed', documents }
      },
    })
  })

  afterAll(async () => {
    await engine?.api.session.signOut()
  })

  it('proves a create with check, and refuses to retry it', async () => {
    const ticket = store.submit({ op: 'follow', args: null, target: { identityId: target.identityId } })
    expect(ticket.state).toBe('pending')
    const settledTicket = await settled(ticket.id)
    expect(settledTicket.state, JSON.stringify(settledTicket.error)).toBe('unconfirmed')
    expect(settledTicket.documents).toHaveLength(1)
    expect((await writes.check(ticket.id)).state).toBe('confirmed')
    await expect(writes.retry(ticket.id)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  })

  it('proves a delete with check', async () => {
    const ticket = store.submit({ op: 'unfollow', args: null, target: { identityId: target.identityId } })
    expect((await settled(ticket.id)).state).toBe('unconfirmed')
    expect((await writes.check(ticket.id)).state).toBe('confirmed')
  })
})
