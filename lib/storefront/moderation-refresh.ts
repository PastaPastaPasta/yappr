import { clearStoreViewCaches } from '@/lib/caches/store-view-cache'
import { storeStatsService } from '@/lib/services/store-stats-service'

/**
 * After a storefront moderator removed or restored a store, listing or
 * review: drop every read that showed or counted it, so no view brings back
 * what was removed (or hides what came back). The saved back-navigation store
 * views and the cached rating aggregates both go; each is re-read on demand.
 */
export function forgetStorefrontReads(): void {
  clearStoreViewCaches()
  storeStatsService.invalidateAll()
}
