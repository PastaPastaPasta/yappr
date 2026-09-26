import type { TargetKind } from '@/lib/contract-topology'
import type { User } from './user'

export interface Media {
  id: string
  type: 'image' | 'video' | 'gif'
  url: string
  thumbnail?: string
  alt?: string
  width?: number
  height?: number
}

/** Pre-fetched enrichment data to avoid N+1 queries in feed */
export interface PostEnrichment {
  authorIsBlocked: boolean
  authorIsFollowing: boolean
  authorAvatarUrl: string
}

export interface Post {
  id: string
  /**
   * Which document type this object is really backed by. PostCard renders posts
   * and replies through the same shape, and on the v9 topology the two address
   * different interaction doctypes — so anything that reads or writes
   * engagements has to know which it is holding. Unset means `post`; see
   * `targetKindOf()`.
   */
  targetKind?: TargetKind
  author: User
  content: string
  createdAt: Date
  likes: number
  reposts: number
  replies: number
  quotes: number
  views: number
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
  media?: Media[]
  quotedPostId?: string // ID of quoted post (for fetching if quotedPost not populated)
  quotedPostOwnerId?: string // ID of quoted post owner (for notification queries)
  /**
   * ID of a quoted REPLY. The v9 topology splits quoting in two so each field can
   * be `refersTo`-checked against exactly one document type; only one of
   * `quotedPostId`/`quotedReplyId` is ever written.
   */
  quotedReplyId?: string
  quotedPost?: Post
  /**
   * True when the quoted post/reply is PROVEN ABSENT: a composite by-id join
   * listed its id in `missingIds`, which on a v9 contract means the contract's
   * moderators removed it (every reference at post/reply is a deletableDocument
   * reference). The card renders the removed stub and fetches nothing.
   */
  quotedPostRemoved?: boolean
  // Cross-contract embed (e.g. a Pollr poll). All three are set together.
  embedContractId?: string // base58 contract id the embedded document lives on
  embedDocType?: string    // document type name on that contract (e.g. 'poll')
  embedId?: string         // base58 id of the embedded document
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  repostedBy?: { id: string; username?: string; displayName?: string }  // If this is a repost, who reposted it
  repostTimestamp?: Date  // When the repost was created (for timeline sorting)
  // Reply fields (present when this Post object represents a Reply for display)
  parentId?: string        // ID of post or reply being replied to (only on replies)
  parentOwnerId?: string   // Owner of parent (only on replies)
  rootPostId?: string      // v9 replies: the post the whole thread hangs off
  replyToReplyId?: string  // v9 replies: the reply this one is nested under
  /**
   * True on a tombstone — a v9 post/reply whose author "deleted" it. The document
   * is permanent (`canBeDeleted: false`), so deleting blanks the content and sets
   * this flag instead of removing anything.
   */
  deleted?: boolean
  /**
   * Author-declared sensitive/NSFW flag. A flagged thread carries it on the
   * root post and on every continuation reply; a reply to someone else's post
   * is never flagged.
   */
  sensitive?: boolean
  /**
   * v9 only: the post's single indexed hashtag (lowercase, no '#'; `''` =
   * known untagged, `undefined` = unknown). Likes must repeat it — consensus
   * checks the agreement — so the like path reads it off this field rather
   * than re-parsing content. The chain stores "untagged" as an absent
   * property: the post transform and the write paths translate at the
   * boundary (see `hashtagsAreInline()` in lib/contract-topology).
   */
  hashtag?: string
  // Blog quote fields (present when this Post represents a quoted blog post)
  __isBlogPostQuote?: boolean
  title?: string
  subtitle?: string
  slug?: string
  coverImage?: string
  blogId?: string
  blogName?: string
  blogUsername?: string
  blogContent?: unknown
  // Private feed fields (present when post is encrypted)
  encryptedContent?: Uint8Array  // XChaCha20-Poly1305 ciphertext
  epoch?: number                 // Revocation epoch at post creation
  nonce?: Uint8Array             // Random nonce for encryption
}

/** A reply to a post or another reply */
export interface Reply {
  id: string
  author: User
  content: string
  createdAt: Date
  likes: number
  reposts: number
  replies: number
  views: number
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
  media?: Media[]
  parentId: string        // ID of post or reply being replied to (v9: the direct one, derived)
  parentOwnerId: string   // Owner of parent (for notifications)
  rootPostId?: string     // v9: the post the whole thread hangs off (required on chain)
  replyToReplyId?: string // v9: the reply this one is nested under, if any
  deleted?: boolean       // v9 tombstone marker (see Post.deleted)
  sensitive?: boolean     // author-declared NSFW flag (see Post.sensitive)
  parentContent?: Post | Reply  // Lazy-loaded parent
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  // Private feed fields (present when reply is encrypted)
  encryptedContent?: Uint8Array
  epoch?: number
  nonce?: Uint8Array
}

/** Reply thread structure for threaded post display */
export interface ReplyThread {
  content: Reply                // The reply (could be nested)
  isAuthorThread: boolean       // true if same author as main post
  isThreadContinuation: boolean // true if continues previous author reply
  nestedReplies: ReplyThread[]  // deeper replies, capped at MAX_NESTED_DEPTH levels
  hiddenReplyCount?: number     // known descendants past the depth cap (reachable via "Continue thread")
}

// Query options for post service methods
export interface PostQueryOptions {
  /** Skip automatic enrichment - caller will handle enrichment manually */
  skipEnrichment?: boolean
}
