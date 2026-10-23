import type { TargetKind } from '@/lib/contract-topology'
import type { OwnQuote } from '@/lib/feed/quote-reposts'
import type { ModerationMarks } from '@/lib/moderation-view'
import type { User } from './user'

/**
 * What the moderators did to a document (social v18, blog v10, storefront
 * v11): hidden (`mod`), with the charter reason, the member who did it and
 * when, and whether its author was restricted when they wrote it (`live: 2`).
 * Absent when neither applies.
 */
export interface PostModeration extends ModerationMarks {
  /** Written while its author was restricted (`live: 2`): not listed on yap.pr. */
  restricted?: boolean
}

export interface Media {
  id: string
  type: 'image' | 'video' | 'gif'
  url: string
  /**
   * v10: the posted image's sha256 (`mediaHash`) and dHash
   * (`mediaFingerprint`), so a reader can tell when the URL now serves a
   * different picture. Absent on v2/v9 documents.
   */
  hashes?: { mediaHash: Uint8Array; mediaFingerprint: Uint8Array }
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
  /** v10: the viewer has quoted OR reposted it (one slot per author and target). */
  reposted?: boolean
  bookmarked?: boolean
  /** v10: the viewer's own quote or bare repost of this post/reply, when `reposted`. */
  ownQuote?: OwnQuote
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
   * reference), and on v10 that they or its author deleted it. The card
   * renders the removed stub and fetches nothing.
   */
  quotedPostRemoved?: boolean
  /**
   * v18: the quoted post/reply is hidden by the moderators (`mod` set) and
   * this build does not show hidden content. The card renders the hidden
   * stub and fetches nothing.
   */
  quotedPostHidden?: boolean
  // Cross-contract embed (e.g. a Pollr poll). All three are set together.
  embedContractId?: string // base58 contract id the embedded document lives on
  embedDocType?: string    // document type name on that contract (e.g. 'poll')
  embedId?: string         // base58 id of the embedded document
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  repostedBy?: { id: string; username?: string; displayName?: string }  // If this is a repost, who reposted it
  repostTimestamp?: Date  // When the repost was created (for timeline sorting)
  repostedByOthers?: number  // v10 feed: further reposters of the same target collapsed into this card
  // Reply fields (present when this Post object represents a Reply for display)
  parentId?: string        // ID of post or reply being replied to (only on replies)
  parentOwnerId?: string   // Owner of parent (only on replies; '' on v14, which stores none)
  rootPostId?: string      // v9 replies: the post the whole thread hangs off
  rootOwnerId?: string     // v13 replies: the root post's owner (consensus-bound)
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
   * Devnet cuts only: the tags the post is indexed under, in its stored order
   * (lowercase, no '#'; `[]` = known untagged, `undefined` = unknown). One on
   * v9–v15 (`post.hashtag`), up to four on v16 (`post.tags`). Likes must
   * repeat them — consensus checks the agreement — so the like path reads
   * them off this field rather than re-parsing content. The chain stores
   * "untagged" as an absent property: the post transform and the write paths
   * translate at the boundary (see `inlineTags()` in lib/contract-topology).
   */
  tags?: string[]
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
  keyGeneration?: number         // Revocation key generation at post creation
  nonce?: Uint8Array             // Random nonce for encryption
  feed?: number                  // Which of the author's private feeds encrypted it (social v17)
  /** v18: hidden by the moderators or written while restricted; see {@link PostModeration}. */
  moderation?: PostModeration
  /** Which read of the document built this (`nextReadVersion`), copied along with it; see `isNewRead`. */
  readVersion?: number
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
  parentOwnerId: string   // Owner of parent (for notifications; '' on v14, which stores none)
  rootPostId?: string     // v9: the post the whole thread hangs off (required on chain)
  rootOwnerId?: string    // v13: the root post's owner (required on chain, `where`-bound to it)
  replyToReplyId?: string // v9: the reply this one is nested under, if any
  deleted?: boolean       // v9 tombstone marker (see Post.deleted)
  /** v10: a stand-in for a reply proved deleted, holding its children's place in the thread; never a real document. */
  deletedStub?: boolean
  /**
   * v18: a stand-in for a reply a default build does not list, keeping its children's place in the thread:
   * one the moderators hid, or one written while its author was restricted (the two are not told apart, so
   * the copy must not single out an account; e.g. "This reply isn't shown"). Carries no content or author;
   * never a real document. An archival build shows the reply itself, labelled from `moderation`.
   */
  hiddenStub?: boolean
  sensitive?: boolean     // author-declared NSFW flag (see Post.sensitive)
  parentContent?: Post | Reply  // Lazy-loaded parent
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  // Private feed fields (present when reply is encrypted)
  encryptedContent?: Uint8Array
  keyGeneration?: number
  nonce?: Uint8Array
  /** The feed that encrypted it: the root owner's for a reply in a private thread, else the replier's own */
  feed?: number
  /** v18: hidden by the moderators or written while restricted (see Post.moderation). */
  moderation?: PostModeration
  /** Which read of the document built this (see Post.readVersion). */
  readVersion?: number
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
