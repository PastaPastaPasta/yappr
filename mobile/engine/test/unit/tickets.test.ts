import { describe, expect, it, vi } from 'vitest'
import { NotSentError, RESTARTED_ERROR, WRITES_STORAGE_KEY, createTicketStore, type TicketStoreOptions, type WriteHandler, type WriteResult } from '../../src/writes/tickets'
import type { TicketDocument, WriteTicket } from '../../src/writes/types'
import { fromBoolean, fromTransitionResult } from '../../src/writes/lib-results'

const POST: TicketDocument = { contractId: 'C', type: 'post', id: 'P1', action: 'create', confirmed: false }

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
  }
}

function setup(overrides: Partial<TicketStoreOptions> & { storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = overrides.storage ?? memoryStorage()
  const events: WriteTicket[] = []
  let clock = 1_000_000
  let ids = 0
  const options: TicketStoreOptions = {
    storage,
    emit: (_event, ticket) => { events.push(ticket) },
    currentIdentity: () => 'alice',
    documentExists: vi.fn(async () => true),
    now: () => clock,
    newId: () => `t${++ids}`,
    absenceRecheckMs: 0,
    ...overrides,
  }
  const store = createTicketStore(options)
  return { store, storage, events, options, advance: (ms: number) => { clock += ms } }
}

/** A handler whose run the test settles by hand. */
function controlled() {
  const runs: { args: unknown; resolve(result: WriteResult): void; reject(error: unknown): void }[] = []
  const handler: WriteHandler<unknown> = {
    run: (args) => new Promise((resolve, reject) => { runs.push({ args, resolve, reject }) }),
  }
  return { handler, runs }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('write tickets', () => {
  it('issues a pending ticket, then reports each transition', async () => {
    const { store, events } = setup()
    const { handler, runs } = controlled()
    store.register('bookmark', handler)
    const ticket = store.submit({ op: 'bookmark', args: { postId: 'P' }, target: { identityId: 'bob' } })
    expect(ticket).toMatchObject({ id: 't1', op: 'bookmark', identityId: 'alice', state: 'pending', stage: 'queued', retryable: false })
    await settle()
    expect(runs[0].args).toEqual({ postId: 'P' })
    runs[0].resolve({ state: 'confirmed', documents: [POST] })
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'confirmed', stage: null, error: null, documents: [{ ...POST, confirmed: true }] })
    expect(events.map(e => e.state)).toEqual(['pending', 'confirmed'])
  })

  it('reports stage, progress and documents as the handler learns them', async () => {
    const { store, events } = setup()
    store.register('post.publish', {
      async run(_args, ctx) {
        ctx.stage('signing')
        ctx.documents([POST])
        ctx.progress(1, 3)
        return { state: 'unconfirmed' }
      },
    })
    store.submit({ op: 'post.publish', args: {} })
    await settle()
    expect(events.map(e => [e.state, e.stage])).toEqual([
      ['pending', 'queued'], ['pending', 'signing'], ['pending', 'signing'], ['pending', 'signing'], ['unconfirmed', null],
    ])
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', progress: { done: 1, total: 3 }, documents: [POST] })
  })

  it('maps lib results: unconfirmed broadcasts, boolean services and thrown errors', async () => {
    expect(fromTransitionResult({ success: true })).toEqual({ state: 'confirmed', documents: undefined })
    expect(fromTransitionResult({ success: true, confirmed: false }).state).toBe('unconfirmed')
    expect(fromTransitionResult({ success: false, error: 'x' })).toMatchObject({ state: 'failed', error: new Error('x') })
    expect(fromBoolean(true).state).toBe('confirmed')
    expect(fromBoolean(false).state).toBe('failed')

    const { store } = setup()
    const errors: Record<string, unknown> = {
      like: new Error('wait_for_state_transition_result timed out'),
      unlike: new Error('Identity 9t2e does not have enough token balance, code=40700'),
      follow: new Error('Identity X is trying to set an invalid identity nonce. The current identity nonce is 1, we are setting 1, error is nonce already present at tip'),
    }
    for (const [op, error] of Object.entries(errors)) {
      store.register(op as 'like', { run: async () => { throw error } })
      store.submit({ op: op as 'like', args: null })
    }
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'TIMEOUT', outcome: 'unknown' } })
    expect(store.get('t2')).toMatchObject({ state: 'failed', retryable: false, error: { code: 'INSUFFICIENT_YAPP', outcome: 'refused' } })
    // A nonce refusal may be this very write landing first: check, never retry blind.
    expect(store.get('t3')).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'NONCE_CONFLICT', outcome: 'unknown' } })
  })

  it('asks for a key when a write fails without one', async () => {
    const onKeyRequired = vi.fn()
    const { store } = setup({ onKeyRequired })
    store.register('like', { run: async () => { throw new Error('Private key not found. Please log in again.') } })
    store.submit({ op: 'like', args: null })
    await settle()
    expect(store.get('t1')?.error?.code).toBe('NO_KEY')
    expect(onKeyRequired).toHaveBeenCalledWith('alice')
  })

  it('rejects an op nobody registered', () => {
    const { store } = setup()
    expect(() => store.submit({ op: 'report', args: null })).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }))
  })
})

