import { describe, expect, it } from 'vitest'
import {
  SECURE_KEY_PREFIXES,
  createEngineStorage,
  installEngineStorage,
  isSecureStorageKey,
  takeInjectedSnapshot,
  type EngineStorage,
  type SnapshotInjectionTarget,
  type StorageBatch,
} from '../../src/shims/storage'
import { dispatchConnectivity, dispatchLifecycle, installVisibilityOverride } from '../../src/shims/lifecycle'

function recordBatches(storage: EngineStorage): StorageBatch[] {
  const batches: StorageBatch[] = []
  storage.onBatch(batch => batches.push(batch))
  return batches
}

/** Let the write-through microtask run. */
const flushed = () => Promise.resolve()

describe('engine storage', () => {
  it('is synchronous Web Storage and writes through one coalesced batch per microtask', async () => {
    const storage = createEngineStorage()
    const batches = recordBatches(storage)
    const { localStorage } = storage
    localStorage.setItem('yappr_session', '{"user":1}')
    expect(localStorage.getItem('yappr_session')).toBe('{"user":1}')
    localStorage.setItem('yappr_session', '{"user":2}')
    localStorage.setItem('gone', 'x')
    localStorage.removeItem('gone')
    localStorage.removeItem('never-set')
    expect(batches).toEqual([])
    await flushed()
    expect(batches).toEqual([{ area: 'local', seq: 1, ops: [['set', 'yappr_session', '{"user":2}']] }])
  })

  it('holds back the secure writes a hold picks: a commit sends them, a discard drops and undoes them', async () => {
    const storage = createEngineStorage()
    storage.hydrate({ secure: { yappr_secure_ek_bob: 'bob-ek' } })
    const batches = recordBatches(storage)
    const { localStorage } = storage

    // A failed sign-in: it stores a key, then clears every key of the identity by name.
    let hold = storage.holdSecure(key => key.endsWith('_alice'))
    expect(() => storage.holdSecure(() => true)).toThrow()
    localStorage.setItem('yappr_secure_lk_alice', 'new')
    await flushed()
    localStorage.removeItem('yappr_secure_lk_alice')
    localStorage.removeItem('yappr_secure_pk_alice')
    localStorage.removeItem('yappr_secure_ek_alice')
    localStorage.removeItem('yappr_secure_ek_bob') // not held
    await flushed()
    hold.release(false)
    await flushed()
    expect(batches).toEqual([{ area: 'secure', seq: 1, ops: [['del', 'yappr_secure_ek_bob']] }])
    expect(localStorage.getItem('yappr_secure_lk_alice')).toBeNull()

    // A successful one: its writes go out as if never held.
    batches.length = 0
    hold = storage.holdSecure(key => key.endsWith('_alice'))
    localStorage.setItem('yappr_secure_pk_alice', 'pk')
    localStorage.removeItem('yappr_secure_ek_alice')
    await flushed()
    expect(batches).toEqual([])
    hold.release(true)
    hold.release(false) // released once only
    await flushed()
    expect(batches).toEqual([{ area: 'secure', seq: 2, ops: [['set', 'yappr_secure_pk_alice', 'pk'], ['del', 'yappr_secure_ek_alice']] }])
    expect(localStorage.getItem('yappr_secure_pk_alice')).toBe('pk')
  })

  it('drops the secret store\'s availability probe and sets that change nothing', async () => {
    const storage = createEngineStorage()
    storage.hydrate({ local: { a: '1' } })
    const batches = recordBatches(storage)
    storage.localStorage.setItem('__storage_test__', '__storage_test__')
    storage.localStorage.removeItem('__storage_test__')
    storage.localStorage.setItem('a', '2')
    storage.localStorage.setItem('a', '1')
    await flushed()
    expect(batches).toEqual([])
  })

  it('routes private keys, private-feed keys and upload credentials to the secure area', async () => {
    expect(SECURE_KEY_PREFIXES).toEqual(['yappr_secure_', 'yappr:pf:', 'yappr_pinata_', 'yappr_storacha_'])
    for (const key of ['yappr_secure_pk_abc', 'yappr:pf:feed_seed', 'yappr:pf:path_keys:1', 'yappr_pinata_jwt', 'yappr_storacha_agent']) {
      expect(isSecureStorageKey(key), key).toBe(true)
    }
    for (const key of ['yappr_session', 'yappr-settings', 'pf:feed_seed', 'x_yappr_secure_']) {
      expect(isSecureStorageKey(key), key).toBe(false)
    }

    const storage = createEngineStorage()
    const batches = recordBatches(storage)
    storage.localStorage.setItem('yappr:pf:feed_seed', 'seed')
    storage.localStorage.setItem('plain', 'x')
    expect(storage.localStorage.getItem('yappr:pf:feed_seed')).toBe('seed')
    expect(storage.snapshot()).toEqual({ local: { plain: 'x' }, secure: { 'yappr:pf:feed_seed': 'seed' } })
    await flushed()
    expect(batches).toEqual([
      { area: 'local', seq: 1, ops: [['set', 'plain', 'x']] },
      { area: 'secure', seq: 2, ops: [['set', 'yappr:pf:feed_seed', 'seed']] },
    ])
  })

  it('always forwards a secure removal, even of a key the engine does not hold', async () => {
    const storage = createEngineStorage()
    const batches = recordBatches(storage)
    // Signing out an account whose secrets were never hydrated into this engine.
    storage.localStorage.removeItem('yappr_secure_pk_otherAccount')
    storage.localStorage.removeItem('plain-never-set')
    await flushed()
    expect(batches).toEqual([{ area: 'secure', seq: 1, ops: [['del', 'yappr_secure_pk_otherAccount']] }])
  })

  it('reports clear() as removals, and keeps seq increasing across batches', async () => {
    const storage = createEngineStorage()
    storage.hydrate({ local: { a: '1' }, secure: { yappr_secure_b: '2' } })
    const batches = recordBatches(storage)
    storage.localStorage.clear()
    await flushed()
    storage.localStorage.setItem('c', '3')
    await flushed()
    expect(batches).toEqual([
      { area: 'local', seq: 1, ops: [['del', 'a']] },
      { area: 'secure', seq: 2, ops: [['del', 'yappr_secure_b']] },
      { area: 'local', seq: 3, ops: [['set', 'c', '3']] },
    ])
  })

  it('enumerates both areas through key() and length, and follows additions and removals', () => {
    const storage = createEngineStorage()
    storage.hydrate({ local: { a: '1' }, secure: { yappr_secure_b: '2' } })
    const { localStorage } = storage
    expect(localStorage.length).toBe(2)
    expect([localStorage.key(0), localStorage.key(1), localStorage.key(2)]).toEqual(['a', 'yappr_secure_b', null])
    localStorage.setItem('c', '3')
    localStorage.removeItem('a')
    expect([localStorage.key(0), localStorage.key(1)]).toEqual(['c', 'yappr_secure_b'])
  })

  it('hydrates without writing through, routing each key by prefix and reporting misfiled ones', async () => {
    const storage = createEngineStorage()
    const batches = recordBatches(storage)
    storage.localStorage.setItem('old', '1')
    await flushed()
    batches.length = 0
    const { misrouted } = storage.hydrate({ local: { fresh: '2', yappr_secure_pk_x: 'wif' }, secure: { 'plain-in-secure': 'p' } })
    await flushed()
    expect(batches).toEqual([])
    expect(misrouted.sort()).toEqual(['plain-in-secure', 'yappr_secure_pk_x'])
    expect(storage.localStorage.getItem('old')).toBeNull()
    expect(storage.localStorage.getItem('yappr_secure_pk_x')).toBe('wif')
    expect(storage.snapshot()).toEqual({ local: { fresh: '2', 'plain-in-secure': 'p' }, secure: { yappr_secure_pk_x: 'wif' } })
    expect(storage.localStorage.length).toBe(3)
  })

  it('queues batches flushed before anyone subscribes and hands them to the first subscriber', async () => {
    const storage = createEngineStorage()
    storage.localStorage.setItem('written-while-lib-loads', '1')
    await flushed()
    const first = recordBatches(storage)
    const second = recordBatches(storage)
    storage.localStorage.setItem('later', '2')
    await flushed()
    expect(first).toEqual([
      { area: 'local', seq: 1, ops: [['set', 'written-while-lib-loads', '1']] },
      { area: 'local', seq: 2, ops: [['set', 'later', '2']] },
    ])
    expect(second).toEqual([{ area: 'local', seq: 2, ops: [['set', 'later', '2']] }])
  })

  it('resolves secureDurable once every secure batch is acknowledged, flushing pending writes first', async () => {
    const storage = createEngineStorage()
    const batches = recordBatches(storage)
    await expect(storage.secureDurable()).resolves.toBeUndefined()

    storage.localStorage.setItem('yappr_secure_pk_a', 'wif-a')
    let durable = false
    const waiting = storage.secureDurable().then(() => { durable = true })
    // secureDurable flushed synchronously.
    expect(batches).toEqual([{ area: 'secure', seq: 1, ops: [['set', 'yappr_secure_pk_a', 'wif-a']] }])
    storage.localStorage.setItem('plain', 'x')
    await flushed()
    expect(durable).toBe(false)
    storage.ack(2) // a seq it was not waiting for
    await flushed()
    expect(durable).toBe(false)
    storage.ack(1)
    await waiting
    expect(durable).toBe(true)
  })

  it('keeps sessionStorage in memory only', async () => {
    const storage = createEngineStorage()
    const batches = recordBatches(storage)
    storage.sessionStorage.setItem('s', '1')
    expect(storage.sessionStorage.getItem('s')).toBe('1')
    await flushed()
    expect(batches).toEqual([])
  })

  it('coerces keys and values to strings, as Web Storage does', () => {
    const { localStorage } = createEngineStorage()
    localStorage.setItem('n', 5 as unknown as string)
    expect(localStorage.getItem('n')).toBe('5')
  })

  it('takes the snapshot the host injected before load, once', () => {
    const target: SnapshotInjectionTarget = { __YAPPR_ENGINE_STORAGE__: { local: { a: '1' } } }
    expect(takeInjectedSnapshot(target)).toEqual({ local: { a: '1' } })
    expect('__YAPPR_ENGINE_STORAGE__' in target).toBe(false)
    expect(takeInjectedSnapshot(target)).toEqual({})
  })

  it('clears an injected snapshot even when it cannot be deleted (a `var` global)', () => {
    const target: SnapshotInjectionTarget = {}
    Object.defineProperty(target, '__YAPPR_ENGINE_STORAGE__', { value: { local: { a: '1' } }, writable: true, configurable: false })
    expect(takeInjectedSnapshot(target)).toEqual({ local: { a: '1' } })
    expect(target.__YAPPR_ENGINE_STORAGE__).toBeUndefined()
  })

  it('installs over globalThis', () => {
    const target: { localStorage?: Storage; sessionStorage?: Storage } = {}
    const storage = createEngineStorage()
    installEngineStorage(storage, target)
    expect(target.localStorage).toBe(storage.localStorage)
    expect(target.sessionStorage).toBe(storage.sessionStorage)
  })
})

describe('lifecycle', () => {
  function fakeWindow() {
    const doc = new EventTarget() as unknown as Document
    const win = Object.assign(new EventTarget(), { document: doc }) as unknown as Window
    const fired: string[] = []
    doc.addEventListener('visibilitychange', () => fired.push(`visibilitychange:${doc.visibilityState}`))
    for (const type of ['pagehide', 'pageshow', 'online', 'offline']) win.addEventListener(type, () => fired.push(type))
    installVisibilityOverride(doc)
    return { win, doc, fired }
  }

  it('replays AppState as the events a browser tab fires', () => {
    const { win, doc, fired } = fakeWindow()
    expect(doc.visibilityState).toBe('visible')
    dispatchLifecycle('inactive', win)
    dispatchLifecycle('background', win)
    dispatchLifecycle('background', win)
    expect(doc.hidden).toBe(true)
    dispatchLifecycle('active', win)
    expect(fired).toEqual(['visibilitychange:hidden', 'pagehide', 'visibilitychange:visible', 'pageshow'])
  })

  it('forwards connectivity', () => {
    const { win, fired } = fakeWindow()
    dispatchConnectivity(false, win)
    dispatchConnectivity(true, win)
    expect(fired).toEqual(['offline', 'online'])
  })
})
