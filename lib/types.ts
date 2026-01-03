export interface User {
  id: string
  username: string  // From DPNS - not stored in profile document
  displayName: string
  avatar: string // URL for display
  avatarId?: string  // Reference to avatar document (32-byte array as string)
  avatarData?: string // The encoded avatar string (16-128 chars)
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

export interface DirectMessage {
  id: string
  senderId: string
  recipientId: string
  conversationId: string
  content: string  // Decrypted content for display
  encryptedContent: string
  read: boolean
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