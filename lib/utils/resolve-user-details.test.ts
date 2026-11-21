import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/services/identity-batch', () => ({
  loadIdentityBatch: async () => ({
    usernames: new Map([['with-profile', 'alice.dash'], ['name-only', 'bob.dash']]),
    profiles: [{ $ownerId: 'with-profile', displayName: 'Alice A.' }],
  }),
}))

import { resolveUserDetailsBatch } from './resolve-user-details'

describe('resolveUserDetailsBatch', () => {
  it('names an account by its profile, then its DPNS label, then its id', async () => {
    const details = await resolveUserDetailsBatch(['with-profile', 'name-only', 'nameless-abcdef'])
    expect(details.get('with-profile')).toEqual({ id: 'with-profile', username: 'alice.dash', displayName: 'Alice A.', hasDpns: true })
    expect(details.get('name-only')).toEqual({ id: 'name-only', username: 'bob.dash', displayName: 'bob', hasDpns: true })
    expect(details.get('nameless-abcdef')).toEqual({ id: 'nameless-abcdef', username: undefined, displayName: 'User abcdef', hasDpns: false })
  })
})
