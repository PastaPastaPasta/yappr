import { postsHaveLanguage } from '@/lib/contract-topology'
import { enrichPostsWithRepostsAndQuotes } from '@/lib/feed/enrich-posts'
import { loadForYouFeed } from '@/lib/feed/load-for-you-feed'
import { sortFeedByTimestamp } from '@/lib/feed/transform-raw-post'
import { postService } from '@/lib/services/post-service'
import { getCurrentUserId } from '@/lib/services/sdk-helpers'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { useSettingsStore } from '@/lib/store'
import { toPostDTO, type Page, type PostDTO } from './dto'

/**
 * Feed reads: the engine-side twins of what web's feed page does, calling the
 * same lib functions, then mapping to DTOs. Topology differences stay in lib.
 */
export const feed = {
  /**
   * One For You page, as web's useFeedData loads it: `loadForYouFeed` with
   * the persisted feed language (where the topology has languages), sorted by
   * feed timestamp, then the enrichment web runs progressively, awaited here
   * in one step: `enrichPostsBatch` (authors, stats, viewer marks, block and
   * follow status, quoted posts) and `enrichPostsWithRepostsAndQuotes`
   * (repost attribution, remaining quotes; drops tombstones).
   *
   * Not mirrored: web's page cache, new-post polling and pending-post merge,
   * which belong to the host.
   */
  async forYou(options: { cursor?: string | null } = {}): Promise<Page<PostDTO>> {
    const viewerId = getCurrentUserId()
    const page = await loadForYouFeed({
      startAfter: options.cursor ?? undefined,
      feedLanguage: postsHaveLanguage() ? useSettingsStore.getState().feedLanguage : undefined,
      currentUserId: viewerId ?? undefined,
    })
    const enriched = await postService.enrichPostsBatch(sortFeedByTimestamp(page.posts), page.preloaded)
    const posts = await enrichPostsWithRepostsAndQuotes(enriched)
    const mapping = { signedIn: viewerId !== null, defaultAvatarUrl: (id: string) => unifiedProfileService.getDefaultAvatarUrl(id) }
    return {
      items: posts.map(post => toPostDTO(post, mapping)),
      cursor: page.cursor,
      hasMore: page.hasMore,
    }
  },
}