describe('retry: never blindly', () => {
  it('refuses a pending ticket and a refusal that is final', async () => {
    const { store } = setup()
    const { handler, runs } = controlled()
    store.register('like', handler)
    store.submit({ op: 'like', args: 1 })
    await expect(store.retry('t1')).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
    await settle()
    runs[0].reject(new Error('referenced identity 9t2e not found for path followingId'))
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'failed', error: { code: 'TARGET_GONE' } })
    await expect(store.retry('t1')).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  })

  it('refuses an unconfirmed ticket that no check has proved absent', async () => {
    const { store } = setup()
    store.register('like', { run: async () => ({ state: 'unconfirmed' }) })
    store.submit({ op: 'like', args: 1 })
    await settle()
    await expect(store.retry('t1')).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  })

  it('re-runs a retryable refusal under the same ticket', async () => {
    const { store, events } = setup()
    const { handler, runs } = controlled()
    store.register('follow', handler)
    store.submit({ op: 'follow', args: { target: 'bob' } })
    await settle()
    runs[0].reject(new Error('An earlier change from this account has not been confirmed yet, so this was not sent. Check that it went through, then try again.'))
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'PENDING_WRITE', outcome: 'not-sent' } })
    const retried = await store.retry('t1')
    expect(retried).toMatchObject({ id: 't1', state: 'pending', stage: 'queued', error: null })
    await settle()
    expect(runs).toHaveLength(2)
    expect(runs[1].args).toEqual({ target: 'bob' })
    runs[1].resolve({ state: 'confirmed' })
    await settle()
    expect(store.get('t1')?.state).toBe('confirmed')
    expect(events.map(e => e.state)).toEqual(['pending', 'failed', 'pending', 'confirmed'])
  })
})

