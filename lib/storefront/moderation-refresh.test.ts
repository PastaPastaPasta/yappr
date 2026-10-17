/**
 * A storefront moderator's removal (or restore) must not be undone by a saved
 * read: the store page restores its back-navigation view from sessionStorage
 * without asking Platform, and ratings come from a cached aggregate. Both are
 * dropped (#775 review).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = new Map<string, string>()
vi.stubGlobal('window', {})
vi.stubGlobal('sessionStorage', {
  getItem: (key: string) => session.get(key) ?? null,
  setItem: (key: string, value: string) => { session.set(key, value) },
  removeItem: (key: string) => { session.delete(key) },
  key: (index: number) => Array.from(session.keys())[index] ?? null,
  get length() { return session.size },
})

const stats = vi.hoisted(() => ({ invalidateAll: vi.fn() }))
vi.mock('@/lib/services/store-stats-service', () => ({ storeStatsService: stats }))

import { loadStoreViewCache, saveStoreViewCache, type StoreViewCacheData } from '@/lib/caches/store-view-cache'
import { forgetStorefrontReads } from './moderation-refresh'

const view = (storeId: string) => ({
  store: { id: storeId },
  items: [],
  reviews: [{ id: `review-of-${storeId}` }],
  ratingSummary: { averageRating: 5, reviewCount: 1 },
  timestamp: Date.now(),
}) as unknown as StoreViewCacheData

beforeEach(() => {
  session.clear()
  stats.invalidateAll.mockReset()
})

describe('after storefront moderation', () => {
  it('no saved store view comes back, for any store, and the rating aggregates are re-read', () => {
    saveStoreViewCache('S1', view('S1'))
    saveStoreViewCache('S2', view('S2'))
    session.set('unrelated', 'kept')
    expect(loadStoreViewCache('S1')?.reviews).toHaveLength(1)

    forgetStorefrontReads()

    expect(loadStoreViewCache('S1')).toBeNull()
    expect(loadStoreViewCache('S2')).toBeNull()
    expect(session.get('unrelated')).toBe('kept')
    expect(stats.invalidateAll).toHaveBeenCalledTimes(1)
  })
})
