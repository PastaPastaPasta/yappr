/**
 * Shared cache for user block/follow status.
 * Used by both hooks (for individual checks) and services (for batch seeding).
 * This allows batch operations to pre-populate the cache before hooks mount.
 */

const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

// Block status cache
const blockCache = new Map<string, { isBlocked: boolean; timestamp: number }>()

export function getBlockStatus(cacheKey: string): boolean | null {
  const cached = blockCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.isBlocked
  }
  return null
}

export function setBlockStatus(cacheKey: string, isBlocked: boolean): void {
  blockCache.set(cacheKey, { isBlocked, timestamp: Date.now() })
}

export function deleteBlockStatus(cacheKey: string): void {
  blockCache.delete(cacheKey)
}

export function clearBlockCache(): void {
  blockCache.clear()
}

/**
 * Seed block status cache from batch results.
 * Call this after batch fetching to pre-populate before hooks mount.
 */
export function seedBlockStatusCache(
  blockerId: string,
  statusMap: Map<string, boolean>
): void {
  if (!blockerId) return
  const now = Date.now()
  statusMap.forEach((isBlocked, targetUserId) => {
    const cacheKey = `${blockerId}:${targetUserId}`
    blockCache.set(cacheKey, { isBlocked, timestamp: now })
  })
}

// Follow status cache
const followCache = new Map<string, { isFollowing: boolean; timestamp: number }>()

export function getFollowStatus(cacheKey: string): boolean | null {
  const cached = followCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.isFollowing
  }
  return null
}

export function setFollowStatus(cacheKey: string, isFollowing: boolean): void {
  followCache.set(cacheKey, { isFollowing, timestamp: Date.now() })
}

export function deleteFollowStatus(cacheKey: string): void {
  followCache.delete(cacheKey)
}

export function clearFollowCache(): void {
  followCache.clear()
}

/**
 * Seed follow status cache from batch results.
 * Call this after batch fetching to pre-populate before hooks mount.
 */
export function seedFollowStatusCache(
  followerId: string,
  statusMap: Map<string, boolean>
): void {
  if (!followerId) return
  const now = Date.now()
  statusMap.forEach((isFollowing, targetUserId) => {
    const cacheKey = `${followerId}:${targetUserId}`
    followCache.set(cacheKey, { isFollowing, timestamp: now })
  })
}
