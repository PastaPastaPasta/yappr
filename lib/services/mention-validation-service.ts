import { mentionService, PostMentionDocument } from './mention-service'
import { extractMentions, normalizeDpnsUsername } from '../post-helpers'
import { dpnsService } from './dpns-service'

export interface MentionValidationKey {
  postId: string
  username: string // normalized, lowercase, no @
}

interface CacheEntry {
  registeredMentions: Set<string> // All registered mentions for this post (usernames)
  timestamp: number
}

interface PendingRequest {
  postId: string
  resolvers: Array<(registeredMentions: Set<string>) => void>
}

/**
 * Service for validating mention registration with batching, caching, and deduplication.
 *
 * Design:
 * - Caches at post level (all registered mentions for a post)
 * - Batches requests with 10ms debounce (DataLoader pattern)
 * - Deduplicates in-flight requests for the same post
 * - Resolves identity IDs back to usernames for comparison
 */
class MentionValidationService {
  private cache = new Map<string, CacheEntry>()
  private readonly CACHE_TTL = 300000 // 5 minutes

  // DataLoader-style batching: collect requests for 10ms before processing
  private pendingRequests = new Map<string, PendingRequest>()
  private batchTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly BATCH_DELAY = 10 // ms

  // In-flight deduplication: share promise for same postId
  private inFlightRequests = new Map<string, Promise<Set<string>>>()

  /**
   * Validate a single mention for a post.
   * Returns true if the mention is registered, false otherwise.
   */
  async validateMention(postId: string, username: string): Promise<boolean> {
    const normalizedUsername = normalizeDpnsUsername(username.replace(/^@/, ''))
    const registeredMentions = await this.getRegisteredMentionsForPost(postId)
    return registeredMentions.has(normalizedUsername)
  }

  /**
   * Validate multiple mentions for posts.
   * Returns a Map of "postId:username" -> boolean (true if registered).
   */
  async validateMentionsBatch(
    keys: MentionValidationKey[]
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>()

    // Group by postId for efficient fetching
    const postIds = Array.from(new Set(keys.map(k => k.postId)))

    // Fetch registered mentions for all posts in parallel
    const postMentionsMap = new Map<string, Set<string>>()
    await Promise.all(
      postIds.map(async postId => {
        const registered = await this.getRegisteredMentionsForPost(postId)
        postMentionsMap.set(postId, registered)
      })
    )

    // Check each key against registered mentions
    for (const key of keys) {
      const cacheKey = `${key.postId}:${key.username}`
      const registered = postMentionsMap.get(key.postId) || new Set()
      result.set(cacheKey, registered.has(key.username))
    }

    return result
  }

  /**
   * Validate all mentions in a post's content.
   * Returns a Map of username -> 'valid' | 'invalid'.
   */
  async validatePostMentions(
    postId: string,
    content: string
  ): Promise<Map<string, 'valid' | 'invalid'>> {
    const mentions = extractMentions(content)
    const result = new Map<string, 'valid' | 'invalid'>()

    if (mentions.length === 0) {
      return result
    }

    const registeredMentions = await this.getRegisteredMentionsForPost(postId)

    for (const username of mentions) {
      result.set(username, registeredMentions.has(username) ? 'valid' : 'invalid')
    }

    return result
  }

  /**
   * Invalidate cache for a specific post.
   * Call this after successfully registering a mention.
   */
  invalidateCache(postId: string): void {
    this.cache.delete(postId)
  }

  /**
   * Invalidate a specific mention entry (after registration).
   * Since we cache at post level, this invalidates the whole post cache.
   */
  invalidateCacheEntry(postId: string, _username: string): void {
    this.cache.delete(postId)
  }

  /**
   * Clear all cached data.
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Get registered mentions for a post.
   * Uses caching and request deduplication.
   */
  private async getRegisteredMentionsForPost(postId: string): Promise<Set<string>> {
    // Check cache first
    const cached = this.cache.get(postId)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.registeredMentions
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
      this.processBatch()
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
      const promise = this.fetchRegisteredMentions(postId)
      this.inFlightRequests.set(postId, promise)

      try {
        const registeredMentions = await promise

        // Cache the result
        this.cache.set(postId, {
          registeredMentions,
          timestamp: Date.now()
        })

        // Resolve all waiting callers
        request.resolvers.forEach(resolve => resolve(registeredMentions))
      } catch (error) {
        console.error(`Failed to fetch mentions for post ${postId}:`, error)
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
   * Fetch registered mentions from Dash Platform.
   * Converts identity IDs back to usernames for comparison.
   */
  private async fetchRegisteredMentions(postId: string): Promise<Set<string>> {
    try {
      const documents = await mentionService.getMentionsForPost(postId)

      if (documents.length === 0) {
        return new Set()
      }

      // Resolve identity IDs back to usernames
      const identityIds = documents.map((doc: PostMentionDocument) => doc.mentionedUserId)
      const usernamesMap = await dpnsService.resolveUsernamesBatch(identityIds)

      // Build set of usernames (normalized: lowercase, no .dash suffix)
      const usernames = new Set<string>()
      usernamesMap.forEach((username) => {
        if (username) {
          usernames.add(normalizeDpnsUsername(username))
        }
      })

      return usernames
    } catch (error) {
      console.error(`Error fetching mentions for post ${postId}:`, error)
      // Return empty set on error (fail open - don't show false negatives)
      return new Set()
    }
  }
}

// Singleton instance
export const mentionValidationService = new MentionValidationService()
