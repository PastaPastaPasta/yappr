import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConnectSession } from 'platform-auth'
import type { KeyRingBackend } from './key-ring-store'

const backend = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  const memory: KeyRingBackend & { data: Map<string, unknown> } = {
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
    putIf: async (key, predicate, value) => {
      if (predicate(data.get(key))) data.set(key, structuredClone(value))
      return data.get(key)
    },
  }
  return memory
})

vi.mock('./key-ring-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./key-ring-store')>()),
  indexedDbKeyRingBackend: () => backend,
}))
vi.mock('./config', () => ({ appConnectPins: () => ({ appId: 'app', groupId: 'group' }) }))
vi.mock('./group-trust', () => ({ checkAppConnectTrust: vi.fn() }))
vi.mock('./platform-port', () => ({ appConnectPlatformPort: {} }))
vi.mock('@/lib/storage-scope', () => ({ scopedKey: (key: string) => key }))
vi.mock('@/lib/constants', () => ({ getConfiguredNetwork: () => 'devnet', keyNetwork: () => 'testnet' }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { AppConnectKeyRingStore } = await import('./key-ring-store')
const { appConnectSessions, useAppConnectStatus } = await import('./session-manager')

function grant(identityId: string, grantedAt: number): AppConnectSession {
  return {
    v: 1,
    network: 'devnet',
    identityId,
    appId: 'app',
    groupId: 'group',
    connectionId: '00'.repeat(16),
    grantedAt,
    authKeys: [{ keyId: grantedAt, bounds: { kind: 'contractGroup', groupId: 'group' }, securityLevel: 1, totalBudget: 10n, remainingBudget: 9n, expiresAt: 99, keyRef: 'key-group' }],
    encKeys: [],
  }
}

/** Another tab storing its grant: the same database, a separate store instance. */
async function storeFromAnotherTab(session: AppConnectSession): Promise<void> {
  await new AppConnectKeyRingStore(backend).save(session, new Map([['key-group', new Uint8Array(32).fill(7)]]))
}

/** This tab's session for `identityId`; fails the test when there is none. */
function currentSession(identityId: string): AppConnectSession {
  const session = appConnectSessions.current(identityId)
  if (!session) throw new Error(`no session for ${identityId}`)
  return session
}

const storedGrantedAt = () => (backend.data.get('session:devnet') as { session: AppConnectSession } | undefined)?.session.grantedAt

describe('AppConnectSessionManager across tabs', () => {
  const signedOut = vi.fn()

  beforeEach(async () => {
    await appConnectSessions.logout('alice')
    backend.data.delete('session:devnet')
    signedOut.mockReset()
    appConnectSessions.onSignedOut(signedOut)
    useAppConnectStatus.setState({ signedOutByWallet: false })
  })

  it('switches to a newer grant another tab stored instead of signing out', async () => {
    await storeFromAnotherTab(grant('alice', 1))
    expect(await appConnectSessions.restore('alice')).toBe(true)
    const old = currentSession('alice')
    await storeFromAnotherTab(grant('alice', 2))

    await appConnectSessions.signOutRevoked(old)

    expect(appConnectSessions.current('alice')?.grantedAt).toBe(2)
    expect(storedGrantedAt()).toBe(2)
    expect(signedOut).not.toHaveBeenCalled()
    expect(useAppConnectStatus.getState().signedOutByWallet).toBe(false)
  })

  it('signs out and clears its own grant when no newer one exists', async () => {
    await storeFromAnotherTab(grant('alice', 1))
    await appConnectSessions.restore('alice')
    const session = currentSession('alice')

    await appConnectSessions.signOutRevoked(session)

    expect(appConnectSessions.current()).toBeNull()
    expect(storedGrantedAt()).toBeUndefined()
    expect(signedOut).toHaveBeenCalledWith('alice')
    expect(useAppConnectStatus.getState().signedOutByWallet).toBe(true)
  })

  it('never lets an older grant wipe a newer one when it is discarded', async () => {
    await storeFromAnotherTab(grant('alice', 1))
    await appConnectSessions.restore('alice')
    const old = currentSession('alice')
    await storeFromAnotherTab(grant('alice', 2))

    await appConnectSessions.discard(old)

    expect(appConnectSessions.current()).toBeNull()
    expect(storedGrantedAt()).toBe(2)
  })

  it('does not switch to a grant for another identity', async () => {
    await storeFromAnotherTab(grant('alice', 1))
    await appConnectSessions.restore('alice')
    const session = currentSession('alice')
    await storeFromAnotherTab(grant('bob', 2))

    await appConnectSessions.signOutRevoked(session)

    expect(appConnectSessions.current()).toBeNull()
    expect(storedGrantedAt()).toBe(2)
    expect(signedOut).toHaveBeenCalledWith('alice')
  })

  it('logout forgets the identity whichever tab stored its grant', async () => {
    await storeFromAnotherTab(grant('alice', 1))
    await appConnectSessions.restore('alice')
    await storeFromAnotherTab(grant('alice', 2))

    await appConnectSessions.logout('alice')

    expect(appConnectSessions.current()).toBeNull()
    expect(storedGrantedAt()).toBeUndefined()
  })
})
