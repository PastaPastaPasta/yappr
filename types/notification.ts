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
  /**
   * v11 aggregated like: how many new likers this notification stands for
   * (`from` is the first of them) — "Alice and 3 others liked your post".
   */
  likerCount?: number
  /**
   * v11 like: no like index keeps a like's time, so `createdAt` is when this
   * device noticed it — used for ordering only, never shown as a time.
   */
  timeless?: boolean
}
