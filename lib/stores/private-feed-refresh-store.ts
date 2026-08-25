'use client'

import { create } from 'zustand'

interface PrivateFeedRefreshStore {
  /** Incremented whenever data changes that requires sibling components to refresh */
  refreshKey: number
  /** Trigger a refresh of all private feed related components */
  triggerRefresh: () => void
}

/**
 * Simple store to coordinate refreshes between private feed components.
 * When one component makes a change (e.g., approving a follower), it calls
 * triggerRefresh() and other components listening to refreshKey will reload.
 */
export const usePrivateFeedRefreshStore = create<PrivateFeedRefreshStore>((set) => ({
  refreshKey: 0,
  triggerRefresh: () => set((state) => ({ refreshKey: state.refreshKey + 1 })),
}))
