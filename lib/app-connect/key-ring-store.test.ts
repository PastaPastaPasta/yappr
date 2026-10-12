import { describe, expect, it } from 'vitest'
import type { AppConnectSession } from 'platform-auth'
import { AppConnectKeyRingStore, type KeyRingBackend } from './key-ring-store'

function memoryBackend(): KeyRingBackend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value))
    },
    delete: async (key) => {
      data.delete(key)
    },
    deleteIf: async (key, predicate) => {
      if (!data.has(key) || !predicate(data.get(key))) return false
      data.delete(key)
      return true
    },
    updateIf: async (key, predicate, next) => {
      if (!data.has(key) || !predicate(data.get(key))) return false
      data.set(key, structuredClone(next(data.get(key))))
      return true
    },
  }
}

function session(identityId = 'alice'): AppConnectSession {
  return {
    v: 1,
    network: 'devnet',
    identityId,
    appId: 'app',
    groupId: 'group',
    connectionId: '00'.repeat(16),
    grantedAt: 1,
    authKeys: [{ keyId: 5, bounds: { kind: 'contractGroup', groupId: 'group' }, securityLevel: 1, totalBudget: 10n, remainingBudget: 9n, expiresAt: 99, keyRef: 'key-5' }],
    encKeys: [{ keyId: 6, contractId: 'app', purpose: 1, keyRef: 'key-6' }],
  }
}

const groupKey = new Uint8Array(32).fill(5)
const encKey = new Uint8Array(32).fill(6)
const keys = () => new Map([['key-5', groupKey.slice()], ['key-6', encKey.slice()]])

describe('AppConnectKeyRingStore', () => {
  it('stores the session with its keys wrapped, and unwraps them', async () => {
    const backend = memoryBackend()
    const store = new AppConnectKeyRingStore(backend)
    await store.save(session(), keys())

    expect(await store.load('devnet')).toEqual(session())
    expect(await store.privateKey(session(), 'key-5')).toEqual(groupKey)
    expect(await store.privateKey(session(), 'key-6')).toEqual(encKey)
    // At rest the key bytes appear nowhere in the record.
    const stored = JSON.stringify(backend.data.get('session:devnet'), (_k, v) => (v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : typeof v === 'bigint' ? String(v) : v))
    expect(stored).not.toContain(Array.from(groupKey).join(','))
  })

  it('keeps the device key non-extractable', async () => {
    const backend = memoryBackend()
    await new AppConnectKeyRingStore(backend).save(session(), keys())
    const deviceKey = backend.data.get('device-key') as CryptoKey
    expect(deviceKey.extractable).toBe(false)
  })

  it('does not unwrap a key for another identity, an unknown ref or a moved blob', async () => {
    const backend = memoryBackend()
    const store = new AppConnectKeyRingStore(backend)
    await store.save(session(), keys())
    expect(await store.privateKey(session('mallory'), 'key-5')).toBeNull()
    expect(await store.privateKey(session(), 'key-7')).toBeNull()

    const record = backend.data.get('session:devnet') as { wrapped: Record<string, unknown> }
    record.wrapped['key-6'] = record.wrapped['key-5']
    expect(await store.privateKey(session(), 'key-6')).toBeNull()
  })

  it('refuses a session whose keys are not all given', async () => {
    const store = new AppConnectKeyRingStore(memoryBackend())
    await expect(store.save(session(), new Map([['key-5', groupKey.slice()]]))).rejects.toThrow('key-6')
  })

  it('updates the record without touching the keys', async () => {
    const store = new AppConnectKeyRingStore(memoryBackend())
    await store.save(session(), keys())
    await store.updateSession({ ...session(), authKeys: [{ ...session().authKeys[0], remainingBudget: 1n }] })
    expect((await store.load('devnet'))?.authKeys[0].remainingBudget).toBe(1n)
    expect(await store.privateKey(session(), 'key-5')).toEqual(groupKey)
    // Another identity's update is ignored.
    await store.updateSession({ ...session('mallory') })
    expect((await store.load('devnet'))?.identityId).toBe('alice')
  })

  it('never lets an older grant clear or overwrite a newer one', async () => {
    const store = new AppConnectKeyRingStore(memoryBackend())
    const renewed = { ...session(), grantedAt: 2 }
    await store.save(renewed, keys())
    // A tab still holding the first grant finds its keys revoked.
    expect(await store.clear('devnet', { identityId: 'alice', grantedAt: 1 })).toBe(false)
    await store.updateSession({ ...session(), authKeys: [] })
    expect(await store.load('devnet')).toEqual(renewed)
    expect(await store.clear('devnet', { identityId: 'mallory' })).toBe(false)
    expect(await store.clear('devnet', { identityId: 'alice', grantedAt: 2 })).toBe(true)
  })

  it('wraps secrets per network and name', async () => {
    const backend = memoryBackend()
    const store = new AppConnectKeyRingStore(backend)
    const secret = new TextEncoder().encode('{"ephemeralPrivateKey":"11"}')
    await store.saveSecret('devnet', 'request', secret)
    expect(await store.loadSecret('devnet', 'request')).toEqual(secret)
    expect(JSON.stringify(Array.from(new Uint8Array((backend.data.get('secret:devnet:request') as { data: ArrayBuffer }).data)))).not.toContain(Array.from(secret).join(','))
    backend.data.set('secret:testnet:request', backend.data.get('secret:devnet:request'))
    expect(await store.loadSecret('testnet', 'request')).toBeNull()
    await store.deleteSecret('devnet', 'request')
    expect(await store.loadSecret('devnet', 'request')).toBeNull()
  })

  it('keeps one connection id per network across logout', async () => {
    const store = new AppConnectKeyRingStore(memoryBackend())
    const first = await store.connectionId('devnet')
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    await store.save(session(), keys())
    await store.clear('devnet', { identityId: 'alice' })
    expect(await store.load('devnet')).toBeNull()
    expect(await store.connectionId('devnet')).toBe(first)
    expect(await store.connectionId('testnet')).not.toBe(first)
  })
})