describe('safety', () => {
  it('treats a transport failure after the broadcast as unconfirmed, not as never sent', async () => {
    const { store } = setup()
    store.register('like', {
      async run(_args, ctx) {
        ctx.stage('broadcasting')
        throw new Error('no available addresses for retry')
      },
    })
    store.submit({ op: 'like', args: null })
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'NETWORK', outcome: 'unknown' } })
  })

  it('counts a transport failure during run() as maybe sent, unless the handler proves it was not', async () => {
    const { store } = setup()
    const network = () => new Error('no available addresses for retry')
    store.register('like', { async run() { throw network() } })
    store.register('unlike', { async run() { throw new NotSentError(network()) } })
    store.register('follow', { async run(_args, ctx) { ctx.stage('waiting-parent'); throw network() } })
    store.register('unfollow', { async run() { return { state: 'failed', error: new Error('Missing response message') } } })
    store.register('block', { async run() { throw new NotSentError(new Error('wait timed out')) } })
    for (const op of ['like', 'unlike', 'follow', 'unfollow', 'block'] as const) store.submit({ op, args: null })
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'NETWORK', outcome: 'unknown' } })
    expect(store.get('t2')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK', outcome: 'not-sent' } })
    expect(store.get('t3')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK', outcome: 'not-sent' } })
    expect(store.get('t4')).toMatchObject({ state: 'unconfirmed', error: { code: 'NETWORK', outcome: 'unknown' } })
    expect(store.get('t5')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'TIMEOUT', outcome: 'not-sent' } })
  })

  it('does not honour a not-sent claim once the ticket names an unconfirmed document', async () => {
    const { store } = setup()
    store.register('post.publish', {
      async run(_args, ctx) {
        // Part 1 of a thread went out unconfirmed; part 2 then waits for its parent.
        ctx.documents([POST])
        ctx.stage('waiting-parent')
        throw new Error('no available addresses for retry')
      },
    })
    store.register('like', {
      async run(_args, ctx) {
        ctx.documents([POST])
        throw new NotSentError(new Error('no available addresses for retry'))
      },
    })
    store.submit({ op: 'post.publish', args: {} })
    store.submit({ op: 'like', args: null })
    await settle()
    for (const id of ['t1', 't2']) {
      expect(store.get(id)).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'NETWORK', outcome: 'unknown', retryable: false } })
      await expect(store.retry(id)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
    }
  })

  it('acts only on the active account\'s tickets', async () => {
    let identity = 'alice'
    const { store } = setup({ currentIdentity: () => identity, documentExists: async () => false })
    store.register('like', { run: async () => ({ state: 'unconfirmed', documents: [POST] }) })
    store.submit({ op: 'like', args: null })
    await settle()
    await store.check('t1')
    identity = 'bob'
    expect(store.get('t1')).toBeNull()
    await expect(store.retry('t1')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(store.check('t1')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(store.dismiss('t1')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('drops the previous attempt\'s unproven documents on retry, so a later check proves the new attempt', async () => {
    let attempt = 0
    const exists = new Set<string>()
    const { store } = setup({ documentExists: async doc => exists.has(doc.id) })
    store.register('post.publish', { run: async () => ({ state: 'unconfirmed', documents: [{ ...POST, id: `P${++attempt}` }] }) })
    store.submit({ op: 'post.publish', args: {} })
    await settle()
    await store.check('t1')
    await store.retry('t1')
    await settle()
    expect(store.get('t1')?.documents.map(d => d.id)).toEqual(['P2'])
    exists.add('P2')
    expect((await store.check('t1')).state).toBe('confirmed')
  })

  it('ignores a probe answer that a retry overtook', async () => {
    let answer: (exists: boolean) => void = () => undefined
    let calls = 0
    const { store } = setup({ documentExists: () => (++calls <= 2 ? Promise.resolve(false) : new Promise(resolve => { answer = resolve })) })
    const { handler } = controlled()
    store.register('post.publish', { ...handler, run: async () => ({ state: 'unconfirmed', documents: [POST] }) })
    store.submit({ op: 'post.publish', args: {} })
    await settle()
    expect((await store.check('t1')).retryable).toBe(true)
    // A second check is still probing when the user retries.
    const checking = store.check('t1')
    store.register('post.publish', handler)
    await store.retry('t1')
    answer(true)
    expect((await checking).state).toBe('pending')
    expect(store.get('t1')?.state).toBe('pending')
  })
})

describe('check again', () => {
  async function unconfirmedCreate(documentExists: TicketStoreOptions['documentExists'], documents: TicketDocument[] = [POST]) {
    const ctx = setup({ documentExists })
    ctx.store.register('post.publish', { run: async () => ({ state: 'unconfirmed', documents }) })
    ctx.store.submit({ op: 'post.publish', args: { text: 'hi' } })
    await settle()
    return ctx
  }

  it('confirms a create once its document is proved present', async () => {
    const { store } = await unconfirmedCreate(async () => true)
    expect(await store.check('t1')).toMatchObject({ state: 'confirmed', error: null, documents: [{ id: 'P1', confirmed: true }] })
  })

  it('confirms a delete once its document is proved absent', async () => {
    const { store } = await unconfirmedCreate(async () => false, [{ ...POST, action: 'delete' }])
    expect((await store.check('t1')).state).toBe('confirmed')
  })

  it('keeps a create proved absent unconfirmed, and only then allows a retry', async () => {
    const { store } = await unconfirmedCreate(async () => false)
    const checked = await store.check('t1')
    expect(checked).toMatchObject({ state: 'unconfirmed', retryable: true, error: { code: 'NOT_RECORDED' } })
    expect(checked.lastCheckedAt).toBeInstanceOf(Date)
    expect((await store.retry('t1')).state).toBe('pending')
  })

  it('keeps it unconfirmed, with the probe error, when the probe cannot tell', async () => {
    const { store } = await unconfirmedCreate(async () => { throw new Error('no available addresses for retry') })
    expect(await store.check('t1')).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'NETWORK', retryable: false } })
    await expect(store.retry('t1')).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  })

  it('uses the handler\'s own probe (index-only likes)', async () => {
    const { store } = setup()
    store.register('like', {
      run: async () => ({ state: 'unconfirmed' }),
      probe: async (_ticket, args) => (args === 'liked' ? { state: 'applied' } : { state: 'not-applied' }),
    })
    store.submit({ op: 'like', args: 'liked' })
    await settle()
    expect((await store.check('t1')).state).toBe('confirmed')
  })

  it('lends handler probes the store\'s proof, which never proves an empty list', async () => {
    const { store, options } = setup()
    let named: TicketDocument[] = []
    store.register('unrepost', {
      run: async () => ({ state: 'unconfirmed' }),
      probe: (ticket, _args, kit) => kit.proveDocuments(named.length ? ticket.documents : []),
    })
    store.submit({ op: 'unrepost', args: null, documents: [{ ...POST, action: 'delete' }] })
    await settle()
    expect(await store.check('t1')).toMatchObject({ state: 'unconfirmed', error: { code: 'UNKNOWN' } })
    named = [POST]
    vi.mocked(options.documentExists).mockResolvedValue(false)
    expect((await store.check('t1')).state).toBe('confirmed')
  })

  it('keeps a delete\'s document across a retry, so the next check can still prove it', async () => {
    const { store } = await unconfirmedCreate(async () => true, [{ ...POST, action: 'delete' }])
    expect(await store.check('t1')).toMatchObject({ retryable: true })
    expect((await store.retry('t1')).documents).toEqual([{ ...POST, action: 'delete' }])
  })

  it('cannot prove a write that named no documents', async () => {
    const { store } = setup()
    store.register('like', { run: async () => ({ state: 'unconfirmed' }) })
    store.submit({ op: 'like', args: null })
    await settle()
    expect(await store.check('t1')).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'UNKNOWN' } })
  })
})

