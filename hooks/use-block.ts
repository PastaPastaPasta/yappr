'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { blockStatusCache } from '@/lib/caches/user-status-cache'
import type { BlockProvenance } from '@/lib/services/block-service'
import { useToggleRelation } from './use-toggle-relation'

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

/** Whether the viewer blocks `targetUserId`, with an optimistic toggle. */
export function useBlock(targetUserId: string, options: UseBlockOptions = {}): UseBlockResult {
  const { isOn, isLoading, toggle, refresh } = useToggleRelation<string | undefined, { success: boolean; error?: string; autoRevoked?: boolean }>({
    subjectId: targetUserId,
    initialValue: options.initialValue,
    cache: blockStatusCache,
    label: 'useBlock',
    selfError: 'You cannot block yourself',
    check: async (viewerId, subjectId) => {
      const { blockService } = await import('@/lib/services/block-service')
      return blockService.isBlocked(subjectId, viewerId)
    },
    turnOn: async (viewerId, subjectId, message) => {
      const { blockService } = await import('@/lib/services/block-service')
      return blockService.blockUser(viewerId, subjectId, message)
    },
    turnOff: async (viewerId, subjectId) => {
      const { blockService } = await import('@/lib/services/block-service')
      return blockService.unblockUser(viewerId, subjectId)
    },
    onMessage: (result) => (result.autoRevoked ? 'User blocked and private feed access revoked' : 'User blocked'),
    offMessage: 'User unblocked',
    failedMessage: () => 'Failed to update block status',
  })
  return { isBlocked: isOn, isLoading, toggleBlock: toggle, refresh }
}

const NOT_BLOCKED: BlockProvenance = { isBlocked: false, isOwnBlock: false, inheritedFrom: null }

export interface UseBlockProvenanceResult extends BlockProvenance {
  isLoading: boolean
  /**
   * Delete the viewer's own block document. An inherited block cannot be
   * lifted here, so provenance is re-resolved afterwards and may stay blocked.
   */
  unblock: () => Promise<void>
}

/**
 * Block status plus where it comes from, for UI that offers a remedy:
 * "Unblock" only works on the viewer's own block, while an inherited block
 * must be managed through followed block lists in settings.
 */
export function useBlockProvenance(targetUserId: string | undefined): UseBlockProvenanceResult {
  const { user } = useAuth()
  const viewerId = user?.identityId
  const [provenance, setProvenance] = useState<BlockProvenance>(NOT_BLOCKED)
  const [isLoading, setIsLoading] = useState(false)
  // Bumped per resolve so a slow response cannot overwrite a newer one.
  const requestRef = useRef(0)

  const resolve = useCallback(async (): Promise<BlockProvenance | null> => {
    const request = ++requestRef.current
    if (!viewerId || !targetUserId) {
      setProvenance(NOT_BLOCKED)
      setIsLoading(false)
      return NOT_BLOCKED
    }
    setIsLoading(true)
    try {
      const { blockService } = await import('@/lib/services/block-service')
      const next = await blockService.getBlockProvenance(targetUserId, viewerId)
      if (request !== requestRef.current) return null
      blockStatusCache.set(viewerId, targetUserId, next.isBlocked)
      setProvenance(next)
      return next
    } finally {
      if (request === requestRef.current) setIsLoading(false)
    }
  }, [viewerId, targetUserId])

  useEffect(() => {
    const requests = requestRef
    // A new viewer or target must not inherit the previous pair's banner.
    setProvenance(NOT_BLOCKED)
    resolve().catch((error) => logger.error('useBlockProvenance: status check failed:', error))
    return () => {
      requests.current++
    }
  }, [resolve])

  const { isOwnBlock, inheritedFrom } = provenance
  const unblock = useCallback(async () => {
    if (!viewerId || !targetUserId || isLoading || !isOwnBlock) return
    setIsLoading(true)
    try {
      const { blockService } = await import('@/lib/services/block-service')
      const result = await blockService.unblockUser(viewerId, targetUserId)
      if (!result.success) throw new Error(result.error || 'Failed to unblock user')
    } catch (error) {
      logger.error('useBlockProvenance: unblock failed:', error)
      toast.error('Failed to update block status')
      setIsLoading(false)
      return
    }
    // The own block is gone; a known inherited block still applies. The
    // re-check confirms that against the followed lists.
    const expected: BlockProvenance = { isBlocked: inheritedFrom !== null, isOwnBlock: false, inheritedFrom }
    setProvenance(expected)
    blockStatusCache.set(viewerId, targetUserId, expected.isBlocked)
    const after = await resolve().catch((error) => {
      logger.error('useBlockProvenance: status check after unblock failed:', error)
      return null
    })
    toast.success((after ?? expected).isBlocked
      ? 'Your block was removed, but a block list you follow still blocks this user'
      : 'User unblocked')
  }, [viewerId, targetUserId, isLoading, isOwnBlock, inheritedFrom, resolve])

  return { ...provenance, isLoading, unblock }
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
 * Drop posts whose author the viewer has blocked. A no-op for logged-out
 * viewers and empty lists; block lookups fail soft to "not blocked".
 */
export async function filterBlockedAuthors<T extends { author: { id: string } }>(
  viewerId: string | undefined,
  posts: T[]
): Promise<T[]> {
  if (!viewerId || posts.length === 0) return posts
  const authorIds = Array.from(new Set(posts.map((post) => post.author.id)))
  const blocked = await checkBlockedForAuthors(viewerId, authorIds)
  return posts.filter((post) => !blocked.get(post.author.id))
}
