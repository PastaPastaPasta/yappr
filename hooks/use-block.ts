'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'
import {
  getBlockStatus,
  setBlockStatus,
  deleteBlockStatus,
  clearBlockCache as clearSharedBlockCache,
  seedBlockStatusCache
} from '@/lib/caches/user-status-cache'

export interface UseBlockResult {
  isBlocked: boolean
  isLoading: boolean
  toggleBlock: () => Promise<void>
  refresh: () => void
}

export interface UseBlockOptions {
  /** Initial block status from batch prefetch (skips initial query if provided) */
  initialValue?: boolean
}

/**
 * Hook to manage block state for a target user
 */
export function useBlock(targetUserId: string, options: UseBlockOptions = {}): UseBlockResult {
  const { initialValue } = options
  const { user } = useAuth()
  const [isBlocked, setIsBlocked] = useState(initialValue ?? false)
  // Only show loading if no initial value was provided
  const [isLoading, setIsLoading] = useState(initialValue === undefined)

  const cacheKey = user?.identityId ? `${user.identityId}:${targetUserId}` : ''

  const checkBlockStatus = useCallback(async (forceRefresh = false) => {
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
      const cached = getBlockStatus(cacheKey)
      if (cached !== null) {
        setIsBlocked(cached)
        setIsLoading(false)
        return
      }
    }

    setIsLoading(true)

    try {
      const { blockService } = await import('@/lib/services/block-service')
      const blocked = await blockService.isBlocked(targetUserId, user.identityId)

      // Cache the result
      if (cacheKey) {
        setBlockStatus(cacheKey, blocked)
      }
      setIsBlocked(blocked)
    } catch (error) {
      console.error('useBlock: Error checking block status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, cacheKey, initialValue])

  useEffect(() => {
    checkBlockStatus()
  }, [checkBlockStatus])

  const toggleBlock = useCallback(async () => {
    if (!user?.identityId || !targetUserId || isLoading) return

    if (user.identityId === targetUserId) {
      toast.error('You cannot block yourself')
      return
    }

    const wasBlocked = isBlocked

    // Optimistic update
    setIsBlocked(!wasBlocked)
    setIsLoading(true)

    // Update cache optimistically
    if (cacheKey) {
      setBlockStatus(cacheKey, !wasBlocked)
    }

    try {
      const { blockService } = await import('@/lib/services/block-service')

      const result = wasBlocked
        ? await blockService.unblockUser(user.identityId, targetUserId)
        : await blockService.blockUser(user.identityId, targetUserId)

      if (!result.success) {
        throw new Error(result.error || 'Block operation failed')
      }

      toast.success(wasBlocked ? 'User unblocked' : 'User blocked')

      // Invalidate blocked user IDs cache
      invalidateBlockedUsersCache(user.identityId)
    } catch (error) {
      // Rollback
      setIsBlocked(wasBlocked)
      if (cacheKey) {
        setBlockStatus(cacheKey, wasBlocked)
      }
      console.error('useBlock: Error toggling block:', error)
      toast.error('Failed to update block status')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, isBlocked, isLoading, cacheKey])

  const refresh = useCallback(() => {
    if (cacheKey) {
      deleteBlockStatus(cacheKey)
    }
    checkBlockStatus(true)
  }, [cacheKey, checkBlockStatus])

  return { isBlocked, isLoading, toggleBlock, refresh }
}

// Cache for blocked user IDs list
const blockedUsersCache = new Map<string, { ids: string[]; timestamp: number }>()
const BLOCKED_USERS_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

/**
 * Get cached blocked user IDs for filtering
 */
export async function getBlockedUserIds(userId: string): Promise<string[]> {
  if (!userId) return []

  // Check cache
  const cached = blockedUsersCache.get(userId)
  if (cached && Date.now() - cached.timestamp < BLOCKED_USERS_CACHE_TTL) {
    return cached.ids
  }

  try {
    const { blockService } = await import('@/lib/services/block-service')
    const ids = await blockService.getBlockedUserIds(userId)

    // Cache the result
    blockedUsersCache.set(userId, { ids, timestamp: Date.now() })
    return ids
  } catch (error) {
    console.error('getBlockedUserIds: Error:', error)
    return []
  }
}

/**
 * Invalidate blocked users cache
 */
export function invalidateBlockedUsersCache(userId: string): void {
  blockedUsersCache.delete(userId)
}

/**
 * Clear all block caches
 */
export function clearBlockCache(): void {
  clearSharedBlockCache()
  blockedUsersCache.clear()
}

// Re-export for convenience
export { seedBlockStatusCache }
