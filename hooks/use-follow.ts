'use client'

import { categorizeError, isReferenceNotFoundError } from '@/lib/error-utils'
import { followStatusCache } from '@/lib/caches/user-status-cache'
import { useToggleRelation } from './use-toggle-relation'

export interface UseFollowResult {
  isFollowing: boolean
  isLoading: boolean
  toggleFollow: () => Promise<void>
  refresh: () => void
}

export interface UseFollowOptions {
  /** Initial follow status from batch prefetch (skips initial query if provided) */
  initialValue?: boolean
}

/** Whether the viewer follows `targetUserId`, with an optimistic toggle. */
export function useFollow(targetUserId: string, options: UseFollowOptions = {}): UseFollowResult {
  const { isOn, isLoading, toggle, refresh } = useToggleRelation({
    subjectId: targetUserId,
    initialValue: options.initialValue,
    cache: followStatusCache,
    label: 'useFollow',
    selfError: 'You cannot follow yourself',
    check: async (viewerId, subjectId) => {
      const { followService } = await import('@/lib/services/follow-service')
      return followService.isFollowing(subjectId, viewerId)
    },
    turnOn: async (viewerId, subjectId) => {
      const { followService } = await import('@/lib/services/follow-service')
      return followService.followUser(viewerId, subjectId)
    },
    turnOff: async (viewerId, subjectId) => {
      const { followService } = await import('@/lib/services/follow-service')
      return followService.unfollowUser(viewerId, subjectId)
    },
    onMessage: () => 'Following',
    offMessage: 'Unfollowed',
    // A refersTo rejection means the target identity is not on chain; say so
    // rather than implying a transient failure the user should retry.
    failedMessage: (error) => (isReferenceNotFoundError(error) ? categorizeError(error) : 'Failed to update follow status'),
  })
  return { isFollowing: isOn, isLoading, toggleFollow: toggle, refresh }
}
