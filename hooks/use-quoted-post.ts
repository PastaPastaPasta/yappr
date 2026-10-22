'use client'

import { useEffect, useRef, useState } from 'react'
import type { Post } from '@/lib/types'
import { logger } from '@/lib/logger'
import { getCachedQuotedPost, resolveQuotedPost } from '@/lib/feed/resolve-quoted-posts'
import { quoteTargetOf } from '@/lib/feed/quote-targets'
import { isQuoteHidden } from '@/lib/feed/post-moderation'
import { isHiddenItem } from '@/lib/moderation-view'

export interface UseQuotedPostResult {
  /** The quoted post, from the batch pass or the fallback fetch. */
  quotedPost: Post | null
  /** True while the fallback fetch is pending (including the grace period). */
  loading: boolean
  /** True when resolution finished and the target could not be loaded (or is hidden). */
  unavailable: boolean
  /** v18: the target is hidden by the moderators and this build does not show it. */
  hidden: boolean
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
  // A join already proved the target absent (a moderator removed it): there
  // is nothing to fetch, so the card goes straight to the removed stub.
  const targetId = post.quotedPostRemoved ? null : quoteTargetOf(post)?.id ?? null

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

  // v18: a target the moderators hid is never shown here (an archival build
  // keeps it, labelled): the card renders the hidden stub instead.
  const fetchedHidden = isHiddenItem(fetched)
  const hidden = isQuoteHidden(post) || fetchedHidden
  const quotedPost = attached ?? (fetchedHidden ? null : fetched)
  // A target we don't have yet is either still resolving or known-missing.
  const unresolved = !!targetId && !quotedPost
  return {
    quotedPost,
    loading: unresolved && !settled && !hidden,
    unavailable: (unresolved && settled) || post.quotedPostRemoved === true || hidden,
    hidden,
  }
}
