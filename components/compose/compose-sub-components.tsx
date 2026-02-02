'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Post } from '@/lib/types'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, formatTime } from '@/lib/utils'
import { identifierToBytes } from '@/lib/services/sdk-helpers'
import { LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import { useAuth } from '@/contexts/auth-context'
import { isPrivatePost } from '@/components/post/private-post-content'

// Formatting button for the compose toolbar
interface FormatButtonProps {
  onClick: () => void
  title: string
  children: React.ReactNode
  disabled?: boolean
}

export function FormatButton({ onClick, title, children, disabled = false }: FormatButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  )
}

// Character counter with visual progress indicator
interface CharacterCounterProps {
  current: number
  limit: number
}

export function CharacterCounter({ current, limit }: CharacterCounterProps) {
  const remaining = limit - current
  const percentage = Math.min((current / limit) * 100, 100)
  const isWarning = remaining <= 50 && remaining > 20
  const isDanger = remaining <= 20
  const isValid = current > 0 && current <= limit

  const radius = 10
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - percentage / 100)

  function getProgressColor(): string {
    if (isDanger) return 'text-red-500'
    if (isWarning) return 'text-amber-500'
    return 'text-yappr-500'
  }

  if (current === 0) {
    return <div className="flex items-center gap-2" />
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative w-6 h-6">
        <svg className="w-6 h-6 -rotate-90" viewBox="0 0 24 24">
          {/* Background circle */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-gray-200 dark:text-gray-700"
          />
          {/* Progress circle */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className={getProgressColor()}
          />
        </svg>
        {/* Checkmark when valid and not in danger zone */}
        {isValid && !isDanger && !isWarning && (
          <div className="absolute inset-0 flex items-center justify-center">
            <svg className="w-3 h-3 text-yappr-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </div>
      {isDanger && (
        <span
          className={`text-xs font-medium tabular-nums ${
            remaining < 0 ? 'text-red-500' : 'text-amber-500'
          }`}
        >
          {remaining}
        </span>
      )}
    </div>
  )
}

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

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'decrypted'; content: string }
  | { status: 'locked' }
  | { status: 'error' }

// Shared header component for post previews
interface PostPreviewHeaderProps {
  author: Post['author']
  createdAt: Date
  showLockIcon?: boolean
  /** For private posts, show truncated username for non-@prefixed displays */
  authorDisplayOverride?: string
}

function PostPreviewHeader({ author, createdAt, showLockIcon, authorDisplayOverride }: PostPreviewHeaderProps) {
  const usernameDisplay = authorDisplayOverride?.startsWith('@') ? authorDisplayOverride : `@${author.username}`

  return (
    <div className="flex items-center gap-2 text-sm">
      <Avatar className="h-5 w-5">
        <AvatarImage src={author.avatar} />
        <AvatarFallback>{getInitials(author.displayName)}</AvatarFallback>
      </Avatar>
      <span className="font-semibold text-gray-900 dark:text-gray-100">
        {author.displayName}
      </span>
      <span className="text-gray-500">{usernameDisplay}</span>
      <span className="text-gray-500">·</span>
      <span className="text-gray-500">{formatTime(createdAt)}</span>
      {showLockIcon && <LockClosedIcon className="h-3.5 w-3.5 text-gray-500" />}
    </div>
  )
}

// Container wrapper for quoted post previews
function QuotedPostContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50 dark:bg-neutral-950">
      {children}
    </div>
  )
}

/**
 * Shows a preview of the post being quoted.
 * PRD 5.3: Handles both public and private quoted posts.
 * For private posts, attempts decryption and shows locked state if unable.
 */
