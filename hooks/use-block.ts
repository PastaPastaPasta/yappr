'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal'
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
  toggleBlock: (message?: string) => Promise<void>
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
  const { open: openLoginPrompt } = useLoginPromptModal()
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
      logger.error('useBlock: Error checking block status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, cacheKey, initialValue])

  useEffect(() => {
    checkBlockStatus()
  }, [checkBlockStatus])

  const toggleBlock = useCallback(async (message?: string) => {
    if (!user?.identityId) {
      openLoginPrompt('block')
      return
    }
    if (!targetUserId || isLoading) return

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
        : await blockService.blockUser(user.identityId, targetUserId, message)

      if (!result.success) {
        throw new Error(result.error || 'Block operation failed')
      }

      // Show appropriate message based on whether auto-revocation occurred
      if (wasBlocked) {
        toast.success('User unblocked')
      } else if ('autoRevoked' in result && result.autoRevoked) {
        toast.success('User blocked and private feed access revoked')
      } else {
        toast.success('User blocked')
      }
    } catch (error) {
      // Rollback
      setIsBlocked(wasBlocked)
      if (cacheKey) {
        setBlockStatus(cacheKey, wasBlocked)
      }
      logger.error('useBlock: Error toggling block:', error)
      toast.error('Failed to update block status')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, isBlocked, isLoading, cacheKey, openLoginPrompt])

  const refresh = useCallback(() => {
    if (cacheKey) {
      deleteBlockStatus(cacheKey)
    }
    checkBlockStatus(true)
  }, [cacheKey, checkBlockStatus])

  return { isBlocked, isLoading, toggleBlock, refresh }
}

/**
 * Check which authors are blocked from a list.
 * Uses efficient 'in' query with caching - only queries uncached IDs.
 * @returns Map of authorId -> isBlocked
 */
export async function checkBlockedForAuthors(
  userId: string,
  authorIds: string[]
): Promise<Map<string, boolean>> {
  if (!userId || authorIds.length === 0) {
    return new Map()
  }

  try {
    const { blockService } = await import('@/lib/services/block-service')
    return await blockService.checkBlockedBatch(userId, authorIds)
  } catch (error) {
    logger.error('checkBlockedForAuthors: Error:', error)
    return new Map()
  }
}

/**
 * Clear all block caches
 */
export function clearBlockCache(): void {
  clearSharedBlockCache()
}

// Re-export for convenience
export { seedBlockStatusCache }
