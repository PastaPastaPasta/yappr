'use client'

import { useState, useEffect, useCallback } from 'react'
import { LockClosedIcon, LockOpenIcon, ExclamationTriangleIcon, KeyIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import { Post } from '@/lib/types'
import { PostContent } from './post-content'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { HashtagValidationStatus } from '@/hooks/use-hashtag-validation'
import { MentionValidationStatus } from '@/hooks/use-mention-validation'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { getEncryptionKey } from '@/lib/secure-storage'

interface PrivatePostContentProps {
  post: Post
  className?: string
  hashtagValidations?: Map<string, HashtagValidationStatus>
  onFailedHashtagClick?: (hashtag: string) => void
  mentionValidations?: Map<string, MentionValidationStatus>
  onFailedMentionClick?: (username: string) => void
  onRequestAccess?: () => void
}

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'recovering' }
  | { status: 'decrypted'; content: string; followerCount?: number }
  | { status: 'locked'; reason: 'no-keys' | 'no-auth' | 'revoked' | 'approved-no-keys' }
  | { status: 'error'; message: string }

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
  onRequestAccess,
}: PrivatePostContentProps) {
  const { user } = useAuth()
  const [state, setState] = useState<DecryptionState>({ status: 'idle' })
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()

  const isOwner = user?.identityId === post.author.id
  const hasTeaser = post.content && post.content.length > 0

  // Attempt follower key recovery using encryption key
  const attemptRecovery = useCallback(async () => {
    if (!user) return

    setState({ status: 'recovering' })

    try {
      // Get encryption key from session storage
      const encryptionKeyHex = getEncryptionKey(user.identityId)
      if (!encryptionKeyHex) {
        // Key not in session storage - should have been entered via modal
        setState({ status: 'locked', reason: 'approved-no-keys' })
        return
      }

      // Convert hex to bytes
      const encryptionPrivateKey = new Uint8Array(
        encryptionKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
      )

      // Attempt to recover follower keys from grant
      const { privateFeedFollowerService } = await import('@/lib/services')
      const result = await privateFeedFollowerService.recoverFollowerKeys(
        post.author.id,
        user.identityId,
        encryptionPrivateKey
      )

      if (result.success) {
        // Recovery successful - now try to decrypt the post
        const decryptResult = await privateFeedFollowerService.decryptPost({
          encryptedContent: post.encryptedContent!,
          epoch: post.epoch!,
          nonce: post.nonce!,
          $ownerId: post.author.id,
        })

        if (decryptResult.success && decryptResult.content) {
          setState({ status: 'decrypted', content: decryptResult.content })
        } else {
          // Decryption failed after recovery - likely truly revoked
          setState({ status: 'locked', reason: 'revoked' })
        }
      } else {
        // Recovery failed - this means the user is actually revoked
        // (the grant exists but keys can't be recovered from it)
        console.log('Recovery failed:', result.error)
        setState({ status: 'locked', reason: 'revoked' })
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
    if (!post.encryptedContent || !post.epoch || !post.nonce) {
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

      // Check if user is the owner
      if (isOwner) {
        // Owner can always decrypt their own posts using their cached CEK
        const feedSeed = privateFeedKeyStore.getFeedSeed()
        if (!feedSeed) {
          // Owner doesn't have local keys - needs to recover
          setState({ status: 'locked', reason: 'no-keys' })
          return
        }

        // Owner decrypts using their own keys
        const { privateFeedCryptoService, MAX_EPOCH } = await import('@/lib/services')

        // Get CEK for the post's epoch
        const cached = privateFeedKeyStore.getCachedCEK(post.author.id)
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

        // Convert owner ID to bytes for AAD
        const ownerIdBytes = identifierToBytes(post.author.id)

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
        let followerCount: number | undefined
        try {
          const { privateFeedService } = await import('@/lib/services')
          followerCount = await privateFeedService.getPrivateFollowerCount(post.author.id)
        } catch (err) {
          console.warn('Failed to fetch private follower count:', err)
          // Continue without follower count - it's not critical
        }

        setState({ status: 'decrypted', content: decryptedContent, followerCount })
        return
      }

      // Check if follower can decrypt
      const canDecrypt = await privateFeedFollowerService.canDecrypt(post.author.id)

      if (!canDecrypt) {
        // Check access status to determine why
        const accessStatus = await privateFeedFollowerService.getAccessStatus(
          post.author.id,
          user.identityId
        )

        if (accessStatus === 'revoked') {
          setState({ status: 'locked', reason: 'revoked' })
        } else if (accessStatus === 'approved-no-keys') {
          // User has a grant but no local keys - needs to recover
          // Check if we already have an encryption key in session
          const encryptionKeyHex = getEncryptionKey(user.identityId)
          if (encryptionKeyHex) {
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

      // Attempt to decrypt
      const result = await privateFeedFollowerService.decryptPost({
        encryptedContent: post.encryptedContent,
        epoch: post.epoch!,
        nonce: post.nonce!,
        $ownerId: post.author.id,
      })

      if (result.success && result.content) {
        setState({ status: 'decrypted', content: result.content })
      } else {
        // Decryption failed - likely revoked or key issue
        setState({ status: 'locked', reason: 'revoked' })
      }
    } catch (error) {
      console.error('Error decrypting private post:', error)
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Decryption failed',
      })
    }
  }, [post, user, isOwner, attemptRecovery])

  // Attempt decryption on mount
  useEffect(() => {
    if (state.status === 'idle') {
      attemptDecryption()
    }
  }, [state.status, attemptDecryption])

  // Loading state
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className={cn('space-y-2', className)}>
        {/* Show teaser if available */}
        {hasTeaser && (
          <PostContent
            content={post.content}
            hashtagValidations={hashtagValidations}
            onFailedHashtagClick={onFailedHashtagClick}
            mentionValidations={mentionValidations}
            onFailedMentionClick={onFailedMentionClick}
          />
        )}
        {/* Decrypting skeleton */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-900/50">
          <div className="flex items-center gap-2 text-gray-500 mb-2">
            <LockOpenIcon className="h-4 w-4 animate-pulse" />
            <span className="text-sm">Decrypting...</span>
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse w-full" />
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse w-3/4" />
          </div>
        </div>
      </div>
    )
  }

  // Recovering state - recovering keys from grant
  if (state.status === 'recovering') {
    return (
      <div className={cn('space-y-2', className)}>
        {/* Show teaser if available */}
        {hasTeaser && (
          <PostContent
            content={post.content}
            hashtagValidations={hashtagValidations}
            onFailedHashtagClick={onFailedHashtagClick}
            mentionValidations={mentionValidations}
            onFailedMentionClick={onFailedMentionClick}
          />
        )}
        {/* Recovering keys skeleton */}
        <div className="border border-blue-200 dark:border-blue-700 rounded-lg p-3 bg-blue-50 dark:bg-blue-900/20">
          <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400 mb-2">
            <KeyIcon className="h-4 w-4 animate-pulse" />
            <span className="text-sm">Recovering access keys...</span>
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-blue-200 dark:bg-blue-800 rounded animate-pulse w-full" />
            <div className="h-4 bg-blue-200 dark:bg-blue-800 rounded animate-pulse w-3/4" />
          </div>
        </div>
      </div>
    )
  }

  // Decrypted state - show full content
  if (state.status === 'decrypted') {
    return (
      <div className={cn('space-y-1', className)}>
        {/* Show teaser with muted style if present */}
        {hasTeaser && (
          <div className="text-gray-500 dark:text-gray-400 text-sm">
            <PostContent
              content={post.content}
              hashtagValidations={hashtagValidations}
              onFailedHashtagClick={onFailedHashtagClick}
              mentionValidations={mentionValidations}
              onFailedMentionClick={onFailedMentionClick}
              disableLinkPreview
            />
          </div>
        )}
        {/* Decrypted content with private indicator */}
        <div className="relative">
          <PostContent
            content={state.content}
            hashtagValidations={hashtagValidations}
            onFailedHashtagClick={onFailedHashtagClick}
            mentionValidations={mentionValidations}
            onFailedMentionClick={onFailedMentionClick}
          />
        </div>
        {/* Show follower visibility count for owner (PRD §4.8) */}
        {isOwner && state.followerCount !== undefined && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mt-1">
            <LockClosedIcon className="h-3 w-3" />
            <span>
              Visible to {state.followerCount} private follower{state.followerCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    )
  }

  // Locked state - show teaser and locked box
  if (state.status === 'locked') {
    // Determine the message and action based on reason
    const isApprovedNoKeys = state.reason === 'approved-no-keys'

    return (
      <div className={cn('space-y-2', className)}>
        {/* Show teaser if available */}
        {hasTeaser && (
          <PostContent
            content={post.content}
            hashtagValidations={hashtagValidations}
            onFailedHashtagClick={onFailedHashtagClick}
            mentionValidations={mentionValidations}
            onFailedMentionClick={onFailedMentionClick}
          />
        )}
        {/* Locked content box */}
        <div className={cn(
          'border rounded-lg p-4',
          isApprovedNoKeys
            ? 'border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20'
            : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50'
        )}>
          <div className="flex flex-col items-center justify-center text-center gap-2">
            <div className={cn(
              'w-10 h-10 rounded-full flex items-center justify-center',
              isApprovedNoKeys
                ? 'bg-blue-200 dark:bg-blue-700'
                : 'bg-gray-200 dark:bg-gray-700'
            )}>
              {isApprovedNoKeys ? (
                <KeyIcon className="h-5 w-5 text-blue-600 dark:text-blue-300" />
              ) : (
                <LockClosedIconSolid className="h-5 w-5 text-gray-500" />
              )}
            </div>
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {isApprovedNoKeys ? 'Key Recovery Required' : 'Private Content'}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {state.reason === 'revoked'
                  ? 'Your access to this private feed has been revoked'
                  : state.reason === 'no-auth'
                  ? 'Log in to request access to this private content'
                  : state.reason === 'approved-no-keys'
                  ? 'You have access but need to enter your encryption key to view this content'
                  : 'Only approved followers can see this content'}
              </p>
            </div>
            {/* Recover Access button for approved-no-keys */}
            {isApprovedNoKeys && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleRecoverAccess()
                }}
                className="mt-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-full text-sm font-medium transition-colors flex items-center gap-2"
              >
                <KeyIcon className="h-4 w-4" />
                Recover Access
              </button>
            )}
            {/* Request Access button for no-keys (no grant) */}
            {state.reason === 'no-keys' && onRequestAccess && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onRequestAccess()
                }}
                className="mt-2 px-4 py-2 bg-yappr-500 hover:bg-yappr-600 text-white rounded-full text-sm font-medium transition-colors"
              >
                Request Access
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Error state
  return (
    <div className={cn('space-y-2', className)}>
      {hasTeaser && (
        <PostContent
          content={post.content}
          hashtagValidations={hashtagValidations}
          onFailedHashtagClick={onFailedHashtagClick}
          mentionValidations={mentionValidations}
          onFailedMentionClick={onFailedMentionClick}
        />
      )}
      <div className="border border-red-200 dark:border-red-800 rounded-lg p-3 bg-red-50 dark:bg-red-900/20">
        <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
          <ExclamationTriangleIcon className="h-4 w-4" />
          <span className="text-sm">Unable to decrypt: {state.message}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Helper component to show the private badge on posts
 */
export function PrivatePostBadge({ className }: { className?: string }) {
  return (
    <span
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

/**
 * Convert identifier to 32-byte Uint8Array for cryptographic operations
 */
function identifierToBytes(identifier: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const ALPHABET_MAP = new Map<string, number>()
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP.set(ALPHABET[i], i)
  }

  let num = BigInt(0)
  for (const char of identifier) {
    const value = ALPHABET_MAP.get(char)
    if (value === undefined) {
      throw new Error(`Invalid base58 character: ${char}`)
    }
    num = num * BigInt(58) + BigInt(value)
  }

  const bytes = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(num & BigInt(0xff))
    num = num >> BigInt(8)
  }

  return bytes
}
