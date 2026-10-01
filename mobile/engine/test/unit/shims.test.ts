import { describe, expect, it } from 'vitest'
import { createEngineStorage, installEngineStorage, takeInjectedSnapshot, type StorageChange } from '../../src/shims/storage'
import { dispatchConnectivity, dispatchLifecycle, installVisibilityOverride } from '../../src/shims/lifecycle'

const isSecure = (key: string) => key.startsWith('yappr_secure_')

describe('engine storage', () => {
  it('is synchronous Web Storage and reports writes for write-through', () => {
    const storage = createEngineStorage(isSecure)
    const changes: StorageChange[] = []
    storage.onChange(change => changes.push(change))
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

  it('routes secure-prefixed keys to the secure area', () => {
    const storage = createEngineStorage(isSecure)
    const changes: StorageChange[] = []
    storage.onChange(change => changes.push(change))
    storage.localStorage.setItem('yappr_secure_pk_abc', 'secret')
    storage.localStorage.setItem('plain', 'x')
    expect(storage.localStorage.getItem('yappr_secure_pk_abc')).toBe('secret')
    expect(storage.snapshot()).toEqual({ local: { plain: 'x' }, secure: { yappr_secure_pk_abc: 'secret' } })
    expect(changes.map(change => change.area)).toEqual(['secure', 'local'])
  })

  it('enumerates both areas through key() and length', () => {
    const storage = createEngineStorage(isSecure)
    storage.hydrate({ local: { a: '1' }, secure: { yappr_secure_b: '2' } })
    const { localStorage } = storage
    expect(localStorage.length).toBe(2)
    expect([localStorage.key(0), localStorage.key(1), localStorage.key(2)]).toEqual(['a', 'yappr_secure_b', null])
  })

  it('hydrates without reporting writes, replacing what was there', () => {
    const storage = createEngineStorage(isSecure)
    const changes: StorageChange[] = []
    storage.onChange(change => changes.push(change))
    storage.localStorage.setItem('old', '1')
    changes.length = 0
    storage.hydrate({ local: { fresh: '2' } })
    expect(changes).toEqual([])
    expect(storage.localStorage.getItem('old')).toBeNull()
    expect(storage.localStorage.getItem('fresh')).toBe('2')
  })

  it('clear() reports each removal', () => {
    const storage = createEngineStorage(isSecure)
    storage.hydrate({ local: { a: '1' }, secure: { yappr_secure_b: '2' } })
    const changes: StorageChange[] = []
    storage.onChange(change => changes.push(change))
    storage.localStorage.clear()
    expect(changes).toEqual([
      { area: 'local', key: 'a', value: null },
      { area: 'secure', key: 'yappr_secure_b', value: null },
    ])
  })

  it('keeps sessionStorage in memory only', () => {
    const storage = createEngineStorage(isSecure)
    const changes: StorageChange[] = []
    storage.onChange(change => changes.push(change))
    storage.sessionStorage.setItem('s', '1')
    expect(storage.sessionStorage.getItem('s')).toBe('1')
    expect(changes).toEqual([])
  })

  it('coerces keys and values to strings, as Web Storage does', () => {
    const { localStorage } = createEngineStorage(isSecure)
    localStorage.setItem('n', 5 as unknown as string)
    expect(localStorage.getItem('n')).toBe('5')
  })

  it('takes the snapshot the host injected before load, once', () => {
    const target = { __YAPPR_ENGINE_STORAGE__: { local: { a: '1' } } } as unknown as typeof globalThis
    expect(takeInjectedSnapshot(target)).toEqual({ local: { a: '1' } })
    expect('__YAPPR_ENGINE_STORAGE__' in target).toBe(false)
    expect(takeInjectedSnapshot(target)).toEqual({})
  })

  it('installs over globalThis', () => {
    const target = {} as typeof globalThis
    const storage = createEngineStorage(isSecure)
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
    for (const type of ['visibilitychange']) doc.addEventListener(type, () => fired.push(`${type}:${doc.visibilityState}`))
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
