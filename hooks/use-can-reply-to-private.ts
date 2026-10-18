'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { isPrivatePost } from '@/components/post/private-post-content'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'
import { logger } from '@/lib/logger'
import { targetKindOf } from '@/lib/contract-topology'

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
  const postId = post?.id
  const authorId = post?.author.id
  const isReply = !!post && targetKindOf(post) === 'reply'
  const rootPostId = post?.rootPostId
  const rootOwnerId = post?.rootOwnerId
  const [resolved, setResolved] = useState<{ postId: string; owner: string; certain: boolean } | null>(null)
  useEffect(() => {
    if (!postId || !authorId || !isPrivate || !isReply) return
    let live = true
    import('@/lib/services/private-feed-reader')
      .then(({ privateFeedOwnerOf }) => privateFeedOwnerOf({ author: { id: authorId }, targetKind: 'reply', rootPostId, rootOwnerId }, rootPostOwnerId))
      .then(({ owner, certain }) => {
        if (!live) return
        setResolved((known) => (known?.postId === postId && known.owner === owner && known.certain === certain ? known : { postId, owner, certain }))
      })
      .catch((error) => logger.warn('Could not tell whose private feed this is:', error))
    return () => {
      live = false
    }
  }, [postId, authorId, isPrivate, isReply, rootPostId, rootOwnerId, rootPostOwnerId])
  const settled = !isReply ? { owner: authorId, certain: true } : resolved?.postId === postId ? resolved : null
  const feedOwnerId = settled?.owner ?? rootPostOwnerId ?? rootOwnerId ?? authorId
  // A settled owner is the one; until then, or when it is a guess (a deleted root), keys for any candidate count.
  const candidates = (settled?.certain ? [settled.owner] : [...new Set([settled?.owner, rootPostOwnerId, rootOwnerId, authorId])])
    .filter((id): id is string => !!id).join(',')
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
