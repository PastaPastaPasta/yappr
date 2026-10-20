'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { LockClosedIcon, LockOpenIcon, ExclamationTriangleIcon, KeyIcon, ArrowPathIcon, ClockIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import { Post } from '@/lib/types'
import { PostContent } from './post-content'
import type { MediaGate } from '@/hooks/use-media-gate'
import { cn } from '@/lib/utils'
import { privateContentOf } from '@/lib/services/private-feed-reader'
import { useAuth } from '@/contexts/auth-context'
import type { FieldValidationStatus } from '@/hooks/use-post-field-validation'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { usePrivateFeedRequest } from '@/hooks/use-private-feed-request'
import { useLoginModal } from '@/hooks/use-login-modal'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'

interface PrivatePostContentProps {
  post: Post
  /**
   * Owner of the thread ROOT, when this card is showing a reply.
   *
   * A reply to a private post inherits the root author's CEK, so the root author
   * — not the reply author — is whose feed keys decrypt it. Without this, a reply
   * written by anyone other than the root author cannot be decrypted at all: the
   * lookup goes to the wrong identity's grant.
   */
  rootPostOwnerId?: string
  className?: string
  hashtagValidations?: Map<string, FieldValidationStatus>
  onFailedHashtagClick?: (hashtag: string) => void
  mentionValidations?: Map<string, FieldValidationStatus>
  onFailedMentionClick?: (username: string) => void
  /** @deprecated Use authorId instead. This prop is kept for backwards compatibility. */
  onRequestAccess?: () => void
  /** Follow-gate for external media/previews in teaser and decrypted content */
  mediaGate?: MediaGate
  /** Told whether the viewer can read this post each time decryption settles (never `pending`). */
  onReadabilityChange?: (readability: PrivateReadability) => void
}

/**
 * Whether the viewer can read a private post: `pending` until decryption
 * settles; `unreadable` for someone else's post they have no way into right
 * now (no access, pending, revoked, renewing, or from before they joined).
 * A signed-out viewer, a failed read and an approved follower who only needs
 * to recover keys stay `readable`: each has a way in from the card itself.
 */
export type PrivateReadability = 'pending' | 'readable' | 'unreadable'

// The last answer per viewer and post, so a remounted card (scrolling back,
// returning to a feed) starts from it instead of flashing while it re-decides.
const lastReadability = new Map<string, PrivateReadability>()
const readabilityKey = (postId: string, viewerId: string | undefined) => `${viewerId ?? ''}:${postId}`

/** What this tab last decided about the viewer reading `postId`. */
export function knownPrivateReadability(postId: string, viewerId: string | undefined): PrivateReadability {
  return lastReadability.get(readabilityKey(postId, viewerId)) ?? 'pending'
}

function readabilityOf(state: DecryptionState, isOwner: boolean): PrivateReadability {
  if (state.status === 'idle' || state.status === 'loading') return 'pending'
  if (state.status !== 'locked' || isOwner || state.reason === 'approved-no-keys' || state.reason === 'no-auth') return 'readable'
  return 'unreadable'
}

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'decrypted'; content: string; followerCount?: number }
  | { status: 'locked'; reason: 'no-keys' | 'no-auth' | 'revoked' | 'approved-no-keys' | 'pending' | 'renewing' | 'history' }
  | { status: 'error'; message: string }

type PrivateContentCardStatus = 'decrypted' | 'error'

/** The one-line locked row, and the loading row shaped like it. */
const LOCKED_ROW = 'rounded-lg border flex items-center justify-between gap-2 px-3 py-2 min-h-[42px]'

interface PrivateContentCardProps {
  children: React.ReactNode
  status: PrivateContentCardStatus
  statusText?: string
  footer?: React.ReactNode
}

/**
 * Wrapper component for private post content that provides consistent
 * "card-within-card" styling with a colored header indicating encryption status.
 */
