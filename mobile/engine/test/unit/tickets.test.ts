import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTO_RETRY_CODES, NotSentError, PENDING_DEADLINE_MS, RESTARTED_ERROR, RESTARTED_UNSENT_ERROR, STILL_SENDING_ERROR, WRITES_STORAGE_KEY, createTicketStore, type TicketStoreOptions, type WriteHandler, type WriteResult } from '../../src/writes/tickets'
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

  it('starts a retry with no progress: the earlier attempt\'s "2 of 2" is not this one\'s', async () => {
    const { store } = setup()
    const runs: { ctx: Parameters<WriteHandler['run']>[1]; reject(error: unknown): void }[] = []
    store.register('profile.update', {
      run: (_args, ctx) => new Promise((_resolve, reject) => { runs.push({ ctx, reject }) }),
    })
    store.submit({ op: 'profile.update', args: {} })
    await settle()
    runs[0].ctx.progress(1, 2)
    runs[0].reject(new Error('An earlier change from this account has not been confirmed yet, so this was not sent. Check that it went through, then try again.'))
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'failed', retryable: true, progress: { done: 1, total: 2 } })
    expect((await store.retry('t1')).progress).toBeNull()
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

  it('ends any failure without a verdict after run() started as unconfirmed: never failed, never retryable', async () => {
    const { store } = setup()
    const fetchFailed = 'transport error: grpc error: code: \'Internal error\', message: "Failed to call gRPC service: JS API error: TypeError: Failed to fetch"'
    const failures: [op: 'like' | 'unlike' | 'follow' | 'unfollow' | 'block' | 'unblock', error: unknown][] = [
      ['like', new Error(fetchFailed)],
      ['unlike', new Error(fetchFailed.replace('Failed to fetch', 'Load failed'))],
      ['follow', new Error('something unexpected happened')],
      ['unfollow', 'a bare string'],
      ['block', new Error('no available addresses to retry, last error: rate limited')],
    ]
    for (const [op, error] of failures) {
      store.register(op, { async run(_args, ctx) { ctx.stage('broadcasting'); throw error } })
      store.submit({ op, args: null })
    }
    // A result-shaped failure (lib's { success: false }) counts the same.
    store.register('unblock', { async run() { return { state: 'failed', error: new Error(fetchFailed) } } })
    store.submit({ op: 'unblock', args: null })
    await settle()
    for (const id of ['t1', 't2', 't3', 't4', 't5', 't6']) {
      expect(store.get(id)).toMatchObject({ state: 'unconfirmed', retryable: false, error: { outcome: 'unknown', retryable: false } })
      await expect(store.retry(id)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
    }
    expect(store.get('t1')?.error?.code).toBe('NETWORK')
    expect(store.get('t3')?.error?.code).toBe('UNKNOWN')
  })

  it('still fails a write on a verdict: a consensus refusal, a proved absence, lib\'s pre-signing errors, the engine\'s own', async () => {
    const { store } = setup()
    const verdicts: [op: 'like' | 'unlike' | 'follow' | 'unfollow' | 'block', error: unknown, code: string][] = [
      ['like', { name: 'Protocol', message: 'Failed to broadcast: Protocol error: invalid revision', code: 40106 }, 'UNKNOWN'],
      ['unlike', new Error('This was not saved: the network used its place without recording it. Check, then try again.'), 'NOT_RECORDED'],
      ['follow', new Error('An earlier change from this account has not been confirmed yet, so this was not sent. Check that it went through, then try again.'), 'PENDING_WRITE'],
      ['unfollow', new Error('Private key not found. Please log in again.'), 'NO_KEY'],
      ['block', Object.assign(new Error('The post you replied to is not confirmed yet'), { code: 'PARENT_UNCONFIRMED' }), 'PARENT_UNCONFIRMED'],
    ]
    for (const [op, error] of verdicts) {
      store.register(op, { async run(_args, ctx) { ctx.stage('broadcasting'); throw error } })
      store.submit({ op, args: null })
    }
    await settle()
    verdicts.forEach(([, , code], i) => {
      expect(store.get(`t${i + 1}`)).toMatchObject({ state: 'failed', error: { code } })
    })
  })

  it('a transport failure the handler proves unsent stays failed and retryable; waiting-parent proves only that', async () => {
    const { store } = setup()
    store.register('like', { async run() { throw new NotSentError(new Error('transport error: grpc error: Failed to fetch')) } })
    store.register('unlike', { async run(_args, ctx) { ctx.stage('waiting-parent'); throw new Error('something unexpected happened') } })
    store.submit({ op: 'like', args: null })
    store.submit({ op: 'unlike', args: null })
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK', outcome: 'not-sent' } })
    // 'waiting-parent' proves a transport failure unsent, but not an error with no verdict: it stays a maybe.
    expect(store.get('t2')).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'UNKNOWN', outcome: 'unknown' } })
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

  it('fails a write a restart caught still queued, retryably, when its handler stages its sends (D-L1i-005)', async () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    // Never reaches a stage: the engine dies before the handler's first send.
    first.store.register('post.publish', { run: () => new Promise(() => undefined), persistArgs: true, stagedSends: true })
    first.store.submit({ op: 'post.publish', args: { text: 'hi' } })
    await settle()

    const run = vi.fn(async (_args: unknown, ctx: { stage(stage: 'broadcasting'): void }) => {
      ctx.stage('broadcasting')
      return new Promise<WriteResult>(() => undefined)
    })
    const restarted = setup({ storage })
    restarted.store.register('post.publish', { run, persistArgs: true, stagedSends: true })
    expect(restarted.store.get('t1')).toMatchObject({ state: 'failed', stage: null, retryable: true, error: RESTARTED_UNSENT_ERROR })
    await settle()
    expect(restarted.events.map(e => [e.id, e.state])).toEqual([['t1', 'failed']])
    expect(run).not.toHaveBeenCalled()

    // Retried, it staged a send this time: the next restart can no longer prove it unsent.
    await restarted.store.retry('t1')
    await settle()
    expect(run).toHaveBeenCalledWith({ text: 'hi' }, expect.anything())
    const third = setup({ storage })
    third.store.register('post.publish', { run, persistArgs: true, stagedSends: true })
    expect(third.store.get('t1')).toMatchObject({ state: 'unconfirmed', retryable: false, error: RESTARTED_ERROR })
  })

  it('never reads a queued ticket as unsent without the handler\'s word, nor with an unproved document', async () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    first.store.register('like', { run: () => new Promise(() => undefined), persistArgs: true })
    first.store.register('post.publish', { run: () => new Promise(() => undefined), persistArgs: true, stagedSends: true })
    first.store.submit({ op: 'like', args: null })
    first.store.submit({ op: 'post.publish', args: {}, documents: [POST] })
    await settle()
    const restarted = setup({ storage })
    expect(restarted.store.get('t1')).toMatchObject({ state: 'unconfirmed', error: RESTARTED_ERROR })
    expect(restarted.store.get('t2')).toMatchObject({ state: 'unconfirmed', error: RESTARTED_ERROR })
  })

  it('lends probes the time since the attempt stopped, and records the documents a probe found', async () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    first.store.register('post.publish', { run: () => new Promise(() => undefined), persistArgs: true })
    first.store.submit({ op: 'post.publish', args: {} })
    await settle()

    const seen: (number | null)[] = []
    let found = false
    const restarted = setup({ storage })
    restarted.store.register('post.publish', {
      run: () => new Promise(() => undefined),
      persistArgs: true,
      probe: async (_ticket, _args, kit) => {
        seen.push(kit.sinceSettled())
        return found ? { state: 'applied', documents: [POST] } : { state: 'unknown', error: new Error('not yet'), documents: [] }
      },
    })
    await restarted.store.check('t1')
    restarted.advance(90_000)
    await restarted.store.check('t1')
    // Counted from the restart that cut it short, not from each check.
    expect(seen).toEqual([0, 90_000])
    found = true
    expect(await restarted.store.check('t1')).toMatchObject({ state: 'confirmed', documents: [{ ...POST, confirmed: true }] })
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

  it('rewrites storage at boot only once the API has registered its handlers, and fails closed', async () => {
    const storage = memoryStorage()
    const storedArgs = () => JSON.parse(storage.items.get(WRITES_STORAGE_KEY) ?? '[]').map((record: { args?: unknown }) => record.args)
    const first = setup({ storage })
    first.store.register('follow', { run: async () => ({ state: 'unconfirmed' }), persistArgs: true })
    first.store.register('dm.send', { run: async () => ({ state: 'unconfirmed' }), persistArgs: true })
    first.store.submit({ op: 'follow', args: { targetId: 'B' }, documents: [POST] })
    first.store.submit({ op: 'dm.send', args: { text: 'secret' } })
    await settle()
    // A DM's arguments never reach disk, whatever its handler says.
    expect(storedArgs()).toEqual([{ targetId: 'B' }, undefined])

    // A restart that registers the handler synchronously keeps the follow's arguments.
    const second = setup({ storage })
    second.store.register('follow', { run: async () => ({ state: 'confirmed' }), persistArgs: true })
    await settle()
    expect(storedArgs()).toEqual([{ targetId: 'B' }, undefined])

    // An op no handler claims loses them: fail closed.
    setup({ storage })
    await settle()
    expect(storedArgs()).toEqual([undefined, undefined])
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

describe('a write whose call never answers (PRD G-3; QA D-L2a-007, D-L4a-002)', () => {
  afterEach(() => { vi.useRealTimers() })
  /** Lets promise chains settle, and fake time pass. */
  const pass = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

  it('reads unconfirmed (STILL_SENDING) a minute after its last word, and its late answer still settles it', async () => {
    vi.useFakeTimers()
    const { store, events } = setup()
    const { handler, runs } = controlled()
    store.register('post.publish', handler)
    store.submit({ op: 'post.publish', args: {} })
    await pass(PENDING_DEADLINE_MS - 1)
    expect(store.get('t1')?.state).toBe('pending')
    await pass(1)
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', stage: null, retryable: false, error: STILL_SENDING_ERROR })
    // Never re-sent, never retryable while the call runs.
    expect(runs).toHaveLength(1)
    await expect(store.retry('t1')).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })

    // The stall clears: the call's answer settles the ticket.
    runs[0].resolve({ state: 'confirmed', documents: [POST] })
    await pass()
    expect(store.get('t1')).toMatchObject({ state: 'confirmed', error: null, documents: [{ ...POST, confirmed: true }] })
    expect(events.map(e => e.state)).toEqual(['pending', 'unconfirmed', 'confirmed'])
  })

  it('counts the minute from the attempt\'s last stage, progress or document, so a long thread is not cut short', async () => {
    vi.useFakeTimers()
    const { store } = setup()
    let ctx: Parameters<WriteHandler['run']>[1] | undefined
    store.register('post.publish', { run: (_args, c) => { ctx = c; return new Promise(() => undefined) } })
    store.submit({ op: 'post.publish', args: {} })
    await pass(50_000)
    ctx?.progress(1, 3)
    await pass(50_000)
    ctx?.documents([POST])
    await pass(50_000)
    expect(store.get('t1')?.state).toBe('pending')
    await pass(10_000)
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', error: STILL_SENDING_ERROR, documents: [POST] })
    // A later report is kept, and the ticket stays unconfirmed: no flip back to "Posting…".
    ctx?.progress(2, 3)
    await pass(PENDING_DEADLINE_MS)
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', stage: null, progress: { done: 2, total: 3 } })
  })

  it('a check while the call still runs proves only a landing: never absent, never retryable', async () => {
    vi.useFakeTimers()
    const documentExists = vi.fn(async () => false)
    const { store, advance } = setup({ documentExists })
    const seen: (number | null)[] = []
    const { handler, runs } = controlled()
    store.register('post.publish', {
      ...handler,
      probe: async (ticket, _args, kit) => {
        seen.push(kit.sinceSettled())
        return kit.proveDocuments(ticket.documents)
      },
    })
    store.submit({ op: 'post.publish', args: {}, documents: [POST] })
    await pass(PENDING_DEADLINE_MS)
    advance(5 * 60_000)
    const checked = store.check('t1')
    await pass()
    expect(await checked).toMatchObject({ state: 'unconfirmed', retryable: false, error: STILL_SENDING_ERROR })
    expect(documentExists).toHaveBeenCalledTimes(2)
    // Still running, however long since it was sent: nothing of it has stopped.
    expect(seen).toEqual([null])
    await expect(store.retry('t1')).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })

    // The call ends in a transport failure: from then on, an absence proves it never landed.
    runs[0].reject(new Error('Failed to fetch'))
    await pass()
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', retryable: false })
    advance(1000)
    const again = store.check('t1')
    await pass()
    expect(await again).toMatchObject({ state: 'unconfirmed', retryable: true, error: { code: 'NOT_RECORDED' } })
    expect(seen).toEqual([null, 1000])
  })

  it('a check that finds it landed has the last word over the call\'s late answer', async () => {
    vi.useFakeTimers()
    const { store, events } = setup({ documentExists: vi.fn(async () => true) })
    const { handler, runs } = controlled()
    store.register('post.publish', handler)
    store.submit({ op: 'post.publish', args: {}, documents: [POST] })
    await pass(PENDING_DEADLINE_MS)
    expect(await store.check('t1')).toMatchObject({ state: 'confirmed' })
    runs[0].reject(new Error('Failed to fetch'))
    await pass()
    expect(store.get('t1')).toMatchObject({ state: 'confirmed', error: null })
    expect(events.map(e => e.state)).toEqual(['pending', 'unconfirmed', 'confirmed'])
  })

  it('a restart cuts the running call short like any pending one: unconfirmed, or failed when it sent nothing', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const first = setup({ storage })
    first.store.register('like', { run: () => new Promise(() => undefined), persistArgs: true })
    first.store.register('post.publish', { run: () => new Promise(() => undefined), persistArgs: true, stagedSends: true })
    first.store.submit({ op: 'like', args: null })
    first.store.submit({ op: 'post.publish', args: {} })
    await pass(PENDING_DEADLINE_MS)
    expect(first.store.get('t1')?.error).toEqual(STILL_SENDING_ERROR)
    expect(first.store.get('t2')?.error).toEqual(STILL_SENDING_ERROR)

    const restarted = setup({ storage })
    restarted.store.register('like', { run: vi.fn(), persistArgs: true })
    restarted.store.register('post.publish', { run: vi.fn(), persistArgs: true, stagedSends: true })
    expect(restarted.store.get('t1')).toMatchObject({ state: 'unconfirmed', retryable: false, error: RESTARTED_ERROR })
    // Its handler never reached a stage: nothing went out.
    expect(restarted.store.get('t2')).toMatchObject({ state: 'failed', retryable: true, error: RESTARTED_UNSENT_ERROR })
    await pass()
    expect(restarted.events.map(e => [e.id, e.state])).toEqual([['t1', 'unconfirmed'], ['t2', 'failed']])
  })

  it('a wait for the parent that fails after the minute still proves nothing was sent: failed, and retryable', async () => {
    vi.useFakeTimers()
    const { store } = setup()
    let ctx: Parameters<WriteHandler['run']>[1] | undefined
    let reject: (error: unknown) => void = () => undefined
    store.register('like', {
      run: (_args, c) => {
        ctx = c
        return new Promise((_resolve, no) => { reject = no })
      },
      persistArgs: true,
    })
    store.submit({ op: 'like', args: null })
    await pass()
    ctx?.stage('waiting-parent')
    await pass(PENDING_DEADLINE_MS)
    expect(store.get('t1')).toMatchObject({ state: 'unconfirmed', stage: null, error: STILL_SENDING_ERROR })
    reject(new Error('transport error: grpc error: Failed to fetch'))
    await pass()
    expect(store.get('t1')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK', outcome: 'not-sent' } })
  })

  it('reports a settled answer even when recording it threw, never leaving it pending', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    let broken = false
    const { store, events } = setup({
      storage: {
        ...storage,
        setItem: (key: string, value: string) => {
          if (broken) {
            broken = false
            throw new Error('MMKV write failed')
          }
          storage.setItem(key, value)
        },
      },
    })
    const { handler, runs } = controlled()
    store.register('post.publish', handler)
    store.submit({ op: 'post.publish', args: {}, documents: [POST] })
    await pass()
    broken = true
    runs[0].resolve({ state: 'confirmed' })
    await pass()
    expect(store.get('t1')).toMatchObject({ state: 'confirmed' })
    expect(events.map(e => e.state)).toEqual(['pending', 'confirmed'])
    expect(JSON.parse(storage.getItem(WRITES_STORAGE_KEY) ?? '[]')[0].ticket.state).toBe('confirmed')
  })

  it('a handler may wait longer, or not at all', async () => {
    vi.useFakeTimers()
    const { store } = setup()
    store.register('dm.group', { run: () => new Promise(() => undefined), deadlineMs: 5 * 60_000 })
    store.register('profile.update', { run: () => new Promise(() => undefined), deadlineMs: null })
    store.submit({ op: 'dm.group', args: null })
    store.submit({ op: 'profile.update', args: null })
    await pass(5 * 60_000 - 1)
    expect(store.get('t1')?.state).toBe('pending')
    await pass(1)
    expect(store.get('t1')?.state).toBe('unconfirmed')
    await pass(60 * 60_000)
    expect(store.get('t2')?.state).toBe('pending')
  })
})

