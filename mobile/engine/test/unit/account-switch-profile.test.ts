/**
 * lib's session store and the engine's account registry together: an
 * account's refreshed balance and username follow it through "Add account"
 * and a switch back, and never show as another account's (#732).
 */
import { describe, expect, it } from 'vitest'
import type { AuthUser } from 'platform-auth'

// lib's session store needs `window` and the engine's storage before lib loads.
const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())
Object.assign(globalThis, { window: globalThis })

const { createYapprPlatformAuthDependencies } = await import('@/lib/auth/platform-auth-adapters')
const { createAccountRegistry } = await import('../../src/session/accounts')

const user = (identityId: string, balance: number, username?: string): AuthUser => ({ identityId, balance, username, publicKeys: [] })

describe('a refreshed profile across an account switch', () => {
  it('comes back with its account and never shows for another', async () => {
    const { sessionStore } = createYapprPlatformAuthDependencies()
    const registry = createAccountRegistry(localStorage)

    await sessionStore.setSession({ user: user('alice', 1), timestamp: 1, signIn: 'key' })
    registry.upsert('alice', { username: null })
    expect(await sessionStore.updateUser?.(user('alice', 7, 'alice.dash'), 2)).toBe(true)

    registry.switchTo(null)
    expect(await sessionStore.getSession()).toBeNull()
    await sessionStore.setSession({ user: user('bob', 4), timestamp: 3, signIn: 'wallet' })
    registry.upsert('bob', { username: null })
    expect(await sessionStore.getSession()).toMatchObject({ user: { identityId: 'bob', balance: 4 }, signIn: 'wallet' })
    expect((await sessionStore.getSession())?.user.username).toBeUndefined()

    registry.switchTo('alice')
    expect(await sessionStore.getSession()).toMatchObject({ user: { identityId: 'alice', balance: 7, username: 'alice.dash' }, signIn: 'key' })

    registry.switchTo('bob')
    expect(await sessionStore.getSession()).toMatchObject({ user: { identityId: 'bob', balance: 4 } })
    expect((await sessionStore.getSession())?.user.username).toBeUndefined()
  })
})
