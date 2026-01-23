'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Post } from '@/lib/types'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, formatTime } from '@/lib/utils'
import { identifierToBytes } from '@/lib/services/sdk-helpers'
import { LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import { useAuth } from '@/contexts/auth-context'

// Icons as simple SVG components
function RetryIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  )
}

function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
      />
    </svg>
  )
}

function ThreadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 6h16M4 12h16m-7 6h7"
      />
    </svg>
  )
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
      />
    </svg>
  )
}

export interface PostingProgress {
  current: number
  total: number
  status: string
}

export type PostButtonState =
  | { type: 'posting-progress'; progress: PostingProgress }
  | { type: 'posting' }
  | { type: 'retry'; unpostedCount: number }
  | { type: 'reply' }
  | { type: 'thread'; postCount: number }
  | { type: 'post' }

interface PostButtonContentProps {
  state: PostButtonState
}

/**
 * Renders the appropriate content for the post button based on state.
 */
export function PostButtonContent({ state }: PostButtonContentProps) {
  switch (state.type) {
    case 'posting-progress':
      return (
        <span className="flex items-center gap-2">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
          <span>
            {state.progress.current}/{state.progress.total}
          </span>
        </span>
      )

    case 'posting':
      return (
        <span className="flex items-center gap-2">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
          <span>Posting</span>
        </span>
      )

    case 'retry':
      return (
        <span className="flex items-center gap-1.5">
          <RetryIcon className="w-4 h-4" />
          Retry ({state.unpostedCount})
        </span>
      )

    case 'reply':
      return (
        <span className="flex items-center gap-1.5">
          <ReplyIcon className="w-4 h-4" />
          Reply
        </span>
      )

    case 'thread':
      return (
        <span className="flex items-center gap-1.5">
          <ThreadIcon className="w-4 h-4" />
          Post all ({state.postCount})
        </span>
      )

    case 'post':
      return (
        <span className="flex items-center gap-1.5">
          <SendIcon className="w-4 h-4" />
          Post
        </span>
      )
  }
}

/**
 * Determines the post button state based on component state.
 */
export function getPostButtonState(
  isPosting: boolean,
  postingProgress: PostingProgress | null,
  hasPostedPosts: boolean,
  unpostedCount: number,
  isReply: boolean,
  threadPostCount: number
): PostButtonState {
  if (isPosting && postingProgress) {
    return { type: 'posting-progress', progress: postingProgress }
  }
  if (isPosting) {
    return { type: 'posting' }
  }
  if (hasPostedPosts) {
    return { type: 'retry', unpostedCount }
  }
  if (isReply) {
    return { type: 'reply' }
  }
  if (threadPostCount > 1) {
    return { type: 'thread', postCount: threadPostCount }
  }
  return { type: 'post' }
}

interface PostingProgressBarProps {
  progress: PostingProgress
}

/**
 * Shows posting progress with status message.
 */
export function PostingProgressBar({ progress }: PostingProgressBarProps) {
  const percentage = (progress.current / progress.total) * 100

  return (
    <div className="px-4 py-2 bg-yappr-50 dark:bg-yappr-950/30 border-b border-yappr-200 dark:border-yappr-800">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-yappr-500 rounded-full transition-all duration-300"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
        <span className="text-xs text-yappr-600 dark:text-yappr-400 font-medium whitespace-nowrap">
          {progress.status}
        </span>
      </div>
    </div>
  )
}

interface QuotedPostPreviewProps {
  post: Post
}

/**
 * Check if a post is private
 */
function isPrivatePost(post: Post): boolean {
  return !!(post.encryptedContent && post.epoch !== undefined && post.nonce)
}

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'decrypted'; content: string }
  | { status: 'locked' }
  | { status: 'error' }

/**
 * Shows a preview of the post being quoted.
 * PRD §5.3: Handles both public and private quoted posts.
 * For private posts, attempts decryption and shows locked state if unable.
 */
