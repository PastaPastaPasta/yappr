'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import { Post } from '@/lib/types'
import { PostContent } from './post-content'
import { UserAvatar } from '@/components/ui/avatar-image'
import { cn } from '@/lib/utils'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { privateContentOf } from '@/lib/services/private-feed-reader'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { useAuth } from '@/contexts/auth-context'
import { useMediaGate } from '@/hooks/use-media-gate'

interface PrivateQuotedPostContentProps {
  quotedPost: Post
  className?: string
}

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'decrypted'; content: string }
  | { status: 'locked'; needsKey?: boolean }
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
  // No enrichment hint for quoted authors; cache/own-post checks still apply.
  const mediaGate = useMediaGate(quotedPost.author.id)

  // Skip rendering teaser if it's just the lock emoji placeholder
  const teaserContent = quotedPost.content?.trim()
  const hasTeaser = teaserContent && teaserContent.length > 0 && teaserContent !== ':lock:' && teaserContent !== '🔒'
  const createdAtLabel = useRelativeTime(quotedPost.createdAt, { compact: true })

  // Get display name for author
  const authorDisplay = getAuthorDisplay(quotedPost.author)

  const attemptDecryption = useCallback(async () => {
    if (!privateContentOf(quotedPost)) {
      setState({ status: 'error' })
      return
    }
    if (!user) {
      setState({ status: 'locked' })
      return
    }
    setState({ status: 'loading' })
    try {
      const { decryptPostOrReply } = await import('@/lib/services/private-feed-reader')
      const outcome = await decryptPostOrReply(quotedPost, user.identityId, getEncryptionKeyBytes(user.identityId) ?? undefined)
      if (!outcome) {
        setState({ status: 'error' })
        return
      }
      setState(outcome.ok ? { status: 'decrypted', content: outcome.text } : { status: 'locked', needsKey: outcome.reason === 'needs-key' })
    } catch (error) {
      logger.error('Error decrypting quoted private post:', error)
      setState({ status: 'error' })
    }
  }, [quotedPost, user])

  // Reset state when quoted post encryption data or user changes
  // Must watch all encryption-relevant fields to avoid stale decryption data
  useEffect(() => {
    setState({ status: 'idle' })
  }, [quotedPost.id, quotedPost.encryptedContent, quotedPost.keyGeneration, quotedPost.nonce, quotedPost.feed, user?.identityId])

  // Attempt decryption on mount
  useEffect(() => {
    if (state.status === 'idle') {
      attemptDecryption().catch((err) => logger.error('Decryption failed:', err))
    }
  }, [state.status, attemptDecryption])

  // Waiting on keys this device does not hold yet: opens once they are recovered elsewhere (another post, another tab).
  const awaitingKeys = state.status === 'locked' && state.needsKey === true
  useEffect(() => {
    if (!awaitingKeys) return
    return privateFeedKeyStore.subscribe(() => setState({ status: 'idle' }))
  }, [awaitingKeys])

  // Common link wrapper for all states
  const renderLink = (children: React.ReactNode) => (
    <Link
      href={`/post?id=${quotedPost.id}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'mt-3 block border border-gray-200 dark:border-gray-700 rounded-xl p-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 hover:border-gray-400 dark:hover:border-gray-500 transition-all cursor-pointer',
        className
      )}
    >
      {children}
    </Link>
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
      <span>{createdAtLabel}</span>
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
    return renderLink(
      <>
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
      </>
    )
  }

  // Decrypted state
  if (state.status === 'decrypted') {
    return renderLink(
      <>
        {renderHeader()}
        {hasTeaser && (
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
            {quotedPost.content}
          </div>
        )}
        <div className="mt-1">
          <PostContent content={state.content} className="text-sm line-clamp-3" disableInternalPostEmbed mediaGate={mediaGate} />
        </div>
      </>
    )
  }

  // Locked state - per PRD §5.3: Non-followers see "[Private post from @user]"
  if (state.status === 'locked') {
    return renderLink(
      <>
        {renderHeader()}
        {hasTeaser && (
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
            {quotedPost.content}
          </div>
        )}
        {renderLockedIndicator()}
      </>
    )
  }

  // Error state - show as locked
  return renderLink(
    <>
      {renderHeader()}
      {renderLockedIndicator()}
    </>
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
  return !!(post.encryptedContent && post.keyGeneration !== undefined && post.nonce)
}
