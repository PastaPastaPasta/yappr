'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'
import {
  getFollowStatus,
  setFollowStatus,
  deleteFollowStatus,
  clearFollowCache as clearSharedFollowCache,
  seedFollowStatusCache
} from '@/lib/caches/user-status-cache'

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

/**
 * Hook to manage follow state for a target user
 */
export function useFollow(targetUserId: string, options: UseFollowOptions = {}): UseFollowResult {
  const { initialValue } = options
  const { user } = useAuth()
  const [isFollowing, setIsFollowing] = useState(initialValue ?? false)
  // Only show loading if no initial value was provided
  const [isLoading, setIsLoading] = useState(initialValue === undefined)

  const cacheKey = user?.identityId ? `${user.identityId}:${targetUserId}` : ''

  const checkFollowStatus = useCallback(async (forceRefresh = false) => {
    if (!user?.identityId || !targetUserId || user.identityId === targetUserId) {
      setIsLoading(false)
      return
    }

    // Skip initial fetch if initialValue was provided (unless force refresh)
    if (initialValue !== undefined && !forceRefresh) {
      return
    }

    // Check shared cache unless forcing refresh
    if (!forceRefresh && cacheKey) {
      const cached = getFollowStatus(cacheKey)
      if (cached !== null) {
        setIsFollowing(cached)
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
        setFollowStatus(cacheKey, following)
      }
      setIsFollowing(following)
    } catch (error) {
      console.error('useFollow: Error checking follow status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, cacheKey, initialValue])

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
      setFollowStatus(cacheKey, !wasFollowing)
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
        setFollowStatus(cacheKey, wasFollowing)
      }
      console.error('useFollow: Error toggling follow:', error)
      toast.error('Failed to update follow status')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, isFollowing, isLoading, cacheKey])

  const refresh = useCallback(() => {
    if (cacheKey) {
      deleteFollowStatus(cacheKey)
    }
    checkFollowStatus(true)
  }, [cacheKey, checkFollowStatus])

  return { isFollowing, isLoading, toggleFollow, refresh }
}

/**
 * Clear all follow caches
 */
export function clearFollowCache(): void {
  clearSharedFollowCache()
}

// Re-export for convenience
export { seedFollowStatusCache }
