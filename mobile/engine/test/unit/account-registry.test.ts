import { describe, expect, it } from 'vitest'
import { SESSION_STORAGE_KEY, scopedKey } from '@/lib/storage-scope'
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

    // Signing in as alice again (a wallet sign-in during "Add account").
    signedInAs(storage, 'alice')
    registry.upsert('alice', { username: 'alice', method: 'key-exchange' })
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
})