function PrivateContentCard({ children, status, statusText, footer }: PrivateContentCardProps) {
  const config = {
    decrypted: {
      headerBg: 'bg-gray-50 dark:bg-gray-800/50',
      headerText: 'text-gray-500 dark:text-gray-400',
      border: 'border-gray-200 dark:border-gray-700/50',
      icon: <LockOpenIcon className="h-4 w-4 text-green-500 dark:text-green-400" />,
      defaultText: 'Private Content',
    },
    error: {
      headerBg: 'bg-red-100 dark:bg-red-900/40',
      headerText: 'text-red-600 dark:text-red-400',
      border: 'border-red-200 dark:border-red-700',
      icon: <ExclamationTriangleIcon className="h-4 w-4" />,
      defaultText: 'Couldn’t load',
    },
  }

  const { headerBg, headerText, border, icon, defaultText } = config[status]

  return (
    <div className={cn('rounded-xl border overflow-hidden', border)}>
      {/* Header bar */}
      <div className={cn('px-3 py-2 flex items-center gap-2', headerBg, headerText)}>
        {icon}
        <span className="text-sm font-medium">{statusText || defaultText}</span>
      </div>
      {/* Content area */}
      <div className="bg-white dark:bg-gray-950 p-3">
        {children}
      </div>
      {/* Optional footer */}
      {footer && (
        <div className={cn('px-3 py-2 border-t', border, 'bg-gray-50 dark:bg-gray-900/50')}>
          {footer}
        </div>
      )}
    </div>
  )
}

/**
 * Common teaser props for rendering PostContent with validation callbacks.
 */
interface TeaserProps {
  content: string
  hashtagValidations?: Map<string, FieldValidationStatus>
  onFailedHashtagClick?: (hashtag: string) => void
  mentionValidations?: Map<string, FieldValidationStatus>
  onFailedMentionClick?: (username: string) => void
  mediaGate?: MediaGate
}

/**
 * Renders the teaser content for private posts.
 * Used across multiple decryption states to avoid prop drilling repetition.
 */
function Teaser({ content, hashtagValidations, onFailedHashtagClick, mentionValidations, onFailedMentionClick, mediaGate, muted = false, disableLinkPreview = false }: TeaserProps & { muted?: boolean; disableLinkPreview?: boolean }): React.ReactElement {
  const postContent = (
    <PostContent
      content={content}
      hashtagValidations={hashtagValidations}
      onFailedHashtagClick={onFailedHashtagClick}
      mentionValidations={mentionValidations}
      onFailedMentionClick={onFailedMentionClick}
      disableLinkPreview={disableLinkPreview}
      mediaGate={mediaGate}
    />
  )
  return muted ? <div className="text-gray-500 dark:text-gray-400 text-sm">{postContent}</div> : postContent
}

/**
 * Renders private post content based on user's access status.
 * - For the post owner: Always decrypts and shows full content
 * - For approved followers: Decrypts and shows full content
 * - For non-followers: Shows locked state with teaser (if available) and request access button
 * - For revoked users: Shows locked state with teaser and "access revoked" message
 */
