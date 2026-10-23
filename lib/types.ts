export * from '../types/user'
export * from '../types/post'
export * from '../types/store'
export * from '../types/notification'

import type { BlogThemeConfig } from '@/lib/blog/theme-types'
import type { ModerationMarks } from '@/lib/moderation-view'

// V3 DM contract document types (raw from platform)
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
  /** Sent and not settled yet (`registered` is false): "Check again" continues it. */
  pending?: boolean
}

export interface UsernameCheckResult {
  available: boolean
  contested: boolean
  error?: string
}

export interface UsernameRegistrationResult {
  label: string
  success: boolean
  /** Sent and not settled yet: checking again continues it and pays nothing twice. */
  pending?: boolean
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
  labels?: string[]
  /** Blog v10: hidden by the blog's moderators (`mod`), with the reason, who and when. */
  moderation?: ModerationMarks
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
  coverImage?: string
  labels?: string[]
  commentsEnabled?: boolean
  slug: string
  publishedAt?: number
  /** Blog v7: the author deleted this post; only blogId, slug and publishedAt remain (a tombstone). */
  deleted?: boolean
  /** The stored `live` marker: `true` on v9, the lane on v10 (1 listed, 2 written while restricted); absent on a tombstone. */
  live?: number | boolean
  /** Blog v10: hidden by the blog's moderators (`mod`), with the reason, who and when. */
  moderation?: ModerationMarks
}

export interface BlogComment {
  id: string
  ownerId: string
  createdAt: Date
  blogPostId: string
  /** The post owner a v2–v5 comment copies; absent on v6, which derives it through `blogPostId`. */
  blogPostOwnerId?: string
  content: string
  /** Blog v10: hidden by the blog's moderators (`mod`), with the reason, who and when. */
  moderation?: ModerationMarks
}

export interface BlogPostWithAuthor extends BlogPost {
  authorUsername?: string
  authorDisplayName?: string
  blogName?: string
}

export interface BlogFollow {
  id: string
  ownerId: string
  blogId: string
  createdAt: Date
}
