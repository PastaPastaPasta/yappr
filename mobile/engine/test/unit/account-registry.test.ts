import { describe, expect, it } from 'vitest'
import { SESSION_PROFILE_KEY, SESSION_STORAGE_KEY, scopedKey } from '@/lib/storage-scope'
import { createAccountRegistry } from '../../src/session/accounts'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

const NOTIFICATIONS = scopedKey('yappr-notifications')
const signedInAs = (storage: ReturnType<typeof memoryStorage>, identityId: string) =>
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ user: { identityId } }))
/** lib's refreshed balance for the active account (`updateUser`). */
const refreshed = (storage: ReturnType<typeof memoryStorage>, identityId: string, balance: number) =>
  storage.setItem(SESSION_PROFILE_KEY, JSON.stringify({ identityId, balance, dpnsUsername: null, timestamp: balance }))
const liveProfile = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.getItem(SESSION_PROFILE_KEY) ?? 'null') as { identityId: string; balance: number } | null

/** Alice signs in and refreshes her balance, then "Add account" signs bob in (lib's sign-in drops the live profile). */
function aliceThenBob() {
  const storage = memoryStorage()
  const registry = createAccountRegistry(storage)
  signedInAs(storage, 'alice')
  registry.upsert('alice', { username: 'alice' })
  refreshed(storage, 'alice', 7)
  registry.switchTo(null)
  storage.removeItem(SESSION_PROFILE_KEY)
  signedInAs(storage, 'bob')
  registry.upsert('bob', { username: 'bob' })
  return { storage, registry }
}

describe('account registry', () => {
  it('gives a parked account its stores back when it signs in again instead of switching', () => {
    const storage = memoryStorage()
    const registry = createAccountRegistry(storage)
    signedInAs(storage, 'alice')
    registry.upsert('alice', { username: 'alice' })
    storage.setItem(NOTIFICATIONS, 'alice-read-state')

    // Add account: alice is parked and the slot is empty.
    registry.switchTo(null)
    expect(storage.getItem(NOTIFICATIONS)).toBeNull()
    expect(registry.get('alice')?.savedSession).toBeDefined()

    // Signing in as alice again (by key, during "Add account"; a wallet sign-in switches instead).
    signedInAs(storage, 'alice')
    registry.upsert('alice', { username: 'alice', method: 'key' })
    expect(storage.getItem(NOTIFICATIONS)).toBe('alice-read-state')
    expect(registry.get('alice')?.savedSession).toBeUndefined()
  })

  it('leaves the live stores alone for an account that was not parked', () => {
    const storage = memoryStorage()
    const registry = createAccountRegistry(storage)
    signedInAs(storage, 'bob')
    registry.upsert('bob', { username: 'bob' })
    storage.setItem(NOTIFICATIONS, 'bob-live')
    registry.upsert('bob', { username: 'bob' })
    expect(storage.getItem(NOTIFICATIONS)).toBe('bob-live')
  })

  it('gives an account its refreshed balance and username back when the user switches back to it', () => {
    const { storage, registry } = aliceThenBob()
    refreshed(storage, 'bob', 3)

    registry.switchTo('alice')
    expect(liveProfile(storage)).toMatchObject({ identityId: 'alice', balance: 7 })
    registry.switchTo('bob')
    expect(liveProfile(storage)).toMatchObject({ identityId: 'bob', balance: 3 })
  })

  it('never leaves one account’s profile live for another', () => {
    const storage = memoryStorage()
    const registry = createAccountRegistry(storage)
    signedInAs(storage, 'alice')
    registry.upsert('alice', { username: 'alice' })
    refreshed(storage, 'alice', 7)

    registry.switchTo(null)
    expect(liveProfile(storage)).toBeNull()
    storage.removeItem(SESSION_PROFILE_KEY)
    signedInAs(storage, 'bob')
    registry.upsert('bob', { username: 'bob' })
    expect(liveProfile(storage)).toBeNull()

    // Bob never refreshed: switching away from alice leaves nothing of hers live for him.
    registry.switchTo('alice')
    registry.switchTo('bob')
    expect(liveProfile(storage)).toBeNull()
  })

  it('drops a removed account’s profile stash', () => {
    const { storage, registry } = aliceThenBob()
    expect(storage.getItem('yappr_engine_stash:alice:profile')).not.toBeNull()

    registry.remove('alice', { live: false })
    expect(storage.getItem('yappr_engine_stash:alice:profile')).toBeNull()
    expect(registry.get('alice')).toBeUndefined()
  })
})