describe('persistence and restart reconciliation', () => {
  it('turns a ticket left pending into unconfirmed (ENGINE_RESTARTED), never re-sending it', async () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    const { handler } = controlled()
    first.store.register('post.publish', { ...handler, persistArgs: true })
    first.store.submit({ op: 'post.publish', args: { text: 'hi' }, documents: [POST] })
    await settle()

    const run = vi.fn()
    const restarted = setup({ storage, documentExists: async () => false })
    restarted.store.register('post.publish', { run, persistArgs: true })
    const ticket = restarted.store.get('t1')
    expect(ticket).toMatchObject({ state: 'unconfirmed', stage: null, retryable: false, error: RESTARTED_ERROR, documents: [POST] })
    // Reported to the host once the API exists.
    await settle()
    expect(restarted.events.map(e => [e.id, e.state])).toEqual([['t1', 'unconfirmed']])
    expect(ticket?.createdAt).toBeInstanceOf(Date)
    expect(run).not.toHaveBeenCalled()
    // The reconciliation is persisted at once, so a second crash finds it settled.
    expect(JSON.parse(storage.items.get(WRITES_STORAGE_KEY) ?? '[]')[0].ticket.state).toBe('unconfirmed')

    // Check, prove absent, then retry with the persisted arguments.
    await restarted.store.check('t1')
    await restarted.store.retry('t1')
    await settle()
    expect(run).toHaveBeenCalledWith({ text: 'hi' }, expect.anything())
  })

  it('reports reconciled tickets of the active account only', async () => {
    const storage = memoryStorage()
    let identity = 'alice'
    const first = setup({ storage, currentIdentity: () => identity })
    first.store.register('like', controlled().handler)
    first.store.submit({ op: 'like', args: null })
    identity = 'bob'
    first.store.submit({ op: 'like', args: null })
    await settle()
    const restarted = setup({ storage, currentIdentity: () => 'bob' })
    await settle()
    expect(restarted.events.map(e => [e.id, e.identityId])).toEqual([['t2', 'bob']])
  })

  it('refuses everything once an account switch requires a restart', async () => {
    const { store } = setup()
    store.register('like', { run: async () => ({ state: 'confirmed' }) })
    store.requireRestart()
    expect(() => store.submit({ op: 'like', args: null })).toThrow(expect.objectContaining({ code: 'RESTART_REQUIRED' }))
    expect(() => store.list()).toThrow(expect.objectContaining({ code: 'RESTART_REQUIRED' }))
  })

  it('never persists arguments unless the handler opts in, so those cannot be retried after a restart', async () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    first.store.register('dm.send', { run: async () => ({ state: 'unconfirmed', documents: [POST] }) })
    first.store.submit({ op: 'dm.send', args: { text: 'secret plaintext' } })
    await settle()
    expect(storage.items.get(WRITES_STORAGE_KEY)).not.toContain('secret plaintext')

    const restarted = setup({ storage, documentExists: async () => false })
    restarted.store.register('dm.send', { run: async () => ({ state: 'confirmed' }) })
    expect((await restarted.store.check('t1')).retryable).toBe(true)
    await expect(restarted.store.retry('t1')).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  })

  it('keeps stored arguments through the boot-time rewrite, before any handler registers', async () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    first.store.register('follow', { run: async () => ({ state: 'unconfirmed' }), persistArgs: true })
    first.store.submit({ op: 'follow', args: { targetId: 'B' }, documents: [POST] })
    await settle()
    // Two restarts with nothing registered in between: the arguments survive both.
    setup({ storage })
    const run = vi.fn(async () => ({ state: 'confirmed' as const }))
    const second = setup({ storage, documentExists: async () => false })
    second.store.register('follow', { run, persistArgs: true })
    await second.store.check('t1')
    await second.store.retry('t1')
    await settle()
    expect(run).toHaveBeenCalledWith({ targetId: 'B' }, expect.anything())
  })

  it('lists the active account\'s open tickets and recent confirmations, newest first', async () => {
    let identity = 'alice'
    const { store, advance } = setup({ currentIdentity: () => identity })
    store.register('like', { run: async () => ({ state: 'confirmed' }) })
    store.register('unlike', { run: async () => ({ state: 'unconfirmed' }) })
    store.submit({ op: 'like', args: null })
    advance(1)
    store.submit({ op: 'unlike', args: null })
    await settle()
    expect(store.list().map(t => t.id)).toEqual(['t2', 't1'])
    advance(11 * 60 * 1000)
    expect(store.list().map(t => t.id)).toEqual(['t2'])
    identity = 'bob'
    expect(store.list()).toEqual([])
  })

  it('dismisses settled tickets only, and forgets an identity\'s tickets on sign-out', async () => {
    const { store } = setup()
    const { handler } = controlled()
    store.register('like', handler)
    store.register('unlike', { run: async () => ({ state: 'unconfirmed' }) })
    store.submit({ op: 'like', args: null })
    store.submit({ op: 'unlike', args: null })
    await settle()
    await expect(store.dismiss('t1')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await store.dismiss('t2')
    expect(store.get('t2')).toBeNull()
    store.submit({ op: 'unlike', args: null })
    await settle()
    store.forgetIdentity('alice')
    expect(store.get('t3')).toBeNull()
    expect(store.get('t1')?.state).toBe('pending')
  })

  it('prunes confirmed tickets after a day and caps the store at 100', async () => {
    const storage = memoryStorage()
    const { store, advance } = setup({ storage })
    store.register('like', { run: async () => ({ state: 'confirmed' }) })
    store.register('unlike', { run: async () => ({ state: 'unconfirmed' }) })
    store.submit({ op: 'like', args: null })
    await settle()
    advance(25 * 60 * 60 * 1000)
    for (let i = 0; i < 105; i++) store.submit({ op: 'unlike', args: null })
    await settle()
    const stored = JSON.parse(storage.items.get(WRITES_STORAGE_KEY) ?? '[]') as { ticket: { id: string } }[]
    expect(stored).toHaveLength(100)
    expect(stored.some(r => r.ticket.id === 't1')).toBe(false)
  })

  it('survives a corrupt store', () => {
    const storage = memoryStorage()
    storage.setItem(WRITES_STORAGE_KEY, '{not json')
    expect(setup({ storage }).store.list()).toEqual([])
    storage.setItem(WRITES_STORAGE_KEY, '[null, {"args": 1}, 7]')
    expect(setup({ storage }).store.list()).toEqual([])
  })
})
