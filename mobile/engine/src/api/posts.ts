import { postService } from '@/lib/services/post-service'
import { getCurrentUserId } from '@/lib/services/sdk-helpers'
import { toPostDTO, type PostDTO } from './dto'

export const posts = {
  /**
   * One post with its author, stats and quoted post. `null` when it does not
   * exist; lib's single-document read also reports a failed read as absent,
   * so a `null` can mean a transport failure.
   */
  async get(id: string): Promise<PostDTO | null> {
    const post = await postService.getPostById(id, { skipEnrichment: true })
    if (!post) return null
    const [enriched] = await postService.enrichPostsBatch([post])
    return toPostDTO(enriched ?? post, getCurrentUserId() !== null)
  },
}
