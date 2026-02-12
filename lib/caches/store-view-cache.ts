/**
 * SessionStorage-based cache for store view page state.
 * Enables scroll position restoration and instant back-button navigation
 * by caching loaded store data, items, reviews, and UI state.
 *
 * Follows the same pattern as block-cache.ts.
 */

import type { Store, StoreItem, StoreReview, StoreRatingSummary, StorePolicy } from '../types'

const CACHE_KEY_PREFIX = 'yappr_store_view_'
const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

export interface StoreViewCacheData {
  store: Store
  items: StoreItem[]
  reviews: StoreReview[]
  ratingSummary: StoreRatingSummary | null
  storePolicies: StorePolicy[]
  hasMoreItems: boolean
  lastCursor: string | undefined
  ownerDisplayName: string | null
  ownerUsername: string | null
  scrollY: number
  activeTab: 'items' | 'reviews' | 'policies'
  searchQuery: string
  categoryFilter: string
  sortField: 'newest' | 'title' | 'price'
  timestamp: number
}

function getCacheKey(storeId: string): string {
  return `${CACHE_KEY_PREFIX}${storeId}`
}

/**
 * Serialize Date objects to epoch milliseconds for JSON storage.
 */
function serializeForStorage(data: StoreViewCacheData): string {
  return JSON.stringify(data, (_key, value) => {
    if (value instanceof Date) {
      return { __date: value.getTime() }
    }
    return value
  })
}

/**
 * Reconstruct Date objects from epoch milliseconds after JSON parsing.
 */
function deserializeFromStorage(raw: string): StoreViewCacheData {
  return JSON.parse(raw, (_key, value) => {
    if (value && typeof value === 'object' && '__date' in value) {
      return new Date(value.__date)
    }
    return value
  }) as StoreViewCacheData
}

/**
 * Save store view state to sessionStorage.
 */
export function saveStoreViewCache(storeId: string, data: StoreViewCacheData): void {
  if (typeof window === 'undefined') return

  try {
    const key = getCacheKey(storeId)
    sessionStorage.setItem(key, serializeForStorage(data))
  } catch {
    // SessionStorage full or unavailable - fail silently
  }
}

/**
 * Load store view state from sessionStorage.
 * Returns null if cache is stale or doesn't exist.
 */
export function loadStoreViewCache(storeId: string): StoreViewCacheData | null {
  if (typeof window === 'undefined') return null

  try {
    const key = getCacheKey(storeId)
    const raw = sessionStorage.getItem(key)
    if (!raw) return null

    const data = deserializeFromStorage(raw)

    // Check if cache is stale
    if (Date.now() - data.timestamp > CACHE_TTL) {
      sessionStorage.removeItem(key)
      return null
    }

    return data
  } catch {
    return null
  }
}

/**
 * Remove cached store view state.
 */
export function invalidateStoreViewCache(storeId: string): void {
  if (typeof window === 'undefined') return

  const key = getCacheKey(storeId)
  sessionStorage.removeItem(key)
}