export function QuotedPostPreview({ post }: QuotedPostPreviewProps) {
  const { user } = useAuth()
  const [state, setState] = useState<DecryptionState>({ status: 'idle' })

  // Request ID ref to prevent stale async updates
  const requestIdRef = useRef(0)

  const isPrivate = isPrivatePost(post)
  const hasTeaser = post.content && post.content.length > 0

  // Attempt decryption for private posts
  const attemptDecryption = useCallback(async () => {
    if (!isPrivate) return

    // Capture request ID to detect stale responses
    const currentRequestId = ++requestIdRef.current

    if (!post.encryptedContent || post.epoch == null || !post.nonce) {
      if (currentRequestId === requestIdRef.current) {
        setState({ status: 'error' })
      }
      return
    }

    if (!user) {
      if (currentRequestId === requestIdRef.current) {
        setState({ status: 'locked' })
      }
      return
    }

    setState({ status: 'loading' })

    try {
      const { privateFeedFollowerService, privateFeedKeyStore, privateFeedCryptoService, MAX_EPOCH } = await import('@/lib/services')

      // Check if this request is stale
      if (currentRequestId !== requestIdRef.current) return

      // For posts, the encryption source is always the post author
      // (Replies use inherited encryption but that's handled by reply-service)
      const encryptionSourceOwnerId = post.author.id

      // Check if this request is stale after async operations
      if (currentRequestId !== requestIdRef.current) return

      // Check if user is the encryption source owner (can decrypt with their own feed keys)
      const isEncryptionSourceOwner = user.identityId === encryptionSourceOwnerId

      if (isEncryptionSourceOwner) {
        const feedSeed = privateFeedKeyStore.getFeedSeed()
        if (!feedSeed) {
          if (currentRequestId === requestIdRef.current) {
            setState({ status: 'locked' })
          }
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

        if (currentRequestId === requestIdRef.current) {
          setState({ status: 'decrypted', content: decryptedContent })
        }
        return
      }

      const canDecrypt = await privateFeedFollowerService.canDecrypt(encryptionSourceOwnerId)
      if (currentRequestId !== requestIdRef.current) return

      if (!canDecrypt) {
        if (currentRequestId === requestIdRef.current) {
          setState({ status: 'locked' })
        }
        return
      }

      const result = await privateFeedFollowerService.decryptPost({
        encryptedContent: post.encryptedContent,
        epoch: post.epoch,
        nonce: post.nonce,
        $ownerId: encryptionSourceOwnerId,
      }, user?.identityId)

      if (currentRequestId !== requestIdRef.current) return

      if (result.success && result.content !== undefined) {
        setState({ status: 'decrypted', content: result.content })
      } else {
        setState({ status: 'locked' })
      }
    } catch (error) {
      console.error('Error decrypting quoted post preview:', error)
      if (currentRequestId === requestIdRef.current) {
        setState({ status: 'error' })
      }
    }
  }, [isPrivate, post, user])

  // Reset state when post or user changes to avoid stale decryption data
  useEffect(() => {
    // Increment request ID to invalidate any in-flight requests
    requestIdRef.current++
    setState({ status: 'idle' })
  }, [post.id, user?.identityId])

  useEffect(() => {
    if (isPrivate && state.status === 'idle') {
      attemptDecryption().catch(err => console.error('Failed to decrypt:', err))
    }
  }, [isPrivate, state.status, attemptDecryption])

  // Get author display for private posts (shows truncated ID as fallback)
  const authorDisplay = post.author.username && !post.author.username.startsWith('user_')
    ? `@${post.author.username}`
    : post.author.displayName !== 'Unknown User' && !post.author.displayName?.startsWith('User ')
      ? post.author.displayName
      : `${post.author.id.slice(0, 8)}...`

  // Public post - simple display
  if (!isPrivate) {
    return (
      <QuotedPostContainer>
        <PostPreviewHeader author={post.author} createdAt={post.createdAt} />
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 line-clamp-3">
          {post.content}
        </p>
      </QuotedPostContainer>
    )
  }

  // Private post - loading state
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <QuotedPostContainer>
        <PostPreviewHeader
          author={post.author}
          createdAt={post.createdAt}
          showLockIcon
          authorDisplayOverride={authorDisplay}
        />
        <div className="mt-2 flex items-center gap-2 text-gray-500">
          <LockOpenIcon className="h-4 w-4 animate-pulse" />
          <span className="text-sm">Decrypting...</span>
        </div>
        {hasTeaser && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
            {post.content}
          </p>
        )}
      </QuotedPostContainer>
    )
  }

  // Private post - decrypted state
  if (state.status === 'decrypted') {
    return (
      <QuotedPostContainer>
        <PostPreviewHeader
          author={post.author}
          createdAt={post.createdAt}
          showLockIcon
          authorDisplayOverride={authorDisplay}
        />
        {hasTeaser && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
            {post.content}
          </p>
        )}
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300 line-clamp-3">
          {state.content}
        </p>
      </QuotedPostContainer>
    )
  }

  // Private post - locked/error state
  return (
    <QuotedPostContainer>
      <PostPreviewHeader
        author={post.author}
        createdAt={post.createdAt}
        showLockIcon
        authorDisplayOverride={authorDisplay}
      />
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
    </QuotedPostContainer>
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
