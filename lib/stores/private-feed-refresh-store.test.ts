import { describe, expect, it } from 'vitest'
import { withoutRevokedGrants } from '@/lib/utils/revoked-grants'
import { usePrivateFeedRefreshStore } from './private-feed-refresh-store'

describe('revoked grants shared across the private feed cards (QA D-16)', () => {
  const grant = (recipientId: string, grantedAt: number) => ({ recipientId, grantedAt, leafIndex: 0 })

  it('hides a revoked grant from every reader of that owner, and refreshes them', () => {
    const store = usePrivateFeedRefreshStore.getState()
    const before = store.refreshKey
    store.markGrantRevoked('owner', 'a', 1000)

    const { refreshKey, revokedGrantsFor } = usePrivateFeedRefreshStore.getState()
    expect(refreshKey).toBe(before + 1)
    // The followers list and the dashboard/settings counts read the same mask.
    const stale = [grant('a', 1000), grant('b', 900)]
    expect(withoutRevokedGrants(stale, revokedGrantsFor('owner'))).toEqual([grant('b', 900)])
    expect(withoutRevokedGrants(stale, revokedGrantsFor('other-owner'))).toEqual(stale)
  })
})
