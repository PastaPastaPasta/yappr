'use client'

import { useState, useEffect, useCallback } from 'react'
import { LockClosedIcon, LockOpenIcon, ExclamationTriangleIcon, KeyIcon, ArrowPathIcon, ClockIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import { Post } from '@/lib/types'
import { PostContent } from './post-content'
import { cn } from '@/lib/utils'
import { identifierToBytes } from '@/lib/services/sdk-helpers'
import { useAuth } from '@/contexts/auth-context'
import { HashtagValidationStatus } from '@/hooks/use-hashtag-validation'
import { MentionValidationStatus } from '@/hooks/use-mention-validation'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { usePrivateFeedRequest } from '@/hooks/use-private-feed-request'
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'

interface PrivatePostContentProps {
  post: Post
  className?: string
  hashtagValidations?: Map<string, HashtagValidationStatus>
  onFailedHashtagClick?: (hashtag: string) => void
  mentionValidations?: Map<string, MentionValidationStatus>
  onFailedMentionClick?: (username: string) => void
  /** @deprecated Use authorId instead. This prop is kept for backwards compatibility. */
  onRequestAccess?: () => void
}

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'recovering' }
  | { status: 'decrypted'; content: string; followerCount?: number }
  | { status: 'locked'; reason: 'no-keys' | 'no-auth' | 'revoked' | 'approved-no-keys' | 'pending' }
  | { status: 'error'; message: string }

type PrivateContentCardStatus = 'loading' | 'recovering' | 'decrypted' | 'locked' | 'error'

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
    loading: {
      headerBg: 'bg-gray-100 dark:bg-gray-800',
      headerText: 'text-gray-600 dark:text-gray-400',
      border: 'border-gray-200 dark:border-gray-700',
      icon: <LockOpenIcon className="h-4 w-4 animate-pulse" />,
      defaultText: 'Decrypting...',
    },
    recovering: {
      headerBg: 'bg-blue-100 dark:bg-blue-900/40',
      headerText: 'text-blue-600 dark:text-blue-400',
      border: 'border-blue-200 dark:border-blue-700',
      icon: <KeyIcon className="h-4 w-4 animate-pulse" />,
      defaultText: 'Recovering keys...',
    },
    decrypted: {
      headerBg: 'bg-gray-50 dark:bg-gray-800/50',
      headerText: 'text-gray-500 dark:text-gray-400',
      border: 'border-gray-200 dark:border-gray-700/50',
      icon: <LockOpenIcon className="h-4 w-4 text-green-500 dark:text-green-400" />,
      defaultText: 'Private Content',
    },
    locked: {
      headerBg: 'bg-gray-100 dark:bg-gray-800',
      headerText: 'text-gray-600 dark:text-gray-400',
      border: 'border-gray-200 dark:border-gray-700',
      icon: <LockClosedIconSolid className="h-4 w-4" />,
      defaultText: 'Private Content',
    },
    error: {
      headerBg: 'bg-red-100 dark:bg-red-900/40',
      headerText: 'text-red-600 dark:text-red-400',
      border: 'border-red-200 dark:border-red-700',
      icon: <ExclamationTriangleIcon className="h-4 w-4" />,
      defaultText: 'Decryption Failed',
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
  hashtagValidations?: Map<string, HashtagValidationStatus>
  onFailedHashtagClick?: (hashtag: string) => void
  mentionValidations?: Map<string, MentionValidationStatus>
  onFailedMentionClick?: (username: string) => void
}

/**
 * Renders the teaser content for private posts.
 * Used across multiple decryption states to avoid prop drilling repetition.
 */
