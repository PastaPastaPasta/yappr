import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PlatformAuthController } from '../../vendor/platform-auth/src/core/controller'

const syncFollowedFeeds = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services/private-feed-follower-service', () => ({ privateFeedFollowerService: { syncFollowedFeeds } }))
vi.mock('@/lib/services/block-service', () => ({ blockService: { initializeBlockData: async () => undefined } }))

function installWindow() {
  const data = new Map<string, string>()
  const localStorage = {
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => data.clear(),
  }
  vi.stubGlobal('window', { localStorage, setTimeout: () => 0, addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('localStorage', localStorage)
}

beforeAll(installWindow)
afterAll(() => vi.unstubAllGlobals())

describe('the session store adapter', () => {
  it('lifts a sign-out\'s private-feed key fence on every login, before any post-login work', async () => {
    const { createYapprPlatformAuthDependencies } = await import('./platform-auth-adapters')
    const { privateFeedKeyStore } = await import('@/lib/services/private-feed-key-store')
    const keys = { finalKeyGeneration: 1, cek: new Uint8Array(32).fill(1), history: new Uint8Array(32).fill(2) }
    privateFeedKeyStore.signOut('me')
    privateFeedKeyStore.storeHistoryKeys('me', 'owner', 1, keys)
    expect(privateFeedKeyStore.historyKeys('me', 'owner', 1)).toBeNull()
    await createYapprPlatformAuthDependencies().sessionStore.setSession({ user: { identityId: 'me' } as never, timestamp: 0 })
    privateFeedKeyStore.storeHistoryKeys('me', 'owner', 1, keys)
    expect(privateFeedKeyStore.historyKeys('me', 'owner', 1)).not.toBeNull()
  })
})


describe('remote sign-out cleanup', () => {
  it('also drops this tab’s wallet session', async () => {
    const { createYapprPlatformAuthDependencies } = await import('./platform-auth-adapters')
    const { appConnectSessions } = await import('@/lib/app-connect/session-manager')
    const logout = vi.spyOn(appConnectSessions, 'logoutLocally')
    await createYapprPlatformAuthDependencies().secretStore.clearTabSecrets?.('wallet-user')
    expect(logout).toHaveBeenCalledWith('wallet-user')
    logout.mockRestore()
  })

  it('fences this tab without deleting private-feed keys saved by a newer login in another tab', async () => {
    const { createYapprPlatformAuthDependencies } = await import('./platform-auth-adapters')
    const { privateFeedKeyStore } = await import('@/lib/services/private-feed-key-store')
    const deps = createYapprPlatformAuthDependencies()
    const identityId = 'remote-feed-owner'
    const user = { identityId, balance: 1, publicKeys: [] }
    await deps.sessionStore.setSession({ user, timestamp: 0 })
    const controller = new PlatformAuthController({
      ...deps,
      secretStore: { ...deps.secretStore, hasPrivateKey: () => true, clearTabSecrets: () => undefined },
      identity: { getIdentity: async () => null, getBalance: async () => 1 },
      usernames: undefined,
      clientIdentity: undefined,
      features: { balanceRefresh: false, postLoginTasks: false },
    })
    await controller.restoreSession()
    const keys = { finalKeyGeneration: 1, cek: new Uint8Array(32).fill(3), history: new Uint8Array(32).fill(4) }
    privateFeedKeyStore.storeHistoryKeys(identityId, 'owner', 1, keys)
    // No sessionStorage is available: local cleanup must still finish.
    expect(await controller.logoutLocally()).toBe(true)
    expect(controller.getState().user).toBeNull()
    expect(privateFeedKeyStore.historyKeys(identityId, 'owner', 1)).toEqual(keys)
    privateFeedKeyStore.storeHistoryKeys(identityId, 'owner', 1, { ...keys, finalKeyGeneration: 2 })
    expect(privateFeedKeyStore.historyKeys(identityId, 'owner', 1)).toEqual(keys)
    expect(await deps.sessionStore.getSession()).toMatchObject({ user })
    privateFeedKeyStore.signOut(identityId)
    expect(privateFeedKeyStore.historyKeys(identityId, 'owner', 1)).toBeNull()
  })
})


describe('stale post-login work', () => {
  it('does not erase another tab’s newly saved keys when a feed sync finishes after sign-out', async () => {
    const { createYapprPlatformAuthDependencies } = await import('./platform-auth-adapters')
    const { privateFeedKeyStore } = await import('@/lib/services/private-feed-key-store')
    let finish: () => void = () => undefined
    syncFollowedFeeds.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ synced: [], failed: [], upToDate: [] })
    }))
    const identityId = 'stale-sync-owner'
    let active = true
    const deps = createYapprPlatformAuthDependencies()
    await deps.sideEffects?.runPostLogin(identityId, { delayMs: 0, isSessionActive: () => active })
    await vi.waitFor(() => expect(syncFollowedFeeds).toHaveBeenCalledWith(identityId))
    active = false
    const keys = { finalKeyGeneration: 1, cek: new Uint8Array(32).fill(5), history: new Uint8Array(32).fill(6) }
    privateFeedKeyStore.storeHistoryKeys(identityId, 'owner', 1, keys)
    const fenced = vi.spyOn(privateFeedKeyStore, 'signOutLocally')
    finish()
    await vi.waitFor(() => expect(fenced).toHaveBeenCalledWith(identityId))
    privateFeedKeyStore.storeHistoryKeys(identityId, 'owner', 1, { ...keys, finalKeyGeneration: 2 })
    expect(privateFeedKeyStore.historyKeys(identityId, 'owner', 1)).toEqual(keys)
    fenced.mockRestore()
  })
})
