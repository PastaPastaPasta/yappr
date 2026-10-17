import { clearStoreViewCaches } from '@/lib/caches/store-view-cache'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { blogStatsService } from '@/lib/services/blog-stats-service'
import { storeStatsService } from '@/lib/services/store-stats-service'

/**
 * After a moderator removed or restored a document on `contract`: drop every
 * cached read that showed or counted it, so no view brings back what was
 * removed (or hides what came back). Each is re-read on demand.
 *
 * - storefront: the saved back-navigation store views and the rating
 *   aggregates (a removal record does not always name its store);
 * - blog: the comment and follower rankings ("Most discussed").
 *
 * Social keeps its own per-card handling (removed-post stubs, cache clears).
 */
export function forgetModeratedReads(contract: ModeratedContractKey): void {
  if (contract === 'storefront') {
    clearStoreViewCaches()
    storeStatsService.invalidateAll()
  } else if (contract === 'blog') {
    blogStatsService.invalidate()
  }
}
