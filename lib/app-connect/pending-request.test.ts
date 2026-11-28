import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as secp256k1 from '@noble/secp256k1'
import { getYapprPublicKey, hash160 } from 'platform-auth'
import { bytesToHex } from '@/lib/bytes'
import type { KeyRingBackend } from './key-ring-store'
import type { StoredAppConnectRequest } from './login-flow'

vi.mock('./config', () => ({ appConnectPins: () => ({ appId: 'app', groupId: 'group' }) }))
vi.mock('./group-trust', () => ({ checkAppConnectTrust: vi.fn() }))
vi.mock('./platform-port', () => ({ appConnectPlatformPort: {} }))
vi.mock('@/lib/storage-scope', () => ({ scopedKey: (key: string) => key }))
vi.mock('@/lib/constants', () => ({ getConfiguredNetwork: () => 'devnet', keyNetwork: () => 'testnet' }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { appConnectSessions } = await import('./session-manager')
const { isPendingRenewal, pendingRecoveryIdentity, requestRecordsFor } = await import('./pending-request')

function memoryBackend(): KeyRingBackend {
  const data = new Map<string, unknown>()
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async (key) => { data.delete(key) },
    deleteIf: async (key, predicate) => data.has(key) && predicate(data.get(key)) && data.delete(key),
    updateIf: async () => false,
    putIf: async (key, predicate, value) => {
      if (predicate(data.get(key))) data.set(key, structuredClone(value))
      return data.get(key)
    },
  }
}

/** A fresh request for `identityHint`, and the hash the wallet returns for it. */
function request(identityHint?: string): { record: StoredAppConnectRequest; hash: string } {
  const privateKey = secp256k1.utils.randomSecretKey()
  const record = { ephemeralPrivateKey: bytesToHex(privateKey), createdAt: Date.now(), connectionId: 'ab'.repeat(16), ...(identityHint ? { identityHint } : {}) }
  return { record, hash: bytesToHex(hash160(getYapprPublicKey(privateKey))) }
}

describe('pendingRecoveryIdentity', () => {
  beforeEach(() => {
    appConnectSessions.useKeyRingBackend(memoryBackend())
  })

  it('finds a signed-out passkey renewal from the hash the wallet returned for, and nothing else', async () => {
    const recovery = request('alice')
    await requestRecordsFor('alice', true).save(recovery.record)
    expect(await pendingRecoveryIdentity(recovery.hash)).toBe('alice')
    expect(await pendingRecoveryIdentity(request('alice').hash)).toBeNull()
    // Its own slot: neither a sign-in's nor a signed-in renewal's.
    expect(await requestRecordsFor(undefined).load()).toBeNull()
    expect(await isPendingRenewal('alice', recovery.hash)).toBe(false)
  })

  it('never finds a sign-in or a signed-in renewal', async () => {
    const login = request()
    const renewal = request('bob')
    await requestRecordsFor(undefined).save(login.record)
    await requestRecordsFor('bob').save(renewal.record)
    expect(await pendingRecoveryIdentity(login.hash)).toBeNull()
    expect(await pendingRecoveryIdentity(renewal.hash)).toBeNull()
    expect(await isPendingRenewal('bob', renewal.hash)).toBe(true)
  })
})
