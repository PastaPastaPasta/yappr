import { useRef, useState, useCallback, useEffect } from 'react'
import { Post } from '@/lib/types'
import { postService } from '@/lib/services/post-service'

interface UsePostEnrichmentOptions {
  /** Callback when enrichment completes with enriched posts */
  onEnriched?: (posts: Post[]) => void
  /** Skip enrichment entirely */
  disabled?: boolean
}

interface UsePostEnrichmentResult {
  /** Trigger enrichment for the given posts */
  enrich: (posts: Post[]) => Promise<Post[]>
  /** Whether enrichment is currently in progress */
  isEnriching: boolean
  /** Reset the deduplication tracking (useful for refresh) */
  reset: () => void
}

/**
 * Hook for batch enriching posts with deduplication.
 *
 * Handles:
 * - Batch fetching of stats, interactions, usernames, and profiles
 * - Deduplication based on batch ID (sorted post IDs)
 * - Prevents concurrent enrichment requests
 *
 * @example
 * ```tsx
 * const { enrich, isEnriching } = usePostEnrichment({
 *   onEnriched: (enrichedPosts) => setPosts(enrichedPosts)
 * })
 *
 * // After loading posts:
 * await enrich(loadedPosts)
 * ```
 */
export function usePostEnrichment(
  options: UsePostEnrichmentOptions = {}
): UsePostEnrichmentResult {
  const { onEnriched, disabled = false } = options

  const lastBatchIdRef = useRef<string | null>(null)
  const enrichingRef = useRef(false)
  const [isEnriching, setIsEnriching] = useState(false)

  // Store callback in ref to avoid dependency issues and infinite loops
  const onEnrichedRef = useRef(onEnriched)
  useEffect(() => {
    onEnrichedRef.current = onEnriched
  })

  const enrich = useCallback(async (posts: Post[]): Promise<Post[]> => {
    if (disabled || posts.length === 0) return posts

    // Generate batch ID from sorted post IDs
    const batchId = posts.map(p => p.id).sort().join(',')

    // Skip if same batch already enriched or in progress
    if (lastBatchIdRef.current === batchId || enrichingRef.current) {
      return posts
    }

    enrichingRef.current = true
    setIsEnriching(true)
    lastBatchIdRef.current = batchId

    try {
      const enriched = await postService.enrichPostsBatch(posts)
      onEnrichedRef.current?.(enriched)
      return enriched
    } catch (error) {
      console.error('usePostEnrichment: Failed to enrich posts:', error)
      return posts
    } finally {
      enrichingRef.current = false
      setIsEnriching(false)
    }
  }, [disabled])

  const reset = useCallback(() => {
    lastBatchIdRef.current = null
    enrichingRef.current = false
  }, [])

  // Reset tracking on unmount
  useEffect(() => {
    return () => {
      lastBatchIdRef.current = null
      enrichingRef.current = false
    }
  }, [])

  return { enrich, isEnriching, reset }
}
