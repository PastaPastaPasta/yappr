/**
 * #732: on App Connect builds a raw-key sign-in stays raw-key when this tab
 * reloads, even after another tab stored a newer wallet grant for the same
 * identity; a wallet sign-in still restores on its grant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { SESSION_STORAGE_KEY } from '@/lib/storage-scope'
import { PlatformAuthController } from '../../vendor/platform-auth/src/core/controller'
import { createYapprPlatformAuthDependencies } from './platform-auth-adapters'

const sessions = vi.hoisted(() => ({
  restore: vi.fn(async (identityId: string) => identityId === 'alice'),
  yieldToRawKey: vi.fn(async () => undefined),
  hasStoredGrant: vi.fn(async (identityId: string) => identityId === 'alice'),
  lifecycleMark: vi.fn(() => 0),
  current: vi.fn(() => null),
}))
vi.mock('@/lib/app-connect/session-manager', () => ({ appConnectSessions: sessions }))
vi.mock('@/lib/services/evo-sdk-service', () => ({ evoSdkService: { initialize: async () => undefined } }))
/** The identity's keys as Platform has them now; the session saved its own copy at sign-in. */
const chain = vi.hoisted(() => ({ getIdentity: vi.fn() }))
vi.mock('@/lib/services/identity-service', () => ({ identityService: chain }))
vi.mock('@/lib/app-connect/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/app-connect/config')>(),
  isAppConnectBuild: () => true,
}))

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WIF = privateKeyToWif(PRIVATE_KEY, 'testnet')
const identity = {
  id: 'alice',
  balance: 1,
  publicKeys: [{ id: 1, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.AUTHENTICATION, securityLevel: SecurityLevel.HIGH, data: bytesToBase64(getPublicKey(PRIVATE_KEY)) }],
}

