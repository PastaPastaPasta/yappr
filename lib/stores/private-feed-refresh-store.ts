'use client'

import { create } from 'zustand'

const NO_REVOKED_GRANTS: ReadonlyMap<string, number> = new Map()

interface PrivateFeedRefreshStore {
  /** Incremented whenever data changes that requires sibling components to refresh */
  refreshKey: number
  /**
   * Grants revoked in this session, per feed owner: follower ID to the
   * `$createdAt` of the revoked grant. A revocation that succeeded can still
   * read back its grant for a moment (slow node, or a grant delete that failed
   * after the rekey); every card hides it the same way (see withoutRevokedGrants).
   */
  revokedGrants: ReadonlyMap<string, ReadonlyMap<string, number>>
  /** Trigger a refresh of all private feed related components */
  triggerRefresh: () => void
  /** Record a successful revocation and refresh the sibling cards */
  markGrantRevoked: (ownerId: string, followerId: string, grantedAt: number) => void
  revokedGrantsFor: (ownerId: string) => ReadonlyMap<string, number>
}

/**
 * Simple store to coordinate refreshes between private feed components.
 * When one component makes a change (e.g., approving a follower), it calls
 * triggerRefresh() and other components listening to refreshKey will reload.
 */
export const usePrivateFeedRefreshStore = create<PrivateFeedRefreshStore>((set, get) => ({
  refreshKey: 0,
  revokedGrants: new Map(),
  triggerRefresh: () => set((state) => ({ refreshKey: state.refreshKey + 1 })),
  markGrantRevoked: (ownerId, followerId, grantedAt) => set((state) => {
    const revokedGrants = new Map(state.revokedGrants)
    revokedGrants.set(ownerId, new Map(state.revokedGrants.get(ownerId)).set(followerId, grantedAt))
    return { revokedGrants, refreshKey: state.refreshKey + 1 }
  }),
  revokedGrantsFor: (ownerId) => get().revokedGrants.get(ownerId) ?? NO_REVOKED_GRANTS,
}))
