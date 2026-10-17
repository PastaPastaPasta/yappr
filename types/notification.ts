import type { Post } from './post'
import type { OrderStatus } from './store'
import type { User } from './user'

/**
 * Storefront events: a new order or a review for the seller, a status change
 * on an order for its buyer. `from` is the buyer (orders, reviews) or the
 * seller (status changes).
 */
export type StoreNotificationType = 'storeOrder' | 'storeReview' | 'itemReview' | 'orderStatus'

/**
 * What a store notification is about. Only public fields: an order's
 * contents are encrypted, so an order notification carries none of them.
 */
export interface StoreNotificationDetail {
  storeId?: string
  /** itemReview: the reviewed item, and its title when it could be read. */
  itemId?: string
  itemTitle?: string
  /** Reviews: the star rating, 1-5. */
  rating?: number
  /** orderStatus: the order's new status. */
  status?: OrderStatus
  /** A review's title or text, or the seller's note on a status change (public on chain). */
  text?: string
}

export interface Notification {
  id: string
  /** `quote` is v10 only: a quote with text of the user's post or reply (a bare quote is a `repost`). */
  type: 'follow' | 'mention' | 'like' | 'repost' | 'quote' | 'reply' | 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked' | 'blogPost' | 'blogComment' | StoreNotificationType
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
   * v11 aggregated like: the new likers read so far, `from` first. Blocking
   * one of them later drops just that liker (notification store).
   */
  likers?: User[]
  /**
   * v11 like: no like index keeps a like's time, so `createdAt` is when this
   * device noticed it — used for ordering only, never shown as a time.
   */
  timeless?: boolean
  /** Store notifications only. */
  store?: StoreNotificationDetail
}
