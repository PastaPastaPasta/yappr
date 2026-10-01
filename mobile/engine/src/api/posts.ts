import { isBareRepost, quotedTargetIdOf } from '@/lib/feed/quote-reposts'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { getCurrentUserId } from '@/lib/services/sdk-helpers'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import type { Post } from '@/lib/types'
import { toPostDTO, type PostDTO } from './dto'

/** A post, or a reply as a Post, the way web's post page looks an id up. */
async function load(id: string): Promise<Post | null> {
  const post = await postService.getPostById(id, { skipEnrichment: true })
  if (post) return post
  // Replies are a separate doctype; web's usePostDetail falls back the same way.
  const reply = await replyService.getReplyById(id, { skipEnrichment: true })
  return reply ? replyToPost(reply) : null
}

export const posts = {
  /**
   * One post or reply with its author, stats and quoted post. A v10 bare
   * repost resolves to its target, as web's post page redirects to it.
   * `null` when nothing exists under the id; lib's single-document reads also
   * report a failed read as absent, so a `null` can mean a transport failure.
   */
  async get(id: string): Promise<PostDTO | null> {
    let post = await load(id)
    const target = post && isBareRepost(post) ? quotedTargetIdOf(post) : undefined
    if (target && target !== id) post = await load(target)
    if (!post) return null
    // The document arrives with a placeholder author ("Unknown User", hasDpns
    // false). Reset it to the loading shape, as lib's withLoadingAuthor does
    // for feeds, so a failed enrichment reads as unresolved, not as a name.
    post = { ...post, author: { ...post.author, username: '', displayName: '', avatar: '', hasDpns: undefined } }
    const [enriched] = await postService.enrichPostsBatch([post])
    return toPostDTO(enriched ?? post, {
      signedIn: getCurrentUserId() !== null,
      defaultAvatarUrl: authorId => unifiedProfileService.getDefaultAvatarUrl(authorId),
    })
  },
}
