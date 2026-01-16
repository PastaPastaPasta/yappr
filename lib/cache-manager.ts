/**
 * Centralized cache management for yappr
 * Provides coordinated caching with proper invalidation strategies
 */

export interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number
  tags?: string[]
}

export interface CacheOptions {
  ttl?: number
  tags?: string[]
}

export class CacheManager {
  private caches = new Map<string, Map<string, CacheEntry<unknown>>>()
  private tagIndex = new Map<string, Set<string>>()
  private cleanupInterval?: NodeJS.Timeout

  constructor(private defaultTtl: number = 300000) { // 5 minutes default
    this.startCleanup()
  }

  /**
   * Get or create a named cache
   */
  private getCache(cacheName: string): Map<string, CacheEntry<unknown>> {
    let cache = this.caches.get(cacheName)
    if (!cache) {
      cache = new Map()
      this.caches.set(cacheName, cache)
    }
    return cache
  }

  /**
   * Set a cache entry
   */
  set<T>(
    cacheName: string,
    key: string,
    data: T,
    options: CacheOptions = {}
  ): void {
    const cache = this.getCache(cacheName)
    const { ttl = this.defaultTtl, tags = [] } = options

    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl,
      tags
    }

    cache.set(key, entry)

    // Update tag index
    const cacheKey = `${cacheName}:${key}`
    tags.forEach(tag => {
      let tagSet = this.tagIndex.get(tag)
      if (!tagSet) {
        tagSet = new Set()
        this.tagIndex.set(tag, tagSet)
      }
      tagSet.add(cacheKey)
    })
  }

  /**
   * Get a cache entry
   */
  get<T>(cacheName: string, key: string): T | null {
    const cache = this.getCache(cacheName)
    const entry = cache.get(key)

    if (!entry) {
      return null
    }

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.delete(cacheName, key)
      return null
    }

    return entry.data
  }

  /**
   * Check if a cache entry exists and is valid
   */
  has(cacheName: string, key: string): boolean {
    return this.get(cacheName, key) !== null
  }

  /**
   * Delete a specific cache entry
   */
  delete(cacheName: string, key: string): boolean {
    const cache = this.getCache(cacheName)
    const entry = cache.get(key)
    
    if (entry) {
      // Remove from tag index
      const cacheKey = `${cacheName}:${key}`
      entry.tags?.forEach(tag => {
        this.tagIndex.get(tag)?.delete(cacheKey)
        if (this.tagIndex.get(tag)?.size === 0) {
          this.tagIndex.delete(tag)
        }
      })
    }

    return cache.delete(key)
  }

  /**
   * Clear all entries in a named cache
   */
  clear(cacheName: string): void {
    const cache = this.getCache(cacheName)
    
    // Remove all entries from tag index
    for (const [key, entry] of Array.from(cache.entries())) {
      const cacheKey = `${cacheName}:${key}`
      entry.tags?.forEach(tag => {
        this.tagIndex.get(tag)?.delete(cacheKey)
        if (this.tagIndex.get(tag)?.size === 0) {
          this.tagIndex.delete(tag)
        }
      })
    }
    
    cache.clear()
  }

  /**
   * Invalidate all cache entries with specific tags
   */
  invalidateByTag(tag: string): number {
    const entries = this.tagIndex.get(tag)
    if (!entries) {
      return 0
    }

    let invalidated = 0
    for (const cacheKey of Array.from(entries)) {
      const [cacheName, key] = cacheKey.split(':', 2)
      if (this.delete(cacheName, key)) {
        invalidated++
      }
    }

    return invalidated
  }

  /**
   * Invalidate multiple tags
   */
  invalidateByTags(tags: string[]): number {
    let totalInvalidated = 0
    tags.forEach(tag => {
      totalInvalidated += this.invalidateByTag(tag)
    })
    return totalInvalidated
  }

  /**
   * Get cache statistics
   */
  getStats(cacheName?: string): {
    caches: string[]
    totalEntries: number
    totalTags: number
    cacheDetails?: { [cacheName: string]: { entries: number; expired: number } }
  } {
    const cacheNames = cacheName ? [cacheName] : Array.from(this.caches.keys())
    let totalEntries = 0
    const cacheDetails: { [name: string]: { entries: number; expired: number } } = {}

    cacheNames.forEach(name => {
      const cache = this.caches.get(name)
      if (cache) {
        let expired = 0
        const now = Date.now()
        
        for (const entry of Array.from(cache.values())) {
          if (now - entry.timestamp > entry.ttl) {
            expired++
          }
        }
        
        cacheDetails[name] = {
          entries: cache.size,
          expired
        }
        totalEntries += cache.size
      }
    })

    return {
      caches: Array.from(this.caches.keys()),
      totalEntries,
      totalTags: this.tagIndex.size,
      ...(cacheName ? {} : { cacheDetails })
    }
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    let cleaned = 0
    const now = Date.now()

    for (const [cacheName, cache] of Array.from(this.caches.entries())) {
      const expiredKeys: string[] = []
      
      for (const [key, entry] of Array.from(cache.entries())) {
        if (now - entry.timestamp > entry.ttl) {
          expiredKeys.push(key)
        }
      }
      
      expiredKeys.forEach(key => {
        if (this.delete(cacheName, key)) {
          cleaned++
        }
      })
    }

    console.log(`Cache cleanup: removed ${cleaned} expired entries`)
    return cleaned
  }

  /**
   * Start automatic cleanup
   */
  private startCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
    
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, 60000) // Cleanup every minute
  }

  /**
   * Stop automatic cleanup
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.caches.clear()
    this.tagIndex.clear()
  }
}

// Singleton instance
export const cacheManager = new CacheManager()

// Cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    cacheManager.stopCleanup()
  })
}

/**
 * Cache decorator for methods
 */
export function cached(
  cacheName: string,
  keyGenerator?: (...args: unknown[]) => string,
  options: CacheOptions = {}
) {
  return function (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args: unknown[]) {
      const key = keyGenerator ? keyGenerator(...args) : JSON.stringify(args)
      
      // Try to get from cache
      const cached = cacheManager.get(cacheName, key)
      if (cached !== null) {
        return cached
      }

      // Execute original method
      const result = await originalMethod.apply(this, args)
      
      // Cache the result
      cacheManager.set(cacheName, key, result, options)
      
      return result
    }

    return descriptor
  }
}

export default cacheManager