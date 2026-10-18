import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PlatformAuthController } from '../../vendor/platform-auth/src/core/controller'

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
  vi.stubGlobal('window', { localStorage, addEventListener: () => undefined, removeEventListener: () => undefined })
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
