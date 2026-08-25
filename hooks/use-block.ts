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
  /** Whether the block comes from the viewer's own block document */
  isOwnBlock: boolean
  /** Identity whose followed block list blocks the target, if any */
  inheritedFrom: string | null
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
  const [isOwnBlock, setIsOwnBlock] = useState(false)
  const [inheritedFrom, setInheritedFrom] = useState<string | null>(null)
  // Only show loading if no initial value was provided
  const [isLoading, setIsLoading] = useState(initialValue === undefined)

  const cacheKey = user?.identityId ? `${user.identityId}:${targetUserId}` : ''

  const checkBlockStatus = useCallback(async (forceRefresh = false) => {
    if (!user?.identityId || !targetUserId || user.identityId === targetUserId) {
      setIsLoading(false)
      return
    }

    if (!forceRefresh) {
      // Known-negative statuses need no provenance lookup
      if (initialValue === false) {
        setIsLoading(false)
        return
      }
      if (initialValue === undefined && cacheKey && getBlockStatus(cacheKey) === false) {
        setIsBlocked(false)
        setIsOwnBlock(false)
        setInheritedFrom(null)
        setIsLoading(false)
        return
      }
    }

    // Blocked or unknown status - resolve full provenance so callers know
    // whether an unblock (deleting the own block document) can actually help
    setIsLoading(true)

    try {
      const { blockService } = await import('@/lib/services/block-service')
      const provenance = await blockService.getBlockProvenance(targetUserId, user.identityId)

      // Cache the result
      if (cacheKey) {
        setBlockStatus(cacheKey, provenance.isBlocked)
      }
      setIsBlocked(provenance.isBlocked)
      setIsOwnBlock(provenance.isOwnBlock)
      setInheritedFrom(provenance.inheritedFrom)
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
    const wasOwnBlock = isOwnBlock

    if (wasBlocked && !wasOwnBlock) {
      // Inherited-only block: there is no own block document to delete, so an
      // "unblock" here would be a silent no-op. It must be managed via block
      // list follows in settings instead.
      toast.error('This user is blocked by a block list you follow. Manage block lists in Settings.')
      return
    }

    // Removing an own block only helps fully if no inherited block remains
    const blockedAfterToggle = wasBlocked ? inheritedFrom !== null : true

    // Optimistic update
    setIsBlocked(blockedAfterToggle)
    setIsOwnBlock(!wasBlocked)
    setIsLoading(true)

    // Update cache optimistically
    if (cacheKey) {
      setBlockStatus(cacheKey, blockedAfterToggle)
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
        if (blockedAfterToggle) {
          toast.success('Your block was removed, but this user is still blocked by a block list you follow')
        } else {
          toast.success('User unblocked')
        }
      } else if ('autoRevoked' in result && result.autoRevoked) {
        toast.success('User blocked and private feed access revoked')
      } else {
        toast.success('User blocked')
      }
    } catch (error) {
      // Rollback
      setIsBlocked(wasBlocked)
      setIsOwnBlock(wasOwnBlock)
      if (cacheKey) {
        setBlockStatus(cacheKey, wasBlocked)
      }
      logger.error('useBlock: Error toggling block:', error)
      toast.error('Failed to update block status')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId, targetUserId, isBlocked, isOwnBlock, inheritedFrom, isLoading, cacheKey, openLoginPrompt])

  const refresh = useCallback(() => {
    if (cacheKey) {
      deleteBlockStatus(cacheKey)
    }
    checkBlockStatus(true)
  }, [cacheKey, checkBlockStatus])

  return { isBlocked, isOwnBlock, inheritedFrom, isLoading, toggleBlock, refresh }
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
