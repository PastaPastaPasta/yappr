'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import type { EncryptionSource } from '@/lib/services/post-service'
import { isPrivatePost } from '@/components/post/private-post-content'

/**
 * A reply in a private thread is encrypted to the thread root's feed (PRD
 * §5.5). This resolves the source while the composer is open on a reply to
 * private content: none for a private reply under a public root (the thread
 * is public, so the visibility is the replier's choice); an error (the thread
 * could not be read) blocks posting until a retry succeeds.
 */
export function useInheritedEncryption(isOpen: boolean, replyingTo: Post | null) {
  const [source, setSource] = useState<EncryptionSource | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // The post the current answer is for: until it matches, nothing is settled (no public-reply window on open).
  const [checkedId, setCheckedId] = useState<string | null>(null)

  const check = useCallback(async (post: Post, isCurrent: () => boolean = () => true) => {
    setLoading(true)
    setError(false)
    try {
      if (!isPrivatePost(post)) {
        if (isCurrent()) {
          setSource(null)
          setCheckedId(post.id)
        }
        return
      }
      const { getEncryptionSource } = await import('@/lib/services/post-service')
      const resolved = await getEncryptionSource(post)
      if (!isCurrent()) return
      setSource(resolved)
      setCheckedId(post.id)
    } catch (err) {
      logger.error('Failed to check inherited encryption:', err)
      if (!isCurrent()) return
      setError(isPrivatePost(post))
      setSource(null)
      setCheckedId(post.id)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen || !replyingTo) {
      setSource(null)
      setLoading(false)
      setError(false)
      setCheckedId(null)
      return
    }
    let cancelled = false
    check(replyingTo, () => !cancelled).catch((err) => logger.error('Failed to check inherited encryption:', err))
    return () => {
      cancelled = true
    }
  }, [isOpen, replyingTo, check])

  const retry = useCallback(() => {
    if (replyingTo) check(replyingTo).catch((err) => logger.error('Failed to check inherited encryption:', err))
  }, [replyingTo, check])

  const ready = !!replyingTo && checkedId === replyingTo.id && !loading
  return { source, loading, error, ready, retry }
}
