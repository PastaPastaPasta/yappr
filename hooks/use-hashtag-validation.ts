'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Post } from '@/lib/types'
import { extractAllTags } from '@/lib/post-helpers'
import { hashtagValidationService } from '@/lib/services/hashtag-validation-service'

export type HashtagValidationStatus = 'pending' | 'valid' | 'invalid'

export interface HashtagValidationState {
  /** Map of hashtag (normalized, no #) to validation status */
  validations: Map<string, HashtagValidationStatus>
  /** Overall loading state */
  isLoading: boolean
  /** Trigger re-validation (clears cache for this post) */
  revalidate: () => void
}

/**
 * React hook to validate hashtags for a post.
 * Checks if each hashtag in the post content is registered on Dash Platform.
 *
 * @param post The post to validate hashtags for (or null to skip)
 * @returns Validation state with status per hashtag
 */
export function useHashtagValidation(post: Post | null): HashtagValidationState {
  const [validations, setValidations] = useState<Map<string, HashtagValidationStatus>>(
    new Map()
  )
  const [isLoading, setIsLoading] = useState(false)

  // Extract all tags (hashtags and cashtags) from post content
  const hashtags = useMemo(() => {
    if (!post?.content) return []
    return extractAllTags(post.content)
  }, [post?.content])

  // Stable post ID reference
  const postId = post?.id

  // Validate hashtags on mount and when post changes
  useEffect(() => {
    if (!postId || hashtags.length === 0) {
      setValidations(new Map())
      setIsLoading(false)
      return
    }

    let cancelled = false

    // Set all to pending initially
    setValidations(new Map(hashtags.map(h => [h, 'pending' as const])))
    setIsLoading(true)

    // Validate via service
    hashtagValidationService
      .validatePostHashtags(postId, post?.content || '')
      .then(results => {
        if (cancelled) return
        setValidations(results)
      })
      .catch(err => {
        if (cancelled) return
        logger.error('Hashtag validation failed:', err)
        // On error, mark all as valid (fail open - don't show false negatives)
        setValidations(new Map(hashtags.map(h => [h, 'valid' as const])))
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [postId, hashtags.join(','), post?.content])

  // Revalidate function to clear cache and re-fetch
  const revalidate = useCallback(() => {
    if (!postId) return

    // Invalidate cache for this post
    hashtagValidationService.invalidateCache(postId)

    // Reset to pending and re-fetch
    setValidations(new Map(hashtags.map(h => [h, 'pending' as const])))
    setIsLoading(true)

    hashtagValidationService
      .validatePostHashtags(postId, post?.content || '')
      .then(results => {
        setValidations(results)
      })
      .catch(err => {
        logger.error('Hashtag revalidation failed:', err)
        setValidations(new Map(hashtags.map(h => [h, 'valid' as const])))
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [postId, hashtags, post?.content])

  return { validations, isLoading, revalidate }
}
