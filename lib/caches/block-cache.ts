/**
 * SessionStorage-based cache for block system data.
 * Stores: own blocks, followed blockers, merged bloom filter, and confirmed blocks.
 *
 * This cache persists across page navigations within a session and is cleared
 * when the browser tab is closed.
 */

import { BloomFilter, bloomFilterToBase64, bloomFilterFromBase64 } from '../bloom-filter'

const CACHE_KEY_PREFIX = 'yappr_block_cache_'
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes for full data refresh

export interface ConfirmedBlock {
  isBlocked: boolean
  blockedBy: string // userId who blocked them (self or followed user)
  message?: string // Block message if available
  timestamp: number
}

export interface BlockCacheData {
  // Own blocks - list of users we've blocked
  ownBlocks: {
    blockedIds: string[]
    timestamp: number
  }

  // Block follows - users whose blocks we inherit
  blockFollows: {
    followedUserIds: string[]
    timestamp: number
  }

  // Merged bloom filter from all sources (self + followed)
  mergedBloomFilter: {
    data: string // base64 encoded
    itemCount: number
    sourceUsers: string[] // Users who contributed to the filter
    timestamp: number
  } | null

  // Confirmed blocks from bloom filter positives (queried and verified)
  confirmedBlocks: Record<string, ConfirmedBlock>
}

function getCacheKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}`
}

function getEmptyCache(): BlockCacheData {
  return {
    ownBlocks: { blockedIds: [], timestamp: 0 },
    blockFollows: { followedUserIds: [], timestamp: 0 },
    mergedBloomFilter: null,
    confirmedBlocks: {}
  }
}

/**
 * Load block cache from sessionStorage.
 * Returns null if cache is stale or doesn't exist.
 */
export function loadBlockCache(userId: string): BlockCacheData | null {
  if (typeof window === 'undefined') return null

  try {
    const key = getCacheKey(userId)
    const raw = sessionStorage.getItem(key)
    if (!raw) return null

    const data = JSON.parse(raw) as BlockCacheData

    // Check if cache is stale
    const now = Date.now()
    if (now - data.ownBlocks.timestamp > CACHE_TTL) {
      return null // Force refresh
    }

    return data
  } catch {
    return null
  }
}

/**
 * Save block cache to sessionStorage.
 */
export function saveBlockCache(userId: string, data: BlockCacheData): void {
  if (typeof window === 'undefined') return

  try {
    const key = getCacheKey(userId)
    sessionStorage.setItem(key, JSON.stringify(data))
  } catch {
    // SessionStorage full or unavailable - fail silently
  }
}

/**
 * Invalidate the block cache for a user.
 */
export function invalidateBlockCache(userId: string): void {
  if (typeof window === 'undefined') return

  const key = getCacheKey(userId)
  sessionStorage.removeItem(key)
}

/**
 * Update own blocks in the cache.
 */
export function setOwnBlocks(userId: string, blockedIds: string[]): void {
  const cache = loadBlockCache(userId) || getEmptyCache()
  cache.ownBlocks = {
    blockedIds,
    timestamp: Date.now()
  }
  saveBlockCache(userId, cache)
}

/**
 * Add a block to own blocks cache.
 */
export function addOwnBlock(userId: string, blockedId: string): void {
  const cache = loadBlockCache(userId) || getEmptyCache()
  if (!cache.ownBlocks.blockedIds.includes(blockedId)) {
    cache.ownBlocks.blockedIds.push(blockedId)
    cache.ownBlocks.timestamp = Date.now()
  }
  // Also add to confirmed blocks
  cache.confirmedBlocks[blockedId] = {
    isBlocked: true,
    blockedBy: userId,
    timestamp: Date.now()
  }
  saveBlockCache(userId, cache)
}

/**
 * Remove a block from own blocks cache.
 */
export function removeOwnBlock(userId: string, blockedId: string): void {
  const cache = loadBlockCache(userId) || getEmptyCache()
  cache.ownBlocks.blockedIds = cache.ownBlocks.blockedIds.filter(id => id !== blockedId)
  cache.ownBlocks.timestamp = Date.now()
  // Remove from confirmed blocks
  delete cache.confirmedBlocks[blockedId]
  saveBlockCache(userId, cache)
}

/**
 * Update block follows in the cache.
 */
export function setBlockFollows(userId: string, followedUserIds: string[]): void {
  const cache = loadBlockCache(userId) || getEmptyCache()
  cache.blockFollows = {
    followedUserIds,
    timestamp: Date.now()
  }
  saveBlockCache(userId, cache)
}

/**
 * Update merged bloom filter in the cache.
 */
export function setMergedBloomFilter(
  userId: string,
  filter: BloomFilter,
  sourceUsers: string[]
): void {
  const cache = loadBlockCache(userId) || getEmptyCache()
  cache.mergedBloomFilter = {
    data: bloomFilterToBase64(filter),
    itemCount: filter.itemCount,
    sourceUsers,
    timestamp: Date.now()
  }
  saveBlockCache(userId, cache)
}

/**
 * Get the merged bloom filter from cache.
 */
export function getMergedBloomFilter(userId: string): BloomFilter | null {
  const cache = loadBlockCache(userId)
  if (!cache?.mergedBloomFilter) return null

  return bloomFilterFromBase64(
    cache.mergedBloomFilter.data,
    cache.mergedBloomFilter.itemCount
  )
}

/**
 * Add a confirmed block result from bloom filter verification.
 */
export function addConfirmedBlock(
  userId: string,
  targetId: string,
  blockedBy: string,
  isBlocked: boolean,
  message?: string
): void {
  const cache = loadBlockCache(userId) || getEmptyCache()
  cache.confirmedBlocks[targetId] = {
    isBlocked,
    blockedBy,
    message,
    timestamp: Date.now()
  }
  saveBlockCache(userId, cache)
}

/**
 * Get confirmed block status from cache.
 * Returns undefined if not in cache.
 */
export function getConfirmedBlock(userId: string, targetId: string): ConfirmedBlock | undefined {
  const cache = loadBlockCache(userId)
  return cache?.confirmedBlocks[targetId]
}

/**
 * Batch add confirmed block results.
 */
export function addConfirmedBlocksBatch(
  userId: string,
  results: Map<string, { blockedBy: string; isBlocked: boolean; message?: string }>
): void {
  const cache = loadBlockCache(userId) || getEmptyCache()
  const now = Date.now()

  results.forEach((result, targetId) => {
    cache.confirmedBlocks[targetId] = {
      isBlocked: result.isBlocked,
      blockedBy: result.blockedBy,
      message: result.message,
      timestamp: now
    }
  })

  saveBlockCache(userId, cache)
}

/**
 * Check if a user is in own blocks (from cache).
 */
export function isInOwnBlocks(userId: string, targetId: string): boolean {
  const cache = loadBlockCache(userId)
  return cache?.ownBlocks.blockedIds.includes(targetId) ?? false
}

/**
 * Get all block follows from cache.
 */
export function getBlockFollowsFromCache(userId: string): string[] {
  const cache = loadBlockCache(userId)
  return cache?.blockFollows.followedUserIds ?? []
}

/**
 * Initialize block cache with full data.
 * Called after querying all block data on page load.
 */
export function initializeBlockCache(
  userId: string,
  ownBlockedIds: string[],
  followedUserIds: string[],
  mergedFilter: BloomFilter | null,
  filterSourceUsers: string[]
): void {
  const now = Date.now()
  const cache: BlockCacheData = {
    ownBlocks: {
      blockedIds: ownBlockedIds,
      timestamp: now
    },
    blockFollows: {
      followedUserIds,
      timestamp: now
    },
    mergedBloomFilter: mergedFilter ? {
      data: bloomFilterToBase64(mergedFilter),
      itemCount: mergedFilter.itemCount,
      sourceUsers: filterSourceUsers,
      timestamp: now
    } : null,
    confirmedBlocks: {}
  }

  // Pre-populate confirmed blocks with own blocks
  for (const blockedId of ownBlockedIds) {
    cache.confirmedBlocks[blockedId] = {
      isBlocked: true,
      blockedBy: userId,
      timestamp: now
    }
  }

  saveBlockCache(userId, cache)
}
