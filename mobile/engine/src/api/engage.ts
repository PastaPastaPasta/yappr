import type { KindedTarget } from '@/lib/contract-topology'
import { postService } from '@/lib/services/post-service'
import { assertAtMost, viewerId } from '../dto/hydrate'
import type { EngageStatsDTO } from './dto'

/**
 * Engagement reads (`hooks/use-post-engagement.ts`). The writes (like,
 * repost, bookmark) and `bookmarks` belong to M7b and join this module.
 */
export const engage = {
  /**
   * Fresh counts for up to 100 posts or replies (`getBatchPostStats`) and,
   * signed in, the viewer's marks (`getBatchUserInteractions`). Pass a
   * reply's `rootPostId` where known: v10 counts a reply's replies under its root.
   *
   * lib's batch stats read reports a failure as zero counts, not an error, so
   * these are advisory: never let them lower counts already on screen to 0.
   */
  async stats(targets: KindedTarget[]): Promise<Record<string, EngageStatsDTO>> {
    assertAtMost(targets, 100, 'targets')
    const signedIn = viewerId() !== null
    const [stats, marks] = await Promise.all([
      postService.getBatchPostStats(targets),
      signedIn ? postService.getBatchUserInteractions(targets) : undefined,
    ])
    return Object.fromEntries(targets.map(({ id }) => {
      const counts = stats.get(id)
      const mark = marks?.get(id)
      const entry: EngageStatsDTO = {
        stats: { likes: counts?.likes ?? 0, reposts: counts?.reposts ?? 0, replies: counts?.replies ?? 0, quotes: counts?.quotes ?? 0 },
      }
      if (signedIn) {
        entry.viewer = { liked: mark?.liked === true, reposted: mark?.reposted === true, bookmarked: mark?.bookmarked === true, ownQuoteId: mark?.ownQuote?.id ?? null }
      }
      return [id, entry]
    }))
  },
}
