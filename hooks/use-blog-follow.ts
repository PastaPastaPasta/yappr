'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { blogFollowStatusCache } from '@/lib/caches/user-status-cache'
import { useToggleRelation } from './use-toggle-relation'

export interface UseBlogFollowResult {
  isFollowing: boolean
  isLoading: boolean
  followerCount: number
  toggleFollow: () => Promise<void>
}

/**
 * Whether the viewer follows `blogId`, with an optimistic toggle that also
 * keeps the displayed follower count in step.
 */
export function useBlogFollow(blogId: string, initialFollowing?: boolean): UseBlogFollowResult {
  const [followerCount, setFollowerCount] = useState(0)

  const { isOn, isLoading, toggle } = useToggleRelation({
    subjectId: blogId,
    initialValue: initialFollowing,
    cache: blogFollowStatusCache,
    label: 'useBlogFollow',
    loginAction: 'follow',
    check: async (viewerId, subjectId) => {
      const { blogFollowService } = await import('@/lib/services/blog-follow-service')
      return blogFollowService.isFollowingBlog(viewerId, subjectId)
    },
    turnOn: async (viewerId, subjectId) => {
      const { blogFollowService } = await import('@/lib/services/blog-follow-service')
      return blogFollowService.followBlog(viewerId, subjectId)
    },
    turnOff: async (viewerId, subjectId) => {
      const { blogFollowService } = await import('@/lib/services/blog-follow-service')
      return blogFollowService.unfollowBlog(viewerId, subjectId)
    },
    onMessage: () => 'Following blog',
    offMessage: 'Unfollowed blog',
    failedMessage: () => 'Failed to update blog follow status',
    onOptimistic: (nextOn) => setFollowerCount((count) => (nextOn ? count + 1 : Math.max(0, count - 1))),
    onRollback: (restoredOn) => setFollowerCount((count) => (restoredOn ? count + 1 : Math.max(0, count - 1))),
  })

  useEffect(() => {
    if (!blogId) return
    let cancelled = false
    import('@/lib/services/blog-follow-service')
      .then(({ blogFollowService }) => blogFollowService.countBlogFollowers(blogId))
      .then((count) => {
        if (!cancelled) setFollowerCount(count)
      })
      .catch((error) => logger.error('useBlogFollow: Error counting followers:', error))
    return () => {
      cancelled = true
    }
  }, [blogId])

  return { isFollowing: isOn, isLoading, followerCount, toggleFollow: toggle }
}
