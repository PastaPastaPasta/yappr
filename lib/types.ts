export interface User {
  id: string
  documentId?: string  // The profile document $id (for updates)
  $revision?: number   // Document revision (for updates)
  username: string  // From DPNS - not stored in profile document
  displayName: string
  avatar: string // URL for display (DiceBear generated from user ID or custom URI)
  bio?: string
  location?: string
  website?: string
  followers: number
  following: number
  verified?: boolean
  joinedAt: Date
  // New unified profile fields
  bannerUri?: string
  paymentUris?: ParsedPaymentUri[]
  pronouns?: string
  nsfw?: boolean
  socialLinks?: SocialLink[]
  hasUnifiedProfile?: boolean  // true if migrated to new contract
  hasDpns?: boolean  // DPNS resolution state: undefined = loading, true = has DPNS, false = no DPNS
}

// Payment URI parsed from profile
export interface ParsedPaymentUri {
  scheme: string  // e.g., 'dash:', 'bitcoin:'
  uri: string     // Full URI e.g., 'dash:XnNh3...'
  label?: string  // Optional display label
}

// Social link from profile
export interface SocialLink {
  platform: string  // e.g., 'twitter', 'github'
  handle: string    // e.g., '@username' or 'username'
}

export interface Post {
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
  quotedPostId?: string // ID of quoted post (for fetching if quotedPost not populated)
  quotedPostOwnerId?: string // ID of quoted post owner (for notification queries)
  quotedPost?: Post
  tipInfo?: TipInfo     // Populated if this post is a tip (parsed from content)
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  repostedBy?: { id: string; username?: string; displayName?: string }  // If this is a repost, who reposted it
  repostTimestamp?: Date  // When the repost was created (for timeline sorting)
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
  parentId: string        // ID of post or reply being replied to
  parentOwnerId: string   // Owner of parent (for notifications)
  parentContent?: Post | Reply  // Lazy-loaded parent
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  // Private feed fields (present when reply is encrypted)
  encryptedContent?: Uint8Array
  epoch?: number
  nonce?: Uint8Array
}

/** Pre-fetched enrichment data to avoid N+1 queries in feed */
export interface PostEnrichment {
  authorIsBlocked: boolean
  authorIsFollowing: boolean
  authorAvatarUrl: string
}

/** Reply thread structure for threaded post display */
export interface ReplyThread {
  content: Reply                // The reply (could be nested)
  isAuthorThread: boolean       // true if same author as main post
  isThreadContinuation: boolean // true if continues previous author reply
  nestedReplies: ReplyThread[]  // 2nd level replies (depth limited)
}

// Tip metadata parsed from post content (format: tip:CREDITS\nmessage)
// NOTE: Amount is currently self-reported and unverified.
// TODO: Once SDK exposes transition IDs, format will become tip:CREDITS@TRANSITION_ID
// which will allow on-chain verification of tip amounts.
export interface TipInfo {
  amount: number        // Tip amount in credits (self-reported, unverified)
  message: string       // The tip message (content after the tip: line)
  transitionId?: string // Future: will be used for on-chain verification
}

export interface Media {
  id: string
  type: 'image' | 'video' | 'gif'
  url: string
  thumbnail?: string
  alt?: string
  width?: number
  height?: number
}

export interface Comment {
  id: string
  author: User
  content: string
  createdAt: Date
  likes: number
  liked?: boolean
  postId: string
}

export interface Notification {
  id: string
  type: 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked'
  from: User
  post?: Post
  createdAt: Date
  read: boolean
}

export interface Trend {
  topic: string
  posts: number
  category?: string
}

// V3 DM contract document types (raw from platform)
export interface ConversationInviteDocument {
  $id: string
  $ownerId: string  // sender
  $createdAt: number
  recipientId: Uint8Array  // 32 bytes
  conversationId: Uint8Array  // 10 bytes
  senderPubKey?: Uint8Array  // 33 bytes, optional (for hash160 identities)
}

export interface DirectMessageDocument {
  $id: string
  $ownerId: string  // sender
  $createdAt: number
  conversationId: Uint8Array  // 10 bytes
  encryptedContent: Uint8Array  // binary: [12 bytes IV | ciphertext], max 5KB
}

export interface ReadReceiptDocument {
  $id: string
  $ownerId: string  // reader (who owns this receipt)
  $createdAt: number
  $updatedAt: number  // v3: use this as "last read" timestamp
  $revision?: number
  conversationId: Uint8Array  // 10 bytes
}

// Decrypted message for UI display
export interface DirectMessage {
  id: string
  senderId: string
  recipientId: string
  conversationId: string  // base58 encoded
  content: string  // Decrypted content for display
  createdAt: Date
}

export interface Conversation {
  id: string  // conversationId (derived from participants)
  participantId: string  // The other participant (not current user)
  participantUsername?: string  // DPNS username if available
  participantDisplayName?: string  // Profile display name if available
  lastMessage?: DirectMessage | null
  unreadCount: number
  updatedAt: Date
}

// Query options for post service methods
export interface PostQueryOptions {
  /** Skip automatic enrichment - caller will handle enrichment manually */
  skipEnrichment?: boolean
}

// Block contract document types (enhanced blocking with bloom filters)
export interface BlockDocument {
  $id: string
  $ownerId: string // Who is doing the blocking
  $createdAt: number
  blockedId: string // Who is blocked (base58 format after transformation)
  message?: string // Optional public reason for blocking
}

export interface BlockFilterDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt: number
  $revision?: number
  filterData: Uint8Array // Serialized bloom filter (up to 5KB)
  itemCount: number // Number of items in the filter
  version: number // Bloom filter version for forward compatibility
}

export interface BlockFollowDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt: number
  $revision?: number
  followedBlockers: Uint8Array // Encoded array of user IDs (max 100 * 32 bytes)
}

// Parsed block follow data (after decoding followedBlockers)
export interface BlockFollowData {
  $id: string
  $ownerId: string
  $revision?: number
  followedUserIds: string[] // Decoded list of user IDs being followed
}

// DPNS Multi-Username Registration Types
export type UsernameStatus = 'pending' | 'checking' | 'available' | 'contested' | 'taken' | 'invalid'
export type RegistrationStep = 'username-entry' | 'checking' | 'review' | 'registering' | 'complete'

export interface UsernameEntry {
  id: string
  label: string
  status: UsernameStatus
  isContested: boolean
  validationError?: string
  registrationError?: string
  registered?: boolean
}

export interface UsernameCheckResult {
  available: boolean
  contested: boolean
  error?: string
}

export interface UsernameRegistrationResult {
  label: string
  success: boolean
  isContested: boolean
  error?: string
}