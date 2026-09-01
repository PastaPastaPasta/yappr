'use client'

import { useEffect, useRef, useState } from 'react'
import type { Post } from '@/lib/types'
import { logger } from '@/lib/logger'
import { getCachedQuotedPost, quoteTargetOf, resolveQuotedPost } from '@/lib/feed/resolve-quoted-posts'

export interface UseQuotedPostResult {
  /** The quoted post, from the batch pass or the fallback fetch. */
  quotedPost: Post | null
  /** True while the fallback fetch is pending (including the grace period). */
  loading: boolean
  /** True when resolution finished and the target could not be loaded. */
  unavailable: boolean
}

/**
 * Give the surface's batch pass (`attachQuotedPosts`) this long to deliver the
 * quote before falling back to a per-card fetch. Keeps a feed of quote posts
 * from turning one batch query into N per-card queries on first paint.
 */
const BATCH_GRACE_MS = 2000

/**
 * Per-card quote resolution. Feed loaders resolve quotes in batch via
 * `attachQuotedPosts`; this hook covers the cards that arrive without one —
 * surfaces that skipped the batch pass, or batch lookups that hit a transient
 * DAPI failure — so a quote embed never sits on a skeleton forever.
 */
export function useQuotedPost(post: Post): UseQuotedPostResult {
  const attached = post.quotedPost ?? null
  const targetId = quoteTargetOf(post)?.id ?? null

  const [fetched, setFetched] = useState<Post | null>(null)
  const [settled, setSettled] = useState(false)

  // The fetch effect keys on targetId, not post identity: a like/repost pass
  // replacing the post object must not restart resolution. The ref keeps the
  // effect reading the current object without depending on it.
  const postRef = useRef(post)
  useEffect(() => {
    postRef.current = post
  })

  useEffect(() => {
    if (attached || !targetId) return

    let cancelled = false
    setFetched(null)
    setSettled(false)

    const cached = getCachedQuotedPost(targetId)
    if (cached) {
      setFetched(cached)
      setSettled(true)
      return
    }

    const timer = setTimeout(() => {
      resolveQuotedPost(postRef.current)
        .then((resolved) => {
          if (cancelled) return
          setFetched(resolved)
          setSettled(true)
        })
        .catch((error) => {
          if (cancelled) return
          logger.error('useQuotedPost: failed to resolve quote target:', error)
          setSettled(true)
        })
    }, BATCH_GRACE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [attached, targetId])

  const quotedPost = attached ?? fetched
  return {
    quotedPost,
    loading: !!targetId && !quotedPost && !settled,
    unavailable: !!targetId && !quotedPost && settled,
  }
}
