'use client'

import { logger } from '@/lib/logger'
import { blockStatusCache } from '@/lib/caches/user-status-cache'
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
    loginAction: 'block',
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
