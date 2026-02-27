'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Post } from '@/lib/types'
import { extractMentions } from '@/lib/post-helpers'
import { mentionValidationService } from '@/lib/services/mention-validation-service'

export type MentionValidationStatus = 'pending' | 'valid' | 'invalid'

export interface MentionValidationState {
  /** Map of username (normalized, no @) to validation status */
  validations: Map<string, MentionValidationStatus>
  /** Overall loading state */
  isLoading: boolean
  /** Trigger re-validation (clears cache for this post) */
  revalidate: () => void
}

/**
 * React hook to validate mentions for a post.
 * Checks if each mention in the post content has a corresponding mention document on Dash Platform.
 *
 * @param post The post to validate mentions for (or null to skip)
 * @returns Validation state with status per mention
 */
export function useMentionValidation(post: Post | null): MentionValidationState {
  const [validations, setValidations] = useState<Map<string, MentionValidationStatus>>(
    new Map()
  )
  const [isLoading, setIsLoading] = useState(false)

  // Extract mentions from post content
  const mentions = useMemo(() => {
    if (!post?.content) return []
    return extractMentions(post.content)
  }, [post?.content])

  // Stable post ID reference
  const postId = post?.id

  // Validate mentions on mount and when post changes
  useEffect(() => {
    if (!postId || mentions.length === 0) {
      setValidations(new Map())
      setIsLoading(false)
      return
    }

    let cancelled = false

    // Set all to pending initially
    setValidations(new Map(mentions.map(m => [m, 'pending' as const])))
    setIsLoading(true)

    // Validate via service
    mentionValidationService
      .validatePostMentions(postId, post?.content || '')
      .then(results => {
        if (cancelled) return
        setValidations(results)
      })
      .catch(err => {
        if (cancelled) return
        logger.error('Mention validation failed:', err)
        // On error, mark all as valid (fail open - don't show false negatives)
        setValidations(new Map(mentions.map(m => [m, 'valid' as const])))
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [postId, mentions.join(','), post?.content])

  // Revalidate function to clear cache and re-fetch
  const revalidate = useCallback(() => {
    if (!postId) return

    // Invalidate cache for this post
    mentionValidationService.invalidateCache(postId)

    // Reset to pending and re-fetch
    setValidations(new Map(mentions.map(m => [m, 'pending' as const])))
    setIsLoading(true)

    mentionValidationService
      .validatePostMentions(postId, post?.content || '')
      .then(results => {
        setValidations(results)
      })
      .catch(err => {
        logger.error('Mention revalidation failed:', err)
        setValidations(new Map(mentions.map(m => [m, 'valid' as const])))
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [postId, mentions, post?.content])

  return { validations, isLoading, revalidate }
}
