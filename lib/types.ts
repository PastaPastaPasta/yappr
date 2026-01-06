export interface User {
  id: string
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