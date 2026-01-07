export interface User {
  id: string
  documentId?: string  // The profile document $id (for updates)
  $revision?: number   // Document revision (for updates)
  username: string  // From DPNS - not stored in profile document
  displayName: string
  avatar: string // URL for display (DiceBear generated from user ID)
  bio?: string
  location?: string
  website?: string
  followers: number
  following: number
  verified?: boolean
  joinedAt: Date
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
  replyToId?: string    // ID of parent post (for fetching if replyTo not populated)
  replyTo?: Post
  quotedPostId?: string // ID of quoted post (for fetching if quotedPost not populated)
  quotedPost?: Post
  tipInfo?: TipInfo     // Populated if this post is a tip (parsed from content)
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
}

/** Pre-fetched enrichment data to avoid N+1 queries in feed */
export interface PostEnrichment {
  authorIsBlocked: boolean
  authorIsFollowing: boolean
  authorAvatarUrl: string
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
  type: 'like' | 'repost' | 'follow' | 'reply' | 'mention'
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

// V2 DM contract document types (raw from platform)
export interface ConversationInviteDocument {
  $id: string
  $ownerId: string  // sender
  $createdAt: number
  recipientId: Uint8Array  // 32 bytes
  conversationId: Uint8Array  // 8 bytes
  senderPubKey?: Uint8Array  // 33 bytes, optional (for hash160 identities)
}

export interface DirectMessageDocument {
  $id: string
  $ownerId: string  // sender
  $createdAt: number
  conversationId: Uint8Array  // 8 bytes
  encryptedContent: Uint8Array  // binary: [12 bytes IV | ciphertext]
}

export interface ReadReceiptDocument {
  $id: string
  $ownerId: string  // reader (who owns this receipt)
  $createdAt: number
  $updatedAt: number
  $revision?: number
  conversationId: Uint8Array  // 8 bytes
  lastReadAt: number  // timestamp
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
  lastMessage?: DirectMessage | null
  unreadCount: number
  updatedAt: Date
}

// Query options for post service methods
export interface PostQueryOptions {
  /** Skip automatic enrichment - caller will handle enrichment manually */
  skipEnrichment?: boolean
}