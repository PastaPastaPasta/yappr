'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { isPrivatePost } from '@/components/post/private-post-content'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'
import { logger } from '@/lib/logger'

/**
 * Reply controls follow the local keys available for this post's feed and key generation.
 * Recovery and normal rekey catch-up update the store, so the UI changes with
 * the content without a reload. The existing encryption/write checks still
 * enforce access; this hook only controls the reply affordance.
 * Whose feed it is comes from the reader (a reply's root decides: see
 * privateFeedOwnerOf); until that is known, keys for any candidate owner (the
 * thread's starter, the root owner the reply names, its author) count.
 */
export function useCanReplyToPrivate(post: Post | null | undefined, rootPostOwnerId?: string): {
  canReply: boolean
  isPrivate: boolean
  isLoading: boolean
  reason: string | null
} {
  const { user } = useAuth()
  const isPrivate = post ? isPrivatePost(post) : false
  const [resolved, setResolved] = useState<{ postId: string; owner: string } | null>(null)
  useEffect(() => {
    if (!post || !isPrivate) return
    let live = true
    import('@/lib/services/private-feed-reader')
      .then(({ privateFeedOwnerOf }) => privateFeedOwnerOf(post, rootPostOwnerId))
      .then((owner) => {
        if (live) setResolved({ postId: post.id, owner })
      })
      .catch((error) => logger.warn('Could not tell whose private feed this is:', error))
    return () => {
      live = false
    }
  }, [post, isPrivate, rootPostOwnerId])
  const resolvedOwnerId = resolved && resolved.postId === post?.id ? resolved.owner : null
  const feedOwnerId = resolvedOwnerId ?? rootPostOwnerId ?? post?.rootOwnerId ?? post?.author.id
  // The reader settles the owner, but on a tombstoned root it is a guess: keys for any candidate count.
  const candidates = [...new Set([resolvedOwnerId, rootPostOwnerId, post?.rootOwnerId, post?.author.id])].filter((id): id is string => !!id).join(',')
  const keyGeneration = post?.keyGeneration
  const feed = post?.feed
  const viewerId = user?.identityId
  const subscribe = useCallback((listener: () => void) => {
    return isPrivate ? privateFeedKeyStore.subscribe(listener) : () => undefined
  }, [isPrivate])
  const getSnapshot = useCallback(() => {
    return isPrivate && !!viewerId && candidates !== '' && keyGeneration !== undefined && feed !== undefined &&
      candidates.split(',').some((owner) => privateFeedKeyStore.canReadLocally(viewerId, owner, feed, keyGeneration))
  }, [isPrivate, viewerId, candidates, feed, keyGeneration])
  const hasKeys = useSyncExternalStore(subscribe, getSnapshot, () => false)
  const canReply = !isPrivate || (!!user && (user.identityId === feedOwnerId || hasKeys))

  let reason: string | null = null
  if (isPrivate && !user) {
    reason = 'Log in to reply to private posts'
  } else if (!canReply) {
    reason = "Can't reply - no access to this private feed"
  }

  return { canReply, isPrivate, isLoading: !post, reason }
}
