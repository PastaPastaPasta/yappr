'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import { Post } from '@/lib/types'
import { PostContent } from './post-content'
import { UserAvatar } from '@/components/ui/avatar-image'
import { cn, formatTime } from '@/lib/utils'
import { identifierToBytes } from '@/lib/services/sdk-helpers'
import { useAuth } from '@/contexts/auth-context'

interface PrivateQuotedPostContentProps {
  quotedPost: Post
  className?: string
}

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'decrypted'; content: string }
  | { status: 'locked' }
  | { status: 'error' }

/**
 * Renders quoted private post content.
 * Per PRD §5.3: Quotes do NOT inherit encryption - the quoted content is fetched and decrypted separately.
 * Non-followers see "[Private post from @user]" for the embedded quoted content they can't decrypt.
 */
export function PrivateQuotedPostContent({
  quotedPost,
  className = '',
}: PrivateQuotedPostContentProps) {
  const { user } = useAuth()
  const [state, setState] = useState<DecryptionState>({ status: 'idle' })

  // Skip rendering teaser if it's just the lock emoji placeholder
  const teaserContent = quotedPost.content?.trim()
  const hasTeaser = teaserContent && teaserContent.length > 0 && teaserContent !== ':lock:' && teaserContent !== '🔒'

  // Get display name for author
  const authorDisplay = getAuthorDisplay(quotedPost.author)

  const attemptDecryption = useCallback(async () => {
    // Safety check: ensure this is a private post
    if (!quotedPost.encryptedContent || quotedPost.epoch == null || !quotedPost.nonce) {
      setState({ status: 'error' })
      return
    }

    // If not logged in, show locked state
    if (!user) {
      setState({ status: 'locked' })
      return
    }

    setState({ status: 'loading' })

    try {
      const { privateFeedFollowerService } = await import('@/lib/services')
      const { privateFeedKeyStore } = await import('@/lib/services')

      // For quoted posts, the encryption source is always the post author
      // (Replies use inherited encryption but quoted posts are always top-level posts)
      const encryptionSourceOwnerId = quotedPost.author.id

      // Check if user is the encryption source owner (can decrypt with their own feed keys)
      const isEncryptionSourceOwner = user.identityId === encryptionSourceOwnerId

      if (isEncryptionSourceOwner) {
        const feedSeed = privateFeedKeyStore.getFeedSeed()
        if (!feedSeed) {
          setState({ status: 'locked' })
          return
        }

        const { privateFeedCryptoService, MAX_EPOCH } = await import('@/lib/services')

        const cached = privateFeedKeyStore.getCachedCEK(encryptionSourceOwnerId)
        let cek: Uint8Array

        if (cached && cached.epoch === quotedPost.epoch) {
          cek = cached.cek
        } else if (cached && cached.epoch > quotedPost.epoch) {
          cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, quotedPost.epoch)
        } else {
          const chain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH)
          cek = chain[quotedPost.epoch]
        }

        const ownerIdBytes = identifierToBytes(encryptionSourceOwnerId)

        const decryptedContent = privateFeedCryptoService.decryptPostContent(
          cek,
          {
            ciphertext: quotedPost.encryptedContent,
            nonce: quotedPost.nonce,
            epoch: quotedPost.epoch,
          },
          ownerIdBytes
        )

        setState({ status: 'decrypted', content: decryptedContent })
        return
      }

      // Check if follower can decrypt using encryption source owner's keys
      const canDecrypt = await privateFeedFollowerService.canDecrypt(encryptionSourceOwnerId)

      if (!canDecrypt) {
        setState({ status: 'locked' })
        return
      }

      // Attempt to decrypt using encryption source owner's keys
      const result = await privateFeedFollowerService.decryptPost({
        encryptedContent: quotedPost.encryptedContent,
        epoch: quotedPost.epoch,
        nonce: quotedPost.nonce,
        $ownerId: encryptionSourceOwnerId,
      }, user?.identityId)

      if (result.success && result.content) {
        setState({ status: 'decrypted', content: result.content })
      } else {
        setState({ status: 'locked' })
      }
    } catch (error) {
      logger.error('Error decrypting quoted private post:', error)
      setState({ status: 'error' })
    }
  }, [quotedPost, user])

  // Reset state when quoted post encryption data or user changes
  // Must watch all encryption-relevant fields to avoid stale decryption data
  useEffect(() => {
    setState({ status: 'idle' })
  }, [quotedPost.id, quotedPost.encryptedContent, quotedPost.epoch, quotedPost.nonce, user?.identityId])

  // Attempt decryption on mount
  useEffect(() => {
    if (state.status === 'idle') {
      attemptDecryption().catch((err) => logger.error('Decryption failed:', err))
    }
  }, [state.status, attemptDecryption])

  // Common link wrapper class for all states
  const linkClass = cn(
    'mt-3 block border border-gray-200 dark:border-gray-700 rounded-xl p-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 hover:border-gray-400 dark:hover:border-gray-500 transition-all cursor-pointer',
    className
  )

  // Common header for quoted post
  const renderHeader = () => (
    <div className="flex items-center gap-2 text-sm text-gray-500">
      <UserAvatar userId={quotedPost.author.id} size="sm" alt={quotedPost.author.displayName} />
      <span className="font-semibold text-gray-900 dark:text-gray-100">
        {quotedPost.author.displayName}
      </span>
      {quotedPost.author.username && !quotedPost.author.username.startsWith('user_') ? (
        <span className="text-gray-500">@{quotedPost.author.username}</span>
      ) : (
        <span className="text-gray-500 font-mono text-xs">
          {quotedPost.author.id.slice(0, 8)}...
        </span>
      )}
      <span>·</span>
      <span>{formatTime(quotedPost.createdAt)}</span>
      <LockClosedIcon className="h-3.5 w-3.5 ml-1" />
    </div>
  )

  // Locked content indicator (used in locked and error states)
  const renderLockedIndicator = () => (
    <div className="mt-2 flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
      <LockClosedIconSolid className="h-4 w-4 text-gray-500" />
      <span className="text-sm text-gray-600 dark:text-gray-400">
        Private post from {authorDisplay}
      </span>
    </div>
  )

  // Loading state
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <Link href={`/post?id=${quotedPost.id}`} onClick={(e) => e.stopPropagation()} className={linkClass}>
        {renderHeader()}
        <div className="mt-2 flex items-center gap-2 text-gray-500">
          <LockOpenIcon className="h-4 w-4 animate-pulse" />
          <span className="text-sm">Decrypting...</span>
        </div>
        {hasTeaser && (
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
            {quotedPost.content}
          </div>
        )}
      </Link>
    )
  }

  // Decrypted state
  if (state.status === 'decrypted') {
    return (
      <Link href={`/post?id=${quotedPost.id}`} onClick={(e) => e.stopPropagation()} className={linkClass}>
        {renderHeader()}
        {hasTeaser && (
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
            {quotedPost.content}
          </div>
        )}
        <div className="mt-1">
          <PostContent content={state.content} className="text-sm line-clamp-3" disableInternalPostEmbed />
        </div>
      </Link>
    )
  }

  // Locked state - per PRD §5.3: Non-followers see "[Private post from @user]"
  if (state.status === 'locked') {
    return (
      <Link href={`/post?id=${quotedPost.id}`} onClick={(e) => e.stopPropagation()} className={linkClass}>
        {renderHeader()}
        {hasTeaser && (
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
            {quotedPost.content}
          </div>
        )}
        {renderLockedIndicator()}
      </Link>
    )
  }

  // Error state - show as locked
  return (
    <Link href={`/post?id=${quotedPost.id}`} onClick={(e) => e.stopPropagation()} className={linkClass}>
      {renderHeader()}
      {renderLockedIndicator()}
    </Link>
  )
}

/**
 * Helper to get display text for author
 */
function getAuthorDisplay(author: Post['author']): string {
  if (author.username && !author.username.startsWith('user_')) {
    return `@${author.username}`
  }
  if (author.displayName && author.displayName !== 'Unknown User' && !author.displayName.startsWith('User ')) {
    return author.displayName
  }
  return `${author.id.slice(0, 8)}...`
}

/**
 * Check if a post is a private post
 */
export function isQuotedPostPrivate(post: Post): boolean {
  return !!(post.encryptedContent && post.epoch !== undefined && post.nonce)
}
