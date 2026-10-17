/**
 * A moderator's removal (or restore) must not be undone by a cached read: the
 * store page restores its back-navigation view from sessionStorage without
 * asking Platform, ratings come from a cached aggregate, and blog rankings
 * ("Most discussed") are cached too. Each is dropped (#775 review).
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
const blogStats = vi.hoisted(() => ({ invalidate: vi.fn() }))
vi.mock('@/lib/services/store-stats-service', () => ({ storeStatsService: stats }))
vi.mock('@/lib/services/blog-stats-service', () => ({ blogStatsService: blogStats }))

import { loadStoreViewCache, saveStoreViewCache, type StoreViewCacheData } from '@/lib/caches/store-view-cache'
import { forgetModeratedReads } from './moderation-refresh'

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
  blogStats.invalidate.mockReset()
})

describe('after moderation', () => {
  it('no saved store view comes back, for any store, and the rating aggregates are re-read', () => {
    saveStoreViewCache('S1', view('S1'))
    saveStoreViewCache('S2', view('S2'))
    session.set('unrelated', 'kept')
    expect(loadStoreViewCache('S1')?.reviews).toHaveLength(1)

    forgetModeratedReads('storefront')

    expect(loadStoreViewCache('S1')).toBeNull()
    expect(loadStoreViewCache('S2')).toBeNull()
    expect(session.get('unrelated')).toBe('kept')
    expect(stats.invalidateAll).toHaveBeenCalledTimes(1)
    expect(blogStats.invalidate).not.toHaveBeenCalled()
  })

  it('a blog removal or restore drops the cached blog rankings, and touches no store view', () => {
    saveStoreViewCache('S1', view('S1'))
    forgetModeratedReads('blog')
    expect(blogStats.invalidate).toHaveBeenCalledTimes(1)
    expect(stats.invalidateAll).not.toHaveBeenCalled()
    expect(loadStoreViewCache('S1')).not.toBeNull()
  })
})
