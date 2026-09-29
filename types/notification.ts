import type { Post } from './post'
import type { User } from './user'

export interface Notification {
  id: string
  /** `quote` is v10 only: a quote with text of the user's post or reply (a bare quote is a `repost`). */
  type: 'follow' | 'mention' | 'like' | 'repost' | 'quote' | 'reply' | 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked' | 'blogPost' | 'blogComment'
  from: User
  post?: Post
  createdAt: Date
  read: boolean
  blogId?: string
  blogPostSlug?: string
  /**
   * What the notification is ABOUT: a post or a reply. Only meaningful where the
   * two are distinguishable — the v9 topology separates `like` from `likeReply`
   * and gives replies an explicit thread root — and it only changes wording
   * ("liked your reply") and the link target.
   */
  targetKind?: 'post' | 'reply'
}
