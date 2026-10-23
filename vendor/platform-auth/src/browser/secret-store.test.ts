import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserSecretStore } from './secret-store'

const PREFIX = 'test_secure_'
const IDENTITY = 'identity-1'
const WIF = 'not-a-real-wif'

/** A Map-backed Storage whose writes, removals or both the test can make fail, as a full or locked-down browser does. */
function fakeStorage() {
  const map = new Map<string, string>()
  const faults = { set: false, remove: false, dropWrites: false }
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => {
      if (faults.remove) throw new DOMException('denied', 'SecurityError')
      map.delete(key)
    },
    setItem: (key, value) => {
      if (faults.set) throw new DOMException('full', 'QuotaExceededError')
      if (!faults.dropWrites) map.set(key, String(value))
    },
  }
  return { storage, map, faults }
}

let local: ReturnType<typeof fakeStorage>
let session: ReturnType<typeof fakeStorage>

function store() {
  return createBrowserSecretStore({
    prefix: PREFIX,
    network: 'testnet',
    crypto: {
      parsePrivateKey: () => ({ privateKey: new Uint8Array(32).fill(1) }),
      privateKeyToWif: () => WIF,
      isLikelyWif: () => true,
    },
  })
}

beforeEach(() => {
  local = fakeStorage()
  session = fakeStorage()
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', local.storage)
  vi.stubGlobal('sessionStorage', session.storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a full browser store (reads and removals work, writes fail)', () => {
  it('still removes and lists the secrets it holds', () => {
    const s = store()
    s.storePrivateKey(IDENTITY, WIF)
    s.storePrivateKey('identity-2', WIF)
    s.storeTransferKey(IDENTITY, WIF)
    local.faults.set = true

    expect(s.hasPrivateKey(IDENTITY)).toBe(true)
    expect(s.getPrivateKey(IDENTITY)).toBe(WIF)
    expect(s.secureStorage.keys().sort()).toEqual([`pk_${IDENTITY}`, 'pk_identity-2', `tk_${IDENTITY}`])

    expect(s.clearPrivateKey(IDENTITY)).toEqual({ existed: true, complete: true })
    expect(s.getPrivateKey(IDENTITY)).toBeNull()
    expect(local.map.has(`${PREFIX}pk_${IDENTITY}`)).toBe(false)

    expect(s.clearAllPrivateKeys()).toEqual({ existed: true, complete: true })
    expect(s.clearTransferKey(IDENTITY)).toEqual({ existed: true, complete: true })
    expect(local.map.size).toBe(0)
  })

  it('removes an older copy left in sessionStorage too', () => {
    session.map.set(`${PREFIX}pk_${IDENTITY}`, JSON.stringify(WIF))
    local.faults.set = true
    session.faults.set = true
    const s = store()
    expect(s.clearPrivateKey(IDENTITY)).toEqual({ existed: true, complete: true })
    expect(session.map.size).toBe(0)
  })

  it('never writes to storage to read a key', () => {
    const s = store()
    s.storePrivateKey(IDENTITY, WIF)
    const setItem = vi.spyOn(local.storage, 'setItem')
    const removeItem = vi.spyOn(local.storage, 'removeItem')
    expect(s.getPrivateKey(IDENTITY)).toBe(WIF)
    expect(s.hasPrivateKey(IDENTITY)).toBe(true)
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })
})

describe('a secret the browser does not keep', () => {
  it('fails the store instead of passing for saved', () => {
    const s = store()
    local.faults.set = true
    expect(() => s.storePrivateKey(IDENTITY, WIF)).toThrow()
    expect(() => s.storeEncryptionKey(IDENTITY, WIF)).toThrow()
    expect(() => s.storeTransferKey(IDENTITY, WIF)).toThrow()
    expect(() => s.storeLoginKey(IDENTITY, new Uint8Array(32))).toThrow()
    expect(s.hasPrivateKey(IDENTITY)).toBe(false)
  })

  it('fails the store when the write is silently dropped', () => {
    local.faults.dropWrites = true
    expect(() => store().storePrivateKey(IDENTITY, WIF)).toThrow()
  })

  it('reports a removal the browser refuses, so no caller thinks the key is gone', () => {
    const s = store()
    s.storePrivateKey(IDENTITY, WIF)
    local.faults.remove = true
    expect(s.clearPrivateKey(IDENTITY)).toEqual({ existed: true, complete: false })
    expect(s.getPrivateKey(IDENTITY)).toBe(WIF)
    expect(s.clearEncryptionKey(IDENTITY)).toEqual({ existed: false, complete: true })
  })
})

describe('moving a key an earlier version kept in sessionStorage', () => {
  const name = `${PREFIX}pk_${IDENTITY}`

  it('keeps the old copy when the new one cannot be written', () => {
    session.map.set(name, JSON.stringify(WIF))
    local.faults.set = true
    const s = store()
    expect(s.getPrivateKey(IDENTITY)).toBe(WIF)
    expect(session.map.get(name)).toBe(JSON.stringify(WIF))
    expect(local.map.has(name)).toBe(false)
  })

  it('keeps the old copy when the new one does not read back', () => {
    session.map.set(name, JSON.stringify(WIF))
    local.faults.dropWrites = true
    expect(store().getPrivateKey(IDENTITY)).toBe(WIF)
    expect(session.map.get(name)).toBe(JSON.stringify(WIF))
  })

  it('drops the old copy once the new one is saved', () => {
    session.map.set(name, JSON.stringify(WIF))
    expect(store().getPrivateKey(IDENTITY)).toBe(WIF)
    expect(local.map.get(name)).toBe(JSON.stringify(WIF))
    expect(session.map.has(name)).toBe(false)
  })
})
