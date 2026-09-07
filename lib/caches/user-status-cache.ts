/**
 * Viewer-scoped relation caches shared between the per-row hooks (useFollow,
 * useBlock, useBlogFollow) and the batch enrichers that pre-populate them
 * before those hooks mount.
 */

import { StatusCache } from './status-cache'

const STATUS_TTL = 2 * 60 * 1000

export const followStatusCache = new StatusCache(STATUS_TTL)
export const blockStatusCache = new StatusCache(STATUS_TTL)
export const blogFollowStatusCache = new StatusCache(STATUS_TTL)

// Private feed request status cache
// Tracks pending requests by ownerId so all posts from the same author show consistent state
export type PrivateFeedRequestStatus = 'none' | 'pending' | 'loading' | 'error'

const privateFeedRequestCache = new Map<string, { status: PrivateFeedRequestStatus; timestamp: number }>()
const privateFeedRequestListeners = new Set<() => void>()

export function getPrivateFeedRequestStatus(cacheKey: string): PrivateFeedRequestStatus | null {
  const cached = privateFeedRequestCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < STATUS_TTL) {
    return cached.status
  }
  return null
}

export function setPrivateFeedRequestStatus(cacheKey: string, status: PrivateFeedRequestStatus): void {
  privateFeedRequestCache.set(cacheKey, { status, timestamp: Date.now() })
  // Notify all listeners that status changed
  privateFeedRequestListeners.forEach(listener => listener())
}

export function deletePrivateFeedRequestStatus(cacheKey: string): void {
  privateFeedRequestCache.delete(cacheKey)
  privateFeedRequestListeners.forEach(listener => listener())
}

/**
 * Subscribe to private feed request status changes.
 * Returns an unsubscribe function.
 */
export function subscribeToPrivateFeedRequestStatus(listener: () => void): () => void {
  privateFeedRequestListeners.add(listener)
  return () => {
    privateFeedRequestListeners.delete(listener)
  }
}
