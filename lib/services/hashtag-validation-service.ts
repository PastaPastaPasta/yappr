import { hashtagService, PostHashtagDocument } from './hashtag-service'
import { extractAllTags } from '../post-helpers'

export interface HashtagValidationKey {
  postId: string
  hashtag: string // normalized, lowercase, no #
}

interface CacheEntry {
  registeredHashtags: Set<string> // All registered hashtags for this post
  timestamp: number
}

interface PendingRequest {
  postId: string
  resolvers: Array<(registeredHashtags: Set<string>) => void>
}

/**
 * Service for validating hashtag registration with batching, caching, and deduplication.
 *
 * Design:
 * - Caches at post level (all registered hashtags for a post)
 * - Batches requests with 10ms debounce (DataLoader pattern)
 * - Deduplicates in-flight requests for the same post
 */
class HashtagValidationService {
  private cache = new Map<string, CacheEntry>()
  private readonly CACHE_TTL = 300000 // 5 minutes

  // DataLoader-style batching: collect requests for 10ms before processing
  private pendingRequests = new Map<string, PendingRequest>()
  private batchTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly BATCH_DELAY = 10 // ms

  // In-flight deduplication: share promise for same postId
  private inFlightRequests = new Map<string, Promise<Set<string>>>()

  /**
   * Validate a single hashtag for a post.
   * Returns true if the hashtag is registered, false otherwise.
   */
  async validateHashtag(postId: string, hashtag: string): Promise<boolean> {
    const normalizedTag = hashtag.toLowerCase().replace(/^#/, '')
    const registeredHashtags = await this.getRegisteredHashtagsForPost(postId)
    return registeredHashtags.has(normalizedTag)
  }

  /**
   * Validate multiple hashtags for posts.
   * Returns a Map of "postId:hashtag" -> boolean (true if registered).
   */
  async validateHashtagsBatch(
    keys: HashtagValidationKey[]
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>()

    // Group by postId for efficient fetching
    const postIds = Array.from(new Set(keys.map(k => k.postId)))

    // Fetch registered hashtags for all posts in parallel
    const postHashtagsMap = new Map<string, Set<string>>()
    await Promise.all(
      postIds.map(async postId => {
        const registered = await this.getRegisteredHashtagsForPost(postId)
        postHashtagsMap.set(postId, registered)
      })
    )

    // Check each key against registered hashtags
    for (const key of keys) {
      const cacheKey = `${key.postId}:${key.hashtag}`
      const registered = postHashtagsMap.get(key.postId) || new Set()
      result.set(cacheKey, registered.has(key.hashtag))
    }

    return result
  }

  /**
   * Validate all tags (hashtags and cashtags) in a post's content.
   * Returns a Map of tag -> 'valid' | 'invalid'.
   */
  async validatePostHashtags(
    postId: string,
    content: string
  ): Promise<Map<string, 'valid' | 'invalid'>> {
    const hashtags = extractAllTags(content)
    const result = new Map<string, 'valid' | 'invalid'>()

    if (hashtags.length === 0) {
      return result
    }

    const registeredHashtags = await this.getRegisteredHashtagsForPost(postId)

    for (const tag of hashtags) {
      result.set(tag, registeredHashtags.has(tag) ? 'valid' : 'invalid')
    }

    return result
  }

  /**
   * Invalidate cache for a specific post.
   * Call this after successfully registering a hashtag.
   */
  invalidateCache(postId: string): void {
    this.cache.delete(postId)
  }

  /**
   * Invalidate a specific hashtag entry (after registration).
   * Since we cache at post level, this invalidates the whole post cache.
   */
  invalidateCacheEntry(postId: string, _hashtag: string): void {
    this.cache.delete(postId)
  }

  /**
   * Clear all cached data.
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Get registered hashtags for a post.
   * Uses caching and request deduplication.
   */
  private async getRegisteredHashtagsForPost(postId: string): Promise<Set<string>> {
    // Check cache first
    const cached = this.cache.get(postId)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.registeredHashtags
    }

    // Check for in-flight request
    const inFlight = this.inFlightRequests.get(postId)
    if (inFlight) {
      return inFlight
    }

    // Create promise and schedule batch
    return new Promise<Set<string>>(resolve => {
      const existing = this.pendingRequests.get(postId)
      if (existing) {
        existing.resolvers.push(resolve)
      } else {
        this.pendingRequests.set(postId, {
          postId,
          resolvers: [resolve]
        })
      }
      this.scheduleBatch()
    })
  }

  /**
   * Schedule batch processing with debounce.
   */
  private scheduleBatch(): void {
    if (this.batchTimeout !== null) {
      return // Already scheduled
    }

    this.batchTimeout = setTimeout(() => {
      this.batchTimeout = null
      void this.processBatch()
    }, this.BATCH_DELAY)
  }

  /**
   * Process all pending requests in a batch.
   */
  private async processBatch(): Promise<void> {
    const batch = new Map(this.pendingRequests)
    this.pendingRequests.clear()

    if (batch.size === 0) return

    // Process each postId
    const promises = Array.from(batch.entries()).map(async ([postId, request]) => {
      // Create in-flight promise for deduplication
      const promise = this.fetchRegisteredHashtags(postId)
      this.inFlightRequests.set(postId, promise)

      try {
        const registeredHashtags = await promise

        // Cache the result
        this.cache.set(postId, {
          registeredHashtags,
          timestamp: Date.now()
        })

        // Resolve all waiting callers
        request.resolvers.forEach(resolve => resolve(registeredHashtags))
      } catch (error) {
        console.error(`Failed to fetch hashtags for post ${postId}:`, error)
        // On error, return empty set (fail open)
        const emptySet = new Set<string>()
        request.resolvers.forEach(resolve => resolve(emptySet))
      } finally {
        // Clear in-flight after short delay to allow rapid successive calls
        setTimeout(() => {
          this.inFlightRequests.delete(postId)
        }, 100)
      }
    })

    await Promise.all(promises)
  }

  /**
   * Fetch registered hashtags from Dash Platform.
   */
  private async fetchRegisteredHashtags(postId: string): Promise<Set<string>> {
    try {
      const documents = await hashtagService.getHashtagsForPost(postId)
      return new Set(documents.map((doc: PostHashtagDocument) => doc.hashtag))
    } catch (error) {
      console.error(`Error fetching hashtags for post ${postId}:`, error)
      // Return empty set on error (fail open - don't show false negatives)
      return new Set()
    }
  }
}

// Singleton instance
export const hashtagValidationService = new HashtagValidationService()