describe('silent re-sends of a passing refusal (UX_SPEC §5.4)', () => {
  /** Platform's refusal when the fee multiplier moved past the agreed tolerance (`FEE_CHANGED`). */
  const FEE_MOVED = () => new Error('Document create of type post agreed to an action fee priced with a fee multiplier of 1000 permille and at most 10% more, but the fee multiplier is 1500 permille')

  it('re-sends only passing refusals, never one that may have landed or one lib holds for minutes', () => {
    expect([...AUTO_RETRY_CODES].sort()).toEqual(['FEE_CHANGED', 'FEE_SHARE_MISMATCH', 'PARENT_TOO_YOUNG'])
  })

  it('keeps the ticket pending while it sends again, and reports the last refusal once the re-sends ran out', async () => {
    const { store, events } = setup({ autoRetryDelaysMs: [0, 0] })
    const { handler, runs } = controlled()
    store.register('like', handler)
    store.submit({ op: 'like', args: { postId: 'P' } })
    await settle()
    runs[0].reject(FEE_MOVED())
    await settle()
    await settle()
    // Sent again, the host never told.
    expect(runs).toHaveLength(2)
    expect(store.get('t1')).toMatchObject({ state: 'pending' })
    expect(events.some(e => e.state === 'failed')).toBe(false)
    runs[1].reject(FEE_MOVED())
    await settle()
    await settle()
    runs[2].reject(FEE_MOVED())
    await settle()
    expect(runs).toHaveLength(3)
    expect(store.get('t1')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'FEE_CHANGED' } })

    // The host's own Retry starts the silent re-sends again.
    await store.retry('t1')
    await settle()
    runs[3].reject(FEE_MOVED())
    await settle()
    await settle()
    expect(runs).toHaveLength(5)
    runs[4].resolve({ state: 'confirmed' })
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'confirmed' })
  })

  it('finds a write a restart caught in its wait unsent: failed and retryable, never "may have landed"', async () => {
    const storage = memoryStorage()
    // A wait the test never lets end.
    const { store } = setup({ storage, autoRetryDelaysMs: [60 * 60_000] })
    const { handler, runs } = controlled()
    store.register('like', handler)
    store.submit({ op: 'like', args: { postId: 'P' } })
    await settle()
    runs[0].reject(FEE_MOVED())
    await settle()
    expect(store.get('t1')).toMatchObject({ state: 'pending', stage: 'queued' })

    const next = setup({ storage })
    next.store.register('like', { ...handler, persistArgs: true })
    expect(next.store.get('t1')).toMatchObject({ state: 'failed', error: RESTARTED_UNSENT_ERROR })
  })

  it('sends nothing for an account that is switching away during the wait: reported as refused', async () => {
    let identity = 'alice'
    const { store } = setup({ autoRetryDelaysMs: [0], currentIdentity: () => identity })
    const { handler, runs } = controlled()
    store.register('like', handler)
    store.submit({ op: 'like', args: { postId: 'P' } })
    await settle()
    identity = 'bob'
    runs[0].reject(FEE_MOVED())
    await settle()
    await settle()
    expect(runs).toHaveLength(1)
    identity = 'alice'
    expect(store.get('t1')).toMatchObject({ state: 'failed', retryable: true, error: { code: 'FEE_CHANGED' } })
  })

  it('never re-sends a thread with a part out but not seen confirmed', async () => {
    const { store } = setup({ autoRetryDelaysMs: [0] })
    const { handler, runs } = controlled()
    store.register('post.publish', handler)
    store.submit({ op: 'post.publish', args: {} })
    await settle()
    runs[0].resolve({ state: 'failed', error: FEE_MOVED(), documents: [{ ...POST, part: 0 }] })
    await settle()
    await settle()
    expect(runs).toHaveLength(1)
    expect(store.get('t1')).toMatchObject({ state: 'failed', error: { code: 'FEE_CHANGED' } })
  })
})
