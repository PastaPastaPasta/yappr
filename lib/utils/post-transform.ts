import { identifierToBase58 } from '@/lib/services/sdk-helpers'

/**
 * Creates a default author object for display
 */
export function createDefaultAuthor(authorId: string, options?: {
  username?: string
  displayName?: string
  hasDpns?: boolean
}) {
  const id = authorId || 'unknown'
  return {
    id,
    username: options?.username || '',
    handle: options?.username || '',
    displayName: options?.displayName || `User ${id.slice(-6)}`,
    avatar: '',
    followers: 0,
    following: 0,
    verified: false,
    joinedAt: new Date(),
    hasDpns: options?.hasDpns ?? !!(options?.username && !options.username.startsWith('user_'))
  }
}

/**
 * Creates default post stats
 */
export function createDefaultPostStats() {
  return {
    likes: 0,
    replies: 0,
    reposts: 0,
    views: 0
  }
}

/**
 * Creates default post interaction state
 */
export function createDefaultPostInteractions() {
  return {
    liked: false,
    reposted: false,
    bookmarked: false
  }
}

interface RawSdkDocument {
  $id?: string
  id?: string
  $ownerId?: string
  ownerId?: string
  $createdAt?: number | string
  createdAt?: number | string
  data?: {
    content?: string
    replyToPostId?: string
    quotedPostId?: string
  }
  content?: string
  replyToPostId?: string
  quotedPostId?: string
}

/**
 * Transforms a raw SDK document to the UI post format
 * Used for "For You" feed which queries documents directly
 */
export function transformSdkDocumentToPost(doc: RawSdkDocument) {
  const data = doc.data || doc
  const authorId = doc.$ownerId || doc.ownerId || 'unknown'

  const rawReplyToId = data.replyToPostId || doc.replyToPostId
  const rawQuotedPostId = data.quotedPostId || doc.quotedPostId

  return {
    id: doc.$id || doc.id || Math.random().toString(36).substr(2, 9),
    content: data.content || 'No content',
    author: createDefaultAuthor(authorId),
    createdAt: new Date(doc.$createdAt || doc.createdAt || Date.now()),
    ...createDefaultPostStats(),
    ...createDefaultPostInteractions(),
    replyToId: rawReplyToId ? identifierToBase58(rawReplyToId) : undefined,
    quotedPostId: rawQuotedPostId ? identifierToBase58(rawQuotedPostId) : undefined
  }
}

interface ServicePost {
  id: string
  content?: string
  author?: {
    id?: string
    username?: string
    displayName?: string
  }
  createdAt?: Date | string
  likes?: number
  replies?: number
  reposts?: number
  views?: number
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
  replyToId?: string
  quotedPostId?: string
}

/**
 * Transforms a post from postService to the UI post format
 * Used for "Following" feed which uses the service layer
 */
export function transformServicePostToUiPost(post: ServicePost) {
  const authorId = post.author?.id || 'unknown'
  const username = post.author?.username || ''
  const hasDpns = !!(username && !username.startsWith('user_'))

  return {
    id: post.id,
    content: post.content || 'No content',
    author: createDefaultAuthor(authorId, {
      username,
      displayName: post.author?.displayName,
      hasDpns
    }),
    createdAt: post.createdAt || new Date(),
    likes: post.likes || 0,
    replies: post.replies || 0,
    reposts: post.reposts || 0,
    views: post.views || 0,
    liked: post.liked || false,
    reposted: post.reposted || false,
    bookmarked: post.bookmarked || false,
    replyToId: post.replyToId,
    quotedPostId: post.quotedPostId
  }
}

/**
 * Sorts posts by timestamp (using repostTimestamp if available)
 */
export function sortPostsByTimestamp<T extends { createdAt: Date | string; repostTimestamp?: Date }>(posts: T[]): T[] {
  return [...posts].sort((a, b) => {
    const aTime = a.repostTimestamp instanceof Date
      ? a.repostTimestamp.getTime()
      : a.createdAt instanceof Date
        ? a.createdAt.getTime()
        : new Date(a.createdAt).getTime()
    const bTime = b.repostTimestamp instanceof Date
      ? b.repostTimestamp.getTime()
      : b.createdAt instanceof Date
        ? b.createdAt.getTime()
        : new Date(b.createdAt).getTime()
    return bTime - aTime
  })
}
