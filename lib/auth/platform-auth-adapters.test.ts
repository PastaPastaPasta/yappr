import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
