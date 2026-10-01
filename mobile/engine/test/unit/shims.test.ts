import { describe, expect, it } from 'vitest'
import {
  SECURE_KEY_PREFIXES,
  createEngineStorage,
  installEngineStorage,
  isSecureStorageKey,
  takeInjectedSnapshot,
  type EngineStorage,
  type SnapshotInjectionTarget,
  type StorageChange,
} from '../../src/shims/storage'
import { dispatchConnectivity, dispatchLifecycle, installVisibilityOverride } from '../../src/shims/lifecycle'

function recordChanges(storage: EngineStorage): StorageChange[] {
  const changes: StorageChange[] = []
  storage.onChange(change => changes.push(change))
  return changes
}

describe('engine storage', () => {
  it('is synchronous Web Storage and reports writes for write-through', () => {
    const storage = createEngineStorage()
    const changes = recordChanges(storage)
    storage.localStorage.setItem('yappr_session', '{"user":1}')
    expect(storage.localStorage.getItem('yappr_session')).toBe('{"user":1}')
    storage.localStorage.removeItem('yappr_session')
    storage.localStorage.removeItem('never-set')
    expect(storage.localStorage.getItem('yappr_session')).toBeNull()
    expect(changes).toEqual([
      { area: 'local', key: 'yappr_session', value: '{"user":1}' },
      { area: 'local', key: 'yappr_session', value: null },
    ])
  })

  it('routes private keys, private-feed keys and upload credentials to the secure area', () => {
    expect(SECURE_KEY_PREFIXES).toEqual(['yappr_secure_', 'yappr:pf:', 'yappr_pinata_', 'yappr_storacha_'])
    for (const key of ['yappr_secure_pk_abc', 'yappr:pf:feed_seed', 'yappr:pf:path_keys:1', 'yappr_pinata_jwt', 'yappr_storacha_agent']) {
      expect(isSecureStorageKey(key), key).toBe(true)
    }
    for (const key of ['yappr_session', 'yappr-settings', 'pf:feed_seed', 'x_yappr_secure_']) {
      expect(isSecureStorageKey(key), key).toBe(false)
    }

    const storage = createEngineStorage()
    const changes = recordChanges(storage)
    storage.localStorage.setItem('yappr:pf:feed_seed', 'seed')
    storage.localStorage.setItem('plain', 'x')
    expect(storage.localStorage.getItem('yappr:pf:feed_seed')).toBe('seed')
    expect(storage.snapshot()).toEqual({ local: { plain: 'x' }, secure: { 'yappr:pf:feed_seed': 'seed' } })
    expect(changes.map(change => change.area)).toEqual(['secure', 'local'])
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

  it('hydrates without reporting writes, replacing what was there', () => {
    const storage = createEngineStorage()
    const changes = recordChanges(storage)
    storage.localStorage.setItem('old', '1')
    changes.length = 0
    storage.hydrate({ local: { fresh: '2' } })
    expect(changes).toEqual([])
    expect(storage.localStorage.getItem('old')).toBeNull()
    expect(storage.localStorage.getItem('fresh')).toBe('2')
  })

  it('queues writes made before anyone subscribes and hands them to the first subscriber', () => {
    const storage = createEngineStorage()
    storage.localStorage.setItem('written-while-lib-loads', '1')
    const first = recordChanges(storage)
    const second = recordChanges(storage)
    storage.localStorage.setItem('later', '2')
    expect(first).toEqual([
      { area: 'local', key: 'written-while-lib-loads', value: '1' },
      { area: 'local', key: 'later', value: '2' },
    ])
    expect(second).toEqual([{ area: 'local', key: 'later', value: '2' }])
  })

  it('clear() reports each removal', () => {
    const storage = createEngineStorage()
    storage.hydrate({ local: { a: '1' }, secure: { yappr_secure_b: '2' } })
    const changes = recordChanges(storage)
    storage.localStorage.clear()
    expect(changes).toEqual([
      { area: 'local', key: 'a', value: null },
      { area: 'secure', key: 'yappr_secure_b', value: null },
    ])
  })

  it('keeps sessionStorage in memory only', () => {
    const storage = createEngineStorage()
    const changes = recordChanges(storage)
    storage.sessionStorage.setItem('s', '1')
    expect(storage.sessionStorage.getItem('s')).toBe('1')
    expect(changes).toEqual([])
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
