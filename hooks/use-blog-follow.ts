'use client'

import { logger } from '@/lib/logger'
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal'
import {
  getBlogFollowStatus,
  setBlogFollowStatus,
  clearBlogFollowCache as clearSharedBlogFollowCache,
  seedBlogFollowStatusCache
} from '@/lib/caches/user-status-cache'

export interface UseBlogFollowResult {
  isFollowing: boolean
  isLoading: boolean
  followerCount: number
  toggleFollow: () => Promise<void>
}

export function useBlogFollow(blogId: string, initialFollowing?: boolean): UseBlogFollowResult {
  const { user } = useAuth()
  const { open: openLoginPrompt } = useLoginPromptModal()
  const [isFollowing, setIsFollowing] = useState(initialFollowing ?? false)
  const [isLoading, setIsLoading] = useState(initialFollowing === undefined)
  const [followerCount, setFollowerCount] = useState(0)

  const cacheKey = user?.identityId ? `blog:${user.identityId}:${blogId}` : ''

  const checkStatus = useCallback(async () => {
    if (!user?.identityId || !blogId) {
      setIsLoading(false)
      return
    }

    if (initialFollowing !== undefined) {
      return
    }

    if (cacheKey) {
      const cached = getBlogFollowStatus(cacheKey)
      if (cached !== null) {
        setIsFollowing(cached)
        setIsLoading(false)
        return
      }
    }

    setIsLoading(true)
    try {
      const { blogFollowService } = await import('@/lib/services/blog-follow-service')
      const following = await blogFollowService.isFollowingBlog(user.identityId, blogId)
      if (cacheKey) setBlogFollowStatus(cacheKey, following)
      setIsFollowing(following)
    } catch (error) {
      logger.error('useBlogFollow: Error checking status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, blogId, cacheKey, initialFollowing])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  useEffect(() => {
    if (!blogId) return
    let cancelled = false

    const load = async () => {
      try {
        const { blogFollowService } = await import('@/lib/services/blog-follow-service')
        const count = await blogFollowService.countBlogFollowers(blogId)
        if (!cancelled) setFollowerCount(count)
      } catch (error) {
        logger.error('useBlogFollow: Error counting followers:', error)
      }
    }

    load()
    return () => { cancelled = true }
  }, [blogId])

  const toggleFollow = useCallback(async () => {
    if (!user?.identityId) {
      openLoginPrompt('follow')
      return
    }
    if (!blogId || isLoading) return

    const wasFollowing = isFollowing

    // Optimistic update
    setIsFollowing(!wasFollowing)
    setFollowerCount(prev => wasFollowing ? Math.max(0, prev - 1) : prev + 1)
    setIsLoading(true)

    if (cacheKey) setBlogFollowStatus(cacheKey, !wasFollowing)

    try {
      const { blogFollowService } = await import('@/lib/services/blog-follow-service')

      const result = wasFollowing
        ? await blogFollowService.unfollowBlog(user.identityId, blogId)
        : await blogFollowService.followBlog(user.identityId, blogId)

      if (!result.success) {
        throw new Error(result.error || 'Blog follow operation failed')
      }

      toast.success(wasFollowing ? 'Unfollowed blog' : 'Following blog')
    } catch (error) {
      // Rollback
      setIsFollowing(wasFollowing)
      setFollowerCount(prev => wasFollowing ? prev + 1 : Math.max(0, prev - 1))
      if (cacheKey) setBlogFollowStatus(cacheKey, wasFollowing)
      logger.error('useBlogFollow: Error toggling follow:', error)
      toast.error('Failed to update blog follow status')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, blogId, isFollowing, isLoading, cacheKey, openLoginPrompt])

  return { isFollowing, isLoading, followerCount, toggleFollow }
}

export function clearBlogFollowCache(): void {
  clearSharedBlogFollowCache()
}

export { seedBlogFollowStatusCache as seedBlogFollowCache }
