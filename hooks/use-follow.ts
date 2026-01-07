'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'

// Module-level cache for follow status
const followCache = new Map<string, { isFollowing: boolean; timestamp: number }>()
const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

export interface UseFollowResult {
  isFollowing: boolean
  isLoading: boolean
  toggleFollow: () => Promise<void>
  refresh: () => void
}

/**
 * Hook to manage follow state for a target user
 */
export function useFollow(targetUserId: string): UseFollowResult {
  const { user } = useAuth()
  const [isFollowing, setIsFollowing] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const cacheKey = user?.identityId ? `${user.identityId}:${targetUserId}` : ''

  const checkFollowStatus = useCallback(async (forceRefresh = false) => {
    if (!user?.identityId || !targetUserId || user.identityId === targetUserId) {
      setIsLoading(false)
      return
    }

    // Check cache unless forcing refresh
    if (!forceRefresh && cacheKey) {
      const cached = followCache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        setIsFollowing(cached.isFollowing)
        setIsLoading(false)
        return
      }
    }

    setIsLoading(true)

    try {
      const { followService } = await import('@/lib/services/follow-service')
      const following = await followService.isFollowing(targetUserId, user.identityId)

      // Cache the result
      if (cacheKey) {
        followCache.set(cacheKey, { isFollowing: following, timestamp: Date.now() })
      }
      setIsFollowing(following)
    } catch (error) {
      console.error('useFollow: Error checking follow status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, cacheKey])

  useEffect(() => {
    checkFollowStatus()
  }, [checkFollowStatus])

  const toggleFollow = useCallback(async () => {
    if (!user?.identityId || !targetUserId || isLoading) return

    if (user.identityId === targetUserId) {
      toast.error('You cannot follow yourself')
      return
    }

    const wasFollowing = isFollowing

    // Optimistic update
    setIsFollowing(!wasFollowing)
    setIsLoading(true)

    // Update cache optimistically
    if (cacheKey) {
      followCache.set(cacheKey, { isFollowing: !wasFollowing, timestamp: Date.now() })
    }

    try {
      const { followService } = await import('@/lib/services/follow-service')

      const result = wasFollowing
        ? await followService.unfollowUser(user.identityId, targetUserId)
        : await followService.followUser(user.identityId, targetUserId)

      if (!result.success) {
        throw new Error(result.error || 'Follow operation failed')
      }

      toast.success(wasFollowing ? 'Unfollowed' : 'Following')
    } catch (error) {
      // Rollback
      setIsFollowing(wasFollowing)
      if (cacheKey) {
        followCache.set(cacheKey, { isFollowing: wasFollowing, timestamp: Date.now() })
      }
      console.error('useFollow: Error toggling follow:', error)
      toast.error('Failed to update follow status')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, isFollowing, isLoading, cacheKey])

  const refresh = useCallback(() => {
    if (cacheKey) {
      followCache.delete(cacheKey)
    }
    checkFollowStatus(true)
  }, [cacheKey, checkFollowStatus])

  return { isFollowing, isLoading, toggleFollow, refresh }
}

/**
 * Clear all follow caches
 */
export function clearFollowCache(): void {
  followCache.clear()
}