export function QuotedPostPreview({ post }: QuotedPostPreviewProps) {
  const { user } = useAuth()
  const [state, setState] = useState<DecryptionState>({ status: 'idle' })

  const isPrivate = isPrivatePost(post)
  const hasTeaser = post.content && post.content.length > 0

  // Attempt decryption for private posts
  const attemptDecryption = useCallback(async () => {
    if (!isPrivate) return

    if (!post.encryptedContent || post.epoch == null || !post.nonce) {
      setState({ status: 'error' })
      return
    }

    if (!user) {
      setState({ status: 'locked' })
      return
    }

    setState({ status: 'loading' })

    try {
      const { privateFeedFollowerService, privateFeedKeyStore, privateFeedCryptoService, MAX_EPOCH } = await import('@/lib/services')

      // For replies to private posts, we need to find the encryption source owner
      // (PRD §5.5 - inherited encryption)
      // The post.author.id is the reply author, but encryption may have been done
      // with a different user's CEK (the root private post owner)
      let encryptionSourceOwnerId = post.author.id

      if (post.replyToId) {
        // This is a reply - check if encryption was inherited from parent
        const { getEncryptionSource } = await import('@/lib/services/post-service')
        const encryptionSource = await getEncryptionSource(post.replyToId)
        if (encryptionSource) {
          // Encryption is inherited from parent thread
          encryptionSourceOwnerId = encryptionSource.ownerId
        }
      }

      // Check if user is the encryption source owner (can decrypt with their own feed keys)
      const isEncryptionSourceOwner = user.identityId === encryptionSourceOwnerId

      if (isEncryptionSourceOwner) {
        const feedSeed = privateFeedKeyStore.getFeedSeed()
        if (!feedSeed) {
          setState({ status: 'locked' })
          return
        }

        const cached = privateFeedKeyStore.getCachedCEK(encryptionSourceOwnerId)
        let cek: Uint8Array

        if (cached && cached.epoch === post.epoch) {
          cek = cached.cek
        } else if (cached && cached.epoch > post.epoch) {
          cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, post.epoch)
        } else {
          const chain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH)
          cek = chain[post.epoch]
        }

        const ownerIdBytes = identifierToBytes(encryptionSourceOwnerId)
        const decryptedContent = privateFeedCryptoService.decryptPostContent(
          cek,
          { ciphertext: post.encryptedContent, nonce: post.nonce, epoch: post.epoch },
          ownerIdBytes
        )

        setState({ status: 'decrypted', content: decryptedContent })
        return
      }

      const canDecrypt = await privateFeedFollowerService.canDecrypt(encryptionSourceOwnerId)
      if (!canDecrypt) {
        setState({ status: 'locked' })
        return
      }

      const result = await privateFeedFollowerService.decryptPost({
        encryptedContent: post.encryptedContent,
        epoch: post.epoch,
        nonce: post.nonce,
        $ownerId: encryptionSourceOwnerId,
      }, user?.identityId)

      if (result.success && result.content) {
        setState({ status: 'decrypted', content: result.content })
      } else {
        setState({ status: 'locked' })
      }
    } catch (error) {
      console.error('Error decrypting quoted post preview:', error)
      setState({ status: 'error' })
    }
  }, [isPrivate, post, user])

  // Reset state when post or user changes to avoid stale decryption data
  useEffect(() => {
    setState({ status: 'idle' })
  }, [post.id, user?.identityId])

  useEffect(() => {
    if (isPrivate && state.status === 'idle') {
      void attemptDecryption()
    }
  }, [isPrivate, state.status, attemptDecryption])

  // Get author display
  const authorDisplay = post.author.username && !post.author.username.startsWith('user_')
    ? `@${post.author.username}`
    : post.author.displayName !== 'Unknown User' && !post.author.displayName?.startsWith('User ')
      ? post.author.displayName
      : `${post.author.id.slice(0, 8)}...`

  // Public post - simple display
  if (!isPrivate) {
    return (
      <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50 dark:bg-neutral-950">
        <div className="flex items-center gap-2 text-sm">
          <Avatar className="h-5 w-5">
            <AvatarImage src={post.author.avatar} />
            <AvatarFallback>{getInitials(post.author.displayName)}</AvatarFallback>
          </Avatar>
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            {post.author.displayName}
          </span>
          <span className="text-gray-500">@{post.author.username}</span>
          <span className="text-gray-500">·</span>
          <span className="text-gray-500">{formatTime(post.createdAt)}</span>
        </div>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 line-clamp-3">
          {post.content}
        </p>
      </div>
    )
  }

  // Private post - loading state
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50 dark:bg-neutral-950">
        <div className="flex items-center gap-2 text-sm">
          <Avatar className="h-5 w-5">
            <AvatarImage src={post.author.avatar} />
            <AvatarFallback>{getInitials(post.author.displayName)}</AvatarFallback>
          </Avatar>
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            {post.author.displayName}
          </span>
          <span className="text-gray-500">{authorDisplay.startsWith('@') ? authorDisplay : ''}</span>
          <span className="text-gray-500">·</span>
          <span className="text-gray-500">{formatTime(post.createdAt)}</span>
          <LockClosedIcon className="h-3.5 w-3.5 text-gray-500" />
        </div>
        <div className="mt-2 flex items-center gap-2 text-gray-500">
          <LockOpenIcon className="h-4 w-4 animate-pulse" />
          <span className="text-sm">Decrypting...</span>
        </div>
        {hasTeaser && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
            {post.content}
          </p>
        )}
      </div>
    )
  }

  // Private post - decrypted state
  if (state.status === 'decrypted') {
    return (
      <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50 dark:bg-neutral-950">
        <div className="flex items-center gap-2 text-sm">
          <Avatar className="h-5 w-5">
            <AvatarImage src={post.author.avatar} />
            <AvatarFallback>{getInitials(post.author.displayName)}</AvatarFallback>
          </Avatar>
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            {post.author.displayName}
          </span>
          <span className="text-gray-500">{authorDisplay.startsWith('@') ? authorDisplay : ''}</span>
          <span className="text-gray-500">·</span>
          <span className="text-gray-500">{formatTime(post.createdAt)}</span>
          <LockClosedIcon className="h-3.5 w-3.5 text-gray-500" />
        </div>
        {hasTeaser && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
            {post.content}
          </p>
        )}
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300 line-clamp-3">
          {state.content}
        </p>
      </div>
    )
  }

  // Private post - locked/error state
  return (
    <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50 dark:bg-neutral-950">
      <div className="flex items-center gap-2 text-sm">
        <Avatar className="h-5 w-5">
          <AvatarImage src={post.author.avatar} />
          <AvatarFallback>{getInitials(post.author.displayName)}</AvatarFallback>
        </Avatar>
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          {post.author.displayName}
        </span>
        <span className="text-gray-500">{authorDisplay.startsWith('@') ? authorDisplay : ''}</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-500">{formatTime(post.createdAt)}</span>
        <LockClosedIcon className="h-3.5 w-3.5 text-gray-500" />
      </div>
      {hasTeaser && (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
          {post.content}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
        <LockClosedIconSolid className="h-4 w-4 text-gray-500" />
        <span className="text-sm text-gray-600 dark:text-gray-400">
          Private post from {authorDisplay}
        </span>
      </div>
    </div>
  )
}

interface ReplyContextProps {
  author: Post['author']
}

/**
 * Shows who the user is replying to.
 */
export function ReplyContext({ author }: ReplyContextProps) {
  const displayName = getAuthorDisplayName(author)

  return (
    <div className="px-4 py-3 bg-gray-50 dark:bg-neutral-950 border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">Replying to</span>
        <span className="text-yappr-500 font-medium">{displayName}</span>
      </div>
    </div>
  )
}

/**
 * Gets a display-friendly name for an author, preferring username over truncated ID.
 */
function getAuthorDisplayName(author: Post['author']): string {
  // Prefer username if it's meaningful (not a generated placeholder)
  if (author.username && !author.username.startsWith('user_')) {
    return `@${author.username}`
  }

  // Fall back to display name if meaningful
  if (
    author.displayName &&
    author.displayName !== 'Unknown User' &&
    !author.displayName.startsWith('User ')
  ) {
    return author.displayName
  }

  // Last resort: truncated identity ID
  return `${author.id.slice(0, 8)}...${author.id.slice(-6)}`
}

/**
 * Gets the modal title based on compose mode.
 */
export function getModalTitle(
  isReply: boolean,
  isQuote: boolean,
  threadCount: number
): string {
  if (isReply) return 'Reply'
  if (isQuote) return 'Quote'
  if (threadCount > 1) return `Thread (${threadCount} posts)`
  return 'New Post'
}

/**
 * Gets the accessibility title for the dialog.
 */
export function getDialogTitle(isReply: boolean, isQuote: boolean): string {
  if (isReply) return 'Reply to post'
  if (isQuote) return 'Quote post'
  return 'Create a new post'
}

/**
 * Gets the accessibility description for the dialog.
 */
export function getDialogDescription(isReply: boolean, isQuote: boolean): string {
  if (isReply) return 'Write your reply to the post'
  if (isQuote) return 'Add your thoughts to this quote'
  return 'Share your thoughts with the community'
}