const data = new Map<string, string>()
beforeAll(() => {
  const storage = {
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => data.clear(),
  }
  vi.stubGlobal('window', { localStorage: storage, setTimeout: () => 0, addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('localStorage', storage)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  data.clear()
  sessions.restore.mockClear()
  sessions.hasStoredGrant.mockClear()
  sessions.lifecycleMark.mockImplementation(() => 0)
  chain.getIdentity.mockReset()
  chain.getIdentity.mockImplementation(async () => identity)
})

/** One tab: the app's adapters, with the identity read stubbed and the background work off. */
function tab(): PlatformAuthController {
  const deps = createYapprPlatformAuthDependencies()
  return new PlatformAuthController({
    ...deps,
    identity: { getIdentity: async () => identity, getBalance: async () => 2 },
    usernames: undefined,
    profiles: undefined,
    clientIdentity: undefined,
    onEvent: undefined,
    features: { balanceRefresh: false, postLoginTasks: false, autoDeriveEncryptionKey: false, usernameGate: false },
  })
}

describe('restoring a session by how it signed in (#732)', () => {
  it('keeps a raw-key sign-in on its key after another tab stored a newer wallet grant', async () => {
    const walletTab = tab()
    await walletTab.loginWithKeyRing('alice')
    await tab().loginWithAuthKey('alice', WIF)
    // The wallet tab renews its grant (the ring now holds a newer one) and refreshes its balance.
    await walletTab.refreshBalance()

    const reloaded = tab()
    expect(await reloaded.restoreSession()).toMatchObject({ identityId: 'alice', balance: 2 })
    expect(sessions.restore).not.toHaveBeenCalled()
  })

  it('restores a wallet sign-in on its grant', async () => {
    await tab().loginWithAuthKey('alice', WIF)
    await tab().loginWithKeyRing('alice')

    expect(await tab().restoreSession()).toMatchObject({ identityId: 'alice' })
    expect(sessions.restore).toHaveBeenCalledWith('alice', 0)
  })

  it('restores a session saved before the mode was recorded on the grant first, as before', async () => {
    await tab().loginWithAuthKey('alice', WIF)
    const stored = JSON.parse(data.get(SESSION_STORAGE_KEY) ?? '{}')
    expect(stored.signIn).toBe('key')
    delete stored.signIn
    data.set(SESSION_STORAGE_KEY, JSON.stringify(stored))

    expect(await tab().restoreSession()).toMatchObject({ identityId: 'alice' })
    expect(sessions.restore).toHaveBeenCalledWith('alice', 0)
  })

  it('lets a tab without the raw key restore on the wallet grant', async () => {
    await tab().loginWithAuthKey('alice', WIF)
    for (const key of [...data.keys()]) if (key.includes('yappr_secure_')) data.delete(key)

    expect(await tab().restoreSession()).toMatchObject({ identityId: 'alice' })
    expect(sessions.restore).toHaveBeenCalledWith('alice', 0)
  })

  it('gives way to the wallet grant when Platform no longer takes the raw key', async () => {
    await tab().loginWithAuthKey('alice', WIF)
    // Disabled on the identity; the session's copy of the keys still has it.
    chain.getIdentity.mockImplementation(async () => ({ ...identity, publicKeys: [{ ...identity.publicKeys[0], disabledAt: 1 }] }))

    expect(await tab().restoreSession()).toMatchObject({ identityId: 'alice' })
    expect(chain.getIdentity).toHaveBeenCalledWith('alice', { fresh: true })
    expect(sessions.restore).toHaveBeenCalledWith('alice', 0)
  })

  it('keeps the raw key when the identity cannot be read', async () => {
    await tab().loginWithAuthKey('alice', WIF)
    chain.getIdentity.mockRejectedValue(new Error('offline'))

    expect(await tab().restoreSession()).toMatchObject({ identityId: 'alice' })
    expect(sessions.restore).not.toHaveBeenCalled()
  })

  it('reads nothing from the network for a raw-key session without a stored grant', async () => {
    await tab().loginWithAuthKey('alice', WIF)
    chain.getIdentity.mockClear()
    sessions.hasStoredGrant.mockResolvedValueOnce(false)

    expect(await tab().restoreSession()).toMatchObject({ identityId: 'alice' })
    expect(chain.getIdentity).not.toHaveBeenCalled()
    expect(sessions.restore).not.toHaveBeenCalled()
  })

  it('never writes back a session another tab ended or replaced', async () => {
    const walletTab = tab()
    await walletTab.loginWithKeyRing('alice')
    // Another tab signs out.
    data.delete(SESSION_STORAGE_KEY)
    await walletTab.refreshBalance()
    expect(data.get(SESSION_STORAGE_KEY)).toBeUndefined()

    await walletTab.loginWithKeyRing('alice')
    // Another tab signs bob in.
    const stored = JSON.parse(data.get(SESSION_STORAGE_KEY) ?? '{}')
    data.set(SESSION_STORAGE_KEY, JSON.stringify({ ...stored, user: { ...stored.user, identityId: 'bob' } }))
    await walletTab.refreshBalance()
    expect(JSON.parse(data.get(SESSION_STORAGE_KEY) ?? '{}').user.identityId).toBe('bob')
  })

  it('refreshes never touch the sign-in record, and a reload still sees their balance', async () => {
    const walletTab = tab()
    await walletTab.loginWithKeyRing('alice')
    await tab().loginWithAuthKey('alice', WIF)
    const signInRecord = data.get(SESSION_STORAGE_KEY)
    await walletTab.refreshBalance()
    await walletTab.setUsername('alice.dash')

    expect(data.get(SESSION_STORAGE_KEY)).toBe(signInRecord)
    expect(await tab().restoreSession()).toMatchObject({ identityId: 'alice', balance: 2, username: 'alice.dash' })
  })

  it('pins the grant restore to the moment the reload began', async () => {
    await tab().loginWithAuthKey('alice', WIF)
    // The manager's fence: a raw-key sign-in lands while the fresh lookup is pending and moves it on.
    let lifecycle = 41
    sessions.lifecycleMark.mockImplementation(() => lifecycle)
    chain.getIdentity.mockImplementation(async () => {
      lifecycle = 42
      return { ...identity, publicKeys: [{ ...identity.publicKeys[0], disabledAt: 1 }] }
    })

    await tab().restoreSession()
    expect(sessions.restore).toHaveBeenCalledWith('alice', 41)
  })
})