function Teaser({ content, hashtagValidations, onFailedHashtagClick, mentionValidations, onFailedMentionClick, muted = false, disableLinkPreview = false }: TeaserProps & { muted?: boolean; disableLinkPreview?: boolean }): React.ReactElement {
  if (muted) {
    return (
      <div className="text-gray-500 dark:text-gray-400 text-sm">
        <PostContent
          content={content}
          hashtagValidations={hashtagValidations}
          onFailedHashtagClick={onFailedHashtagClick}
          mentionValidations={mentionValidations}
          onFailedMentionClick={onFailedMentionClick}
          disableLinkPreview={disableLinkPreview}
        />
      </div>
    )
  }

  return (
    <PostContent
      content={content}
      hashtagValidations={hashtagValidations}
      onFailedHashtagClick={onFailedHashtagClick}
      mentionValidations={mentionValidations}
      onFailedMentionClick={onFailedMentionClick}
      disableLinkPreview={disableLinkPreview}
    />
  )
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
  className = '',
  hashtagValidations,
  onFailedHashtagClick,
  mentionValidations,
  onFailedMentionClick,
}: PrivatePostContentProps) {
  const { user } = useAuth()
  const [state, setState] = useState<DecryptionState>({ status: 'idle' })
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const { open: openLoginPrompt } = useLoginPromptModal()

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
    ownerId: post.author.id,
    currentUserId: user?.identityId ?? null,
    onRequireAuth: () => openLoginPrompt('generic'),
  })

  // State for showing cancel option when pending is clicked
  const [showCancelOption, setShowCancelOption] = useState(false)

  const isOwner = user?.identityId === post.author.id
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
  }

  // Attempt follower key recovery using encryption key
  const attemptRecovery = useCallback(async () => {
    if (!user) return

    setState({ status: 'recovering' })

    try {
      // Get encryption key bytes from session storage (handles both WIF and hex formats)
      const encryptionPrivateKey = getEncryptionKeyBytes(user.identityId)
      if (!encryptionPrivateKey) {
        // Key not in session storage - should have been entered via modal
        setState({ status: 'locked', reason: 'approved-no-keys' })
        return
      }

      // For posts, the encryption source is always the post author
      // (Replies use inherited encryption but that's handled separately)
      const encryptionSourceOwnerId = post.author.id

      // Attempt to recover follower keys from grant
      const { privateFeedFollowerService } = await import('@/lib/services')
      const result = await privateFeedFollowerService.recoverFollowerKeys(
        encryptionSourceOwnerId,
        user.identityId,
        encryptionPrivateKey
      )

      if (result.success) {
        // Recovery successful - now try to decrypt the post
        const decryptResult = await privateFeedFollowerService.decryptPost({
          encryptedContent: post.encryptedContent!,
          epoch: post.epoch!,
          nonce: post.nonce!,
          $ownerId: encryptionSourceOwnerId,
        }, user.identityId)

        if (decryptResult.success && decryptResult.content) {
          setState({ status: 'decrypted', content: decryptResult.content })
        } else {
          // Decryption failed after recovery - show error with Retry (Test 5.7)
          console.error('Decryption failed after recovery:', decryptResult.error)
          setState({
            status: 'error',
            message: decryptResult.error || 'Decryption failed after key recovery',
          })
        }
      } else {
        // Recovery failed - could be revoked or corrupted grant
        console.error('Recovery failed:', result.error)
        setState({
          status: 'error',
          message: result.error || 'Failed to recover access keys',
        })
      }
    } catch (error) {
      console.error('Error recovering follower keys:', error)
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Recovery failed',
      })
    }
  }, [post, user])

  // Handle "Recover Access" button click
  const handleRecoverAccess = useCallback(() => {
    // Open encryption key modal with recovery action
    // On success, attempt recovery
    openEncryptionKeyModal('recover_follower_keys', () => {
      // After user enters key successfully, attempt recovery
      void attemptRecovery()
    })
  }, [openEncryptionKeyModal, attemptRecovery])

  const attemptDecryption = useCallback(async () => {
    // Safety check: ensure this is a private post
    if (!post.encryptedContent || post.epoch == null || !post.nonce) {
      setState({ status: 'error', message: 'Invalid private post data' })
      return
    }

    // If not logged in, show locked state
    if (!user) {
      setState({ status: 'locked', reason: 'no-auth' })
      return
    }

    setState({ status: 'loading' })

    try {
      const { privateFeedFollowerService } = await import('@/lib/services')
      const { privateFeedKeyStore } = await import('@/lib/services')

      // For posts, the encryption source is always the post author
      // (Replies use inherited encryption but that's handled by reply-service)
      const encryptionSourceOwnerId = post.author.id

      // Check if user is the encryption source owner (can decrypt with their own feed keys)
      const isEncryptionSourceOwner = user.identityId === encryptionSourceOwnerId

      if (isEncryptionSourceOwner) {
        // User is the encryption source owner - decrypt using their feed keys
        let feedSeed = privateFeedKeyStore.getFeedSeed()

        // BUG-011 fix: If owner has no local keys but has encryption key, attempt auto-recovery
        if (!feedSeed) {
          const encryptionPrivateKey = getEncryptionKeyBytes(user.identityId)
          if (encryptionPrivateKey) {
            console.log('Owner auto-recovery: no local feed seed, attempting recovery with encryption key')
            setState({ status: 'recovering' })

            // Attempt to recover owner state from chain
            const { privateFeedService } = await import('@/lib/services')
            const recoveryResult = await privateFeedService.recoverOwnerState(
              encryptionSourceOwnerId,
              encryptionPrivateKey
            )

            if (recoveryResult.success) {
              console.log('Owner auto-recovery: successfully recovered feed seed')
              feedSeed = privateFeedKeyStore.getFeedSeed()
            } else {
              console.log('Owner auto-recovery failed:', recoveryResult.error)
              // Recovery failed - show locked state with no-keys reason
              setState({ status: 'locked', reason: 'no-keys' })
              return
            }
          } else {
            // Owner doesn't have encryption key - needs to enter it
            console.log('Owner cannot decrypt: no feed seed and no encryption key')
            setState({ status: 'locked', reason: 'no-keys' })
            return
          }
        }

        // Double-check we have feedSeed after potential recovery
        if (!feedSeed) {
          setState({ status: 'locked', reason: 'no-keys' })
          return
        }

        // Owner decrypts using their own keys
        const { privateFeedCryptoService, MAX_EPOCH } = await import('@/lib/services')

        // Get CEK for the post's epoch
        const cached = privateFeedKeyStore.getCachedCEK(encryptionSourceOwnerId)
        let cek: Uint8Array

        if (cached && cached.epoch === post.epoch) {
          cek = cached.cek
        } else if (cached && cached.epoch > post.epoch!) {
          cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, post.epoch!)
        } else {
          // Generate from chain
          const chain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH)
          cek = chain[post.epoch!]
        }

        // Convert encryption source owner ID to bytes for AAD
        const ownerIdBytes = identifierToBytes(encryptionSourceOwnerId)

        const decryptedContent = privateFeedCryptoService.decryptPostContent(
          cek,
          {
            ciphertext: post.encryptedContent,
            nonce: post.nonce!,
            epoch: post.epoch!,
          },
          ownerIdBytes
        )

        // Fetch follower count for owner's own posts (PRD §4.8)
        // Only show follower count if this is the author's own post (not inherited reply)
        let followerCount: number | undefined
        if (isOwner) {
          try {
            const { privateFeedService } = await import('@/lib/services')
            followerCount = await privateFeedService.getPrivateFollowerCount(post.author.id)
          } catch (err) {
            console.warn('Failed to fetch private follower count:', err)
            // Continue without follower count - it's not critical
          }
        }

        setState({ status: 'decrypted', content: decryptedContent, followerCount })
        return
      }

      // User is not the encryption source owner - try to decrypt as follower
      // Check if follower can decrypt using the encryption source owner's keys
      const canDecrypt = await privateFeedFollowerService.canDecrypt(encryptionSourceOwnerId)

      if (!canDecrypt) {
        // Check access status to determine why
        const accessStatus = await privateFeedFollowerService.getAccessStatus(
          encryptionSourceOwnerId,
          user.identityId
        )

        if (accessStatus === 'revoked') {
          setState({ status: 'locked', reason: 'revoked' })
        } else if (accessStatus === 'pending') {
          // User has a pending request - seed the shared cache so other posts show pending too
          const { setPrivateFeedRequestStatus } = await import('@/lib/caches/user-status-cache')
          setPrivateFeedRequestStatus(`${user.identityId}:${encryptionSourceOwnerId}`, 'pending')
          setState({ status: 'locked', reason: 'pending' })
        } else if (accessStatus === 'approved-no-keys') {
          // User has a grant but no local keys - needs to recover
          // Check if we already have an encryption key in session
          const encryptionKeyBytes = getEncryptionKeyBytes(user.identityId)
          if (encryptionKeyBytes) {
            // Key is available - attempt recovery automatically
            void attemptRecovery()
          } else {
            // Need to prompt user for encryption key
            setState({ status: 'locked', reason: 'approved-no-keys' })
          }
        } else {
          setState({ status: 'locked', reason: 'no-keys' })
        }
        return
      }

      // Attempt to decrypt using encryption source owner's keys
      const result = await privateFeedFollowerService.decryptPost({
        encryptedContent: post.encryptedContent,
        epoch: post.epoch!,
        nonce: post.nonce!,
        $ownerId: encryptionSourceOwnerId,
      }, user.identityId)

      if (result.success && result.content) {
        setState({ status: 'decrypted', content: result.content })
      } else {
        // Check if access has been revoked (grant deleted)
        if (result.error === 'Access has been revoked' || result.error?.startsWith('REVOKED:')) {
          setState({ status: 'locked', reason: 'revoked' })
          return
        }
        // Check if this is an old post from before user's current access
        if (result.error?.startsWith('OLD_POST:')) {
          // Show a specific message for old posts that can't be decrypted
          setState({
            status: 'error',
            message: 'This post is from before your current access and cannot be decrypted.',
          })
          return
        }
        // Generic decrypt failure (no user context)
        if (result.error?.startsWith('DECRYPT_FAILED:')) {
          setState({
            status: 'error',
            message: 'Unable to decrypt this post.',
          })
          return
        }
        // BUG-017 fix: Check if we need to trigger key recovery due to missing wrapNonceSalt
        if (result.error?.startsWith('REKEY_RECOVERY_NEEDED:')) {
          console.log('BUG-017: Triggering key recovery due to missing wrapNonceSalt')
          // Check if we have encryption key in session to auto-recover
          const encryptionKeyBytes = getEncryptionKeyBytes(user.identityId)
          if (encryptionKeyBytes) {
            // Key is available - attempt recovery automatically
            void attemptRecovery()
          } else {
            // Need to prompt user for encryption key
            setState({ status: 'locked', reason: 'approved-no-keys' })
          }
          return
        }

        // Decryption failed - show error state with Retry button (Test 5.7)
        console.error('Decryption failed:', result.error || 'Unknown error')
        setState({
          status: 'error',
          message: result.error || 'Decryption failed. Keys may be corrupted or invalid.',
        })
      }
    } catch (error) {
      console.error('Error decrypting private post:', error)
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Decryption failed',
      })
    }
  }, [post, user, isOwner, attemptRecovery])

  // Reset state when post or user changes to avoid stale decryption data
  useEffect(() => {
    setState({ status: 'idle' })
  }, [post.id, user?.identityId])

  // Attempt decryption on mount
  useEffect(() => {
    if (state.status === 'idle') {
      void attemptDecryption()
    }
  }, [state.status, attemptDecryption])

  // Handle retry for decryption failures (Test 5.7)
  const handleRetry = useCallback(() => {
    setState({ status: 'idle' })
  }, [])

  // Loading state
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className={cn('space-y-2', className)}>
        {hasTeaser && <Teaser {...teaserProps} />}
        <PrivateContentCard status="loading">
          <div className="space-y-2">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse w-full" />
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse w-3/4" />
          </div>
        </PrivateContentCard>
      </div>
    )
  }

  // Recovering state - recovering keys from grant
  if (state.status === 'recovering') {
    return (
      <div className={cn('space-y-2', className)}>
        {hasTeaser && <Teaser {...teaserProps} />}
        <PrivateContentCard status="recovering">
          <div className="space-y-2">
            <div className="h-4 bg-blue-200 dark:bg-blue-800 rounded animate-pulse w-full" />
            <div className="h-4 bg-blue-200 dark:bg-blue-800 rounded animate-pulse w-3/4" />
          </div>
        </PrivateContentCard>
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
        statusText = 'Log in to view'
        break
      case 'approved-no-keys':
        statusText = 'Key recovery required'
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
                  cancelRequest()
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
            requestAccess()
          }}
          className="px-3 py-1 bg-yappr-500 hover:bg-yappr-600 text-white rounded-full text-xs font-medium transition-colors"
        >
          Request Access
        </button>
      )
    }

    return (
      <>
        <div data-testid="encrypted-content" className={cn('space-y-2', className)}>
          {hasTeaser && <Teaser {...teaserProps} />}
          {/* Compact locked content card */}
          <div className={cn(
            'rounded-lg border flex items-center justify-between px-3 py-2',
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
                Recover
              </button>
            )}
            {/* Enter Key button for owner with no encryption key stored locally */}
            {state.reason === 'no-keys' && isOwner && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  openEncryptionKeyModal('view_private_posts', () => {
                    void attemptDecryption()
                  })
                }}
                className="px-3 py-1 bg-yappr-500 hover:bg-yappr-600 text-white rounded-full text-xs font-medium transition-colors"
              >
                Enter Key
              </button>
            )}
            {/* Request Access button for no-keys (non-owner), or pending badge for pending requests */}
            {/* Posts always show request button for non-owners (replies don't reach this component) */}
            {(state.reason === 'no-keys' || state.reason === 'pending' || isPending) && !isOwner && renderRequestButton()}
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
 * Helper component to show the private badge on posts
 */
export function PrivatePostBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="private-post-badge"
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-xs',
        className
      )}
    >
      <LockClosedIcon className="h-3 w-3" />
      <span>Private</span>
    </span>
  )
}

/**
 * Check if a post is a private post (has encrypted content)
 */
export function isPrivatePost(post: Post): boolean {
  return !!(post.encryptedContent && post.epoch !== undefined && post.nonce)
}
