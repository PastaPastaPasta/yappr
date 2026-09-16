'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { isPrivatePost } from '@/components/post/private-post-content'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'

/**
 * Reply controls follow the local keys available for this post's epoch.
 * Recovery and normal rekey catch-up update the store, so the UI changes with
 * the content without a reload. The existing encryption/write checks still
 * enforce access; this hook only controls the reply affordance.
 * Replies inherit the root author's encryption, supplied by rootPostOwnerId.
 */
export function useCanReplyToPrivate(post: Post | null | undefined, rootPostOwnerId?: string): {
  canReply: boolean
  isPrivate: boolean
  isLoading: boolean
  reason: string | null
} {
  const { user } = useAuth()
  const isPrivate = post ? isPrivatePost(post) : false
  const feedOwnerId = rootPostOwnerId || post?.author.id
  const epoch = post?.epoch
  const subscribe = useCallback((listener: () => void) => {
    return isPrivate ? privateFeedKeyStore.subscribeFollowerKeys(listener) : () => undefined
  }, [isPrivate])
  const getSnapshot = useCallback(() => {
    return isPrivate && !!feedOwnerId && epoch !== undefined && privateFeedKeyStore.hasKeysForEpoch(feedOwnerId, epoch)
  }, [isPrivate, feedOwnerId, epoch])
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