export function PrivatePostContent({
  post,
  rootPostOwnerId,
  className = '',
  hashtagValidations,
  onFailedHashtagClick,
  mentionValidations,
  onFailedMentionClick,
  mediaGate,
  onReadabilityChange,
}: PrivatePostContentProps) {
  // Whose feed encrypted this: a post's author; for a reply in a private thread
  // the root's author (replies inherit its encryption), and for a private reply
  // under a public root the replier. Settled by the reader, which reads the root.
  const [encryptionSourceOwnerId, setEncryptionSourceOwnerId] = useState(post.rootOwnerId ?? rootPostOwnerId ?? post.author.id)
  const { user } = useAuth()
  const [state, setState] = useState<DecryptionState>({ status: 'idle' })
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const openLoginPrompt = useLoginModal((s) => s.open)

  // Use the private feed request hook for requesting access from feed posts
  const {
    status: requestStatus,
    isProcessing: isRequestProcessing,
    needsEncryptionKey,
    requestAccess,
    cancelRequest,
    onKeyAdded,
    dismissKeyModal,
  } = usePrivateFeedRequest({
    // Access is granted per FEED, so the request goes to whoever owns the
    // encryption — the root author for an inherited-encrypted reply.
    ownerId: encryptionSourceOwnerId,
    currentUserId: user?.identityId ?? null,
    onRequireAuth: () => openLoginPrompt(),
  })

  // State for showing cancel option when pending is clicked
  const [showCancelOption, setShowCancelOption] = useState(false)

  // Role for key-recovery and access-request controls follows the ENCRYPTION
  // owner — the root author for an inherited-encrypted reply — not the reply's
  // author: access is granted per feed, and the "enter your key" affordance
  // belongs to whoever owns that feed. On v2 encryptionSourceOwnerId falls back
  // to post.author.id, so this is identical there.
  const isOwner = user?.identityId === encryptionSourceOwnerId
  // Skip rendering teaser if it's just the lock emoji placeholder
  const teaserContent = post.content?.trim()
  const hasTeaser = teaserContent && teaserContent.length > 0 && teaserContent !== ':lock:' && teaserContent !== '🔒'

  // Common teaser props to avoid repetition
  const teaserProps: TeaserProps = {
    content: post.content,
    hashtagValidations,
    onFailedHashtagClick,
    mentionValidations,
    onFailedMentionClick,
    mediaGate,
  }

  // Each attempt's answers land only while it is the latest (a slow read for a previous post must not overwrite this one).
  const attemptRef = useRef(0)
  const attemptDecryption = useCallback(async () => {
    const attempt = ++attemptRef.current
    const settle = (next: DecryptionState) => {
      if (attempt === attemptRef.current) setState(next)
    }
    if (!privateContentOf(post)) {
      settle({ status: 'error', message: 'Invalid private post data' })
      return
    }
    if (!user) {
      settle({ status: 'locked', reason: 'no-auth' })
      return
    }

    settle({ status: 'loading' })
    try {
      const { decryptPostOrReply } = await import('@/lib/services/private-feed-reader')
      const opened = await decryptPostOrReply(post, user.identityId, getEncryptionKeyBytes(user.identityId) ?? undefined, rootPostOwnerId)
      if (!opened) {
        settle({ status: 'error', message: 'Invalid private post data' })
        return
      }
      const { outcome, feedOwnerId } = opened
      if (attempt !== attemptRef.current) return
      setEncryptionSourceOwnerId(feedOwnerId)
      const isOwner = user.identityId === feedOwnerId
      if (outcome.ok) {
        let followerCount: number | undefined
        if (isOwner) {
          try {
            const { privateFeedService } = await import('@/lib/services')
            followerCount = await privateFeedService.getPrivateFollowerCount(feedOwnerId)
          } catch (err) {
            logger.warn('Failed to fetch private follower count:', err)
          }
        }
        settle({ status: 'decrypted', content: outcome.text, followerCount })
        return
      }
      switch (outcome.reason) {
        case 'needs-key':
          settle({ status: 'locked', reason: isOwner ? 'no-keys' : 'approved-no-keys' })
          return
        case 'revoked':
          settle({ status: 'locked', reason: 'revoked' })
          return
        case 'history-unavailable':
          settle({ status: 'locked', reason: 'history' })
          return
        case 'failed':
          settle({ status: 'error', message: 'Couldn’t open this private post.' })
          return
      }
      if (isOwner) {
        settle({ status: 'locked', reason: 'no-keys' })
        return
      }
      const { privateFeedFollowerService } = await import('@/lib/services')
      const accessStatus = await privateFeedFollowerService.getAccessStatus(feedOwnerId, user.identityId)
      if (accessStatus === 'pending') {
        // Seed the shared cache so the author's other posts show pending too
        const { setPrivateFeedRequestStatus } = await import('@/lib/caches/user-status-cache')
        setPrivateFeedRequestStatus(`${user.identityId}:${feedOwnerId}`, 'pending')
        settle({ status: 'locked', reason: 'pending' })
      } else if (accessStatus === 'renewing') {
        settle({ status: 'locked', reason: 'renewing' })
      } else if (accessStatus === 'approved-no-keys' || accessStatus === 'approved') {
        settle({ status: 'locked', reason: 'history' })
      } else {
        settle({ status: 'locked', reason: accessStatus === 'revoked' ? 'revoked' : 'no-keys' })
      }
    } catch (error) {
      logger.error('Error decrypting private post:', error)
      settle({ status: 'error', message: 'Couldn’t open this private post.' })
    }
  }, [post, user, rootPostOwnerId])

  // "Recover": enter the encryption key, then read again with it.
  const handleRecoverAccess = useCallback(() => {
    openEncryptionKeyModal('recover_follower_keys', () => setState({ status: 'idle' }))
  }, [openEncryptionKeyModal])

  // Reset state when post or user changes to avoid stale decryption data
  useEffect(() => {
    attemptRef.current++
    setState({ status: 'idle' })
    setEncryptionSourceOwnerId(post.rootOwnerId ?? rootPostOwnerId ?? post.author.id)
  }, [post.id, user?.identityId, post.rootOwnerId, rootPostOwnerId, post.author.id])

  // Attempt decryption on mount
  useEffect(() => {
    if (state.status === 'idle') {
      attemptDecryption().catch((err) => logger.error('Decryption failed:', err))
    }
  }, [state.status, attemptDecryption])

  const readability = readabilityOf(state, isOwner)
  const viewerId = user?.identityId
  useEffect(() => {
    if (readability === 'pending') return
    lastReadability.set(readabilityKey(post.id, viewerId), readability)
    onReadabilityChange?.(readability)
  }, [readability, post.id, viewerId, onReadabilityChange])

  // A post waiting on key recovery unlocks as soon as keys arrive, whether they
  // were recovered from another post on this page or in another tab.
  const awaitingKeys = state.status === 'locked' && state.reason === 'approved-no-keys'
  useEffect(() => {
    if (!awaitingKeys) return
    return privateFeedKeyStore.subscribe(() => setState({ status: 'idle' }))
  }, [awaitingKeys])

  // Handle retry for decryption failures (Test 5.7)
  const handleRetry = useCallback(() => {
    setState({ status: 'idle' })
  }, [])

  // Loading: the same row the locked state settles into, which is what most
  // viewers get, so the card does not jump when the answer arrives.
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div data-testid="private-content-loading" className={cn('space-y-2', className)}>
        {hasTeaser && <Teaser {...teaserProps} />}
        <div className={cn(LOCKED_ROW, 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50')}>
          <div className="flex items-center gap-2 text-gray-400 dark:text-gray-500">
            <LockClosedIconSolid className="h-4 w-4 animate-pulse" />
            <span className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
          </div>
        </div>
      </div>
    )
  }

  // Decrypted state - show full content
  if (state.status === 'decrypted') {
    const followerFooter = isOwner && state.followerCount !== undefined ? (
      <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <LockClosedIcon className="h-3 w-3" />
        <span>
          Visible to {state.followerCount} private follower{state.followerCount !== 1 ? 's' : ''}
        </span>
      </div>
    ) : undefined

    return (
      <div data-testid="decrypted-content" className={cn('space-y-2', className)}>
        {hasTeaser && <Teaser {...teaserProps} muted disableLinkPreview />}
        <PrivateContentCard status="decrypted" footer={followerFooter}>
          <PostContent
            content={state.content}
            hashtagValidations={hashtagValidations}
            onFailedHashtagClick={onFailedHashtagClick}
            mentionValidations={mentionValidations}
            onFailedMentionClick={onFailedMentionClick}
            mediaGate={mediaGate}
          />
        </PrivateContentCard>
      </div>
    )
  }

  // Locked state - show teaser and locked box
  if (state.status === 'locked') {
    // Determine the message and action based on reason
    const isApprovedNoKeys = state.reason === 'approved-no-keys'

    // Check if pending - use hook status (which reads from shared cache)
    // Don't use state.reason since it doesn't update when request is cancelled
    const isPending = requestStatus === 'pending'

    // Get status text based on lock reason
    let statusText: string
    switch (state.reason) {
      case 'revoked':
        statusText = 'Access revoked'
        break
      case 'no-auth':
        statusText = 'Sign in to view'
        break
      case 'approved-no-keys':
        statusText = 'Unlock to see this post'
        break
      case 'renewing':
        statusText = 'Your access is being renewed'
        break
      case 'history':
        statusText = isOwner
          ? 'From before your private feed was renewed'
          : 'From before you could see this private feed'
        break
      case 'no-keys':
        statusText = isOwner ? 'Enter encryption key to view' : 'Private content'
        break
      default:
        statusText = 'Private content'
    }

    // Render the Request Access button based on current state
    const renderRequestButton = () => {
      // Show pending state with cancel option
      if (isPending) {
        if (showCancelOption) {
          return (
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  cancelRequest().catch((err) => logger.error('Failed to cancel request:', err))
                  setShowCancelOption(false)
                }}
                disabled={isRequestProcessing}
                className="px-3 py-1 bg-red-500 hover:bg-red-600 text-white rounded-full text-xs font-medium transition-colors disabled:opacity-50"
              >
                {isRequestProcessing ? 'Cancelling...' : 'Cancel'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setShowCancelOption(false)
                }}
                className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        }
        return (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setShowCancelOption(true)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-full text-xs font-medium transition-colors"
          >
            <ClockIcon className="h-3.5 w-3.5" />
            Pending
          </button>
        )
      }

      // Show loading state
      if (requestStatus === 'loading' || isRequestProcessing) {
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-yappr-500 text-white rounded-full text-xs font-medium">
            <span className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Requesting...
          </span>
        )
      }

      // Show request button
      return (
        <button
          onClick={(e) => {
            e.stopPropagation()
            requestAccess().catch((err) => logger.error('Failed to request access:', err))
          }}
          className="px-3 py-1 bg-yappr-500 hover:bg-yappr-600 text-white rounded-full text-xs font-medium transition-colors"
        >
          Request access
        </button>
      )
    }

    return (
      <>
        <div data-testid="encrypted-content" className={cn('space-y-2', className)}>
          {hasTeaser && <Teaser {...teaserProps} />}
          {/* Compact locked content card */}
          <div className={cn(
            LOCKED_ROW,
            isApprovedNoKeys
              ? 'border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20'
              : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50'
          )}>
            <div className="flex items-center gap-2">
              {isApprovedNoKeys
                ? <KeyIcon className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                : <LockClosedIconSolid className="h-4 w-4 text-gray-500 dark:text-gray-400" />
              }
              <span className={cn(
                'text-sm',
                isApprovedNoKeys
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400'
              )}>
                {statusText}
              </span>
            </div>
            {/* Recover Access button for approved-no-keys */}
            {isApprovedNoKeys && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleRecoverAccess()
                }}
                className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded-full text-xs font-medium transition-colors"
              >
                Unlock
              </button>
            )}
            {/* Enter Key button for owner with no encryption key stored locally */}
            {state.reason === 'no-keys' && isOwner && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  openEncryptionKeyModal('view_private_posts', () => {
                    attemptDecryption().catch((err) => logger.error('Decryption failed:', err))
                  })
                }}
                className="px-3 py-1 bg-yappr-500 hover:bg-yappr-600 text-white rounded-full text-xs font-medium transition-colors"
              >
                Enter Key
              </button>
            )}
            {/* Request Access button for no-keys (non-owner), or pending badge for pending requests */}
            {/* Posts always show request button for non-owners (replies don't reach this component) */}
            {(state.reason === 'no-keys' || state.reason === 'revoked' || state.reason === 'pending' || (isPending && state.reason !== 'renewing' && state.reason !== 'history')) && !isOwner && renderRequestButton()}
          </div>
        </div>

        {/* Encryption key modal for users who need to add a key first */}
        <AddEncryptionKeyModal
          isOpen={needsEncryptionKey}
          onClose={dismissKeyModal}
          onSuccess={onKeyAdded}
        />
      </>
    )
  }

  // Error state - with Retry button (PRD §4.12, Test 5.7)
  return (
    <div className={cn('space-y-2', className)}>
      {hasTeaser && <Teaser {...teaserProps} />}
      <PrivateContentCard status="error">
        <div className="flex flex-col items-center justify-center text-center gap-2 py-2">
          <p className="text-sm text-red-600 dark:text-red-400">{state.message}</p>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleRetry()
            }}
            className="mt-1 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-full text-sm font-medium transition-colors flex items-center gap-2"
          >
            <ArrowPathIcon className="h-4 w-4" />
            Retry
          </button>
        </div>
      </PrivateContentCard>
    </div>
  )
}

/**
 * Check if a post is a private post (has encrypted content)
 */
export function isPrivatePost(post: Post): boolean {
  return privateContentOf(post) !== null
}
