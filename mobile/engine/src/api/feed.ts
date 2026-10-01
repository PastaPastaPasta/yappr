import { loadForYouFeed } from '@/lib/feed/load-for-you-feed'
import { postService } from '@/lib/services/post-service'
import { getCurrentUserId } from '@/lib/services/sdk-helpers'
import { toPostDTO, type Page, type PostDTO } from './dto'

/**
 * Feed reads. Each method is the engine-side twin of what a web page does on
 * load, calling the same lib functions, then mapping to DTOs. No query logic
 * lives here: topology differences stay in lib.
 */
export const feed = {
  /**
   * One For You page: lib's loader (composite page on v10, plain timeline on
   * v2), then the batch enrichment web's progressive pass performs (authors,
   * stats, viewer marks, quoted posts) in one awaited step.
   */
  async forYou(options: { cursor?: string | null } = {}): Promise<Page<PostDTO>> {
    const viewerId = getCurrentUserId()
    const page = await loadForYouFeed({
      startAfter: options.cursor ?? undefined,
      currentUserId: viewerId ?? undefined,
    })
    const posts = await postService.enrichPostsBatch(page.posts, page.preloaded)
    return { items: posts.map(post => toPostDTO(post, viewerId !== null)), cursor: page.cursor, hasMore: page.hasMore }
  },
}
