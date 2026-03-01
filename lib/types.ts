export * from '../types/user'
export * from '../types/post'
export * from '../types/store'
export * from '../types/notification'

import type { BlogThemeConfig } from '@/lib/blog/theme-types'

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

export interface Blog {
  id: string
  ownerId: string
  createdAt: Date
  updatedAt?: Date
  $revision?: number
  name: string
  description?: string
  headerImage?: string
  avatar?: string
  themeConfig?: BlogThemeConfig
  commentsEnabledDefault?: boolean
  labels?: string
}

export interface BlogPost {
  id: string
  ownerId: string
  createdAt: Date
  updatedAt?: Date
  $revision?: number
  blogId: string
  title: string
  subtitle?: string
  content: Record<string, unknown>[]
  compressedContent?: Uint8Array
  coverImage?: string
  labels?: string
  commentsEnabled?: boolean
  slug: string
  publishedAt?: number
}

export interface BlogComment {
  id: string
  ownerId: string
  createdAt: Date
  blogPostId: string
  blogPostOwnerId: string
  content: string
}
