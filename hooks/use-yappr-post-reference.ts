'use client'

import { logger } from '@/lib/logger';
import { useEffect, useMemo, useState } from 'react'
import type { Post } from '@/lib/types'
import { replyToPost } from '@/lib/services/post-service'
import { extractYapprPostId } from '@/lib/link-preview/urls'
import { isHiddenItem } from '@/lib/feed/post-moderation'

interface UseYapprPostReferenceOptions {
  disabled?: boolean
}

export interface UseYapprPostReferenceResult {
  matched: boolean
  post: Post | null
  loading: boolean
  resolved: boolean
  /**
   * v18: the linked post or reply is hidden by the moderators and this build
   * does not show hidden content. `post` is then null and nothing of its
   * content is kept; the embed is the hidden stub.
   */
  hidden: boolean
}

/** What a link resolved to: the post to embed, or only that it is hidden (no content kept). */
type Reference = { post: Post } | { hidden: true }

const referenceCache = new Map<string, Reference>()
const pendingReferences = new Map<string, Promise<Reference | null>>()

/** The reference as this build may keep it: a hidden target's content is dropped at once. */
function toReference(post: Post): Reference {
  return isHiddenItem(post) ? { hidden: true } : { post }
}

async function fetchReferencedPost(postId: string): Promise<Reference | null> {
  const cached = referenceCache.get(postId)
  if (cached) return cached

  const pending = pendingReferences.get(postId)
  if (pending) {
    return pending
  }

  const request = (async () => {
    try {
      const { postService } = await import('@/lib/services')
      const post = await postService.getPostById(postId)
      if (post) {
        const reference = toReference(post)
        referenceCache.set(postId, reference)
        return reference
      }

      const { replyService } = await import('@/lib/services/reply-service')
      const reply = await replyService.getReplyById(postId)
      // Only cache hits: the services swallow network errors into null, so a
      // cached miss would pin a transient DAPI failure for the whole session.
      if (!reply) return null
      const reference = toReference(replyToPost(reply))
      referenceCache.set(postId, reference)
      return reference
    } catch (error) {
      logger.error('useYapprPostReference: Failed to resolve linked post:', error)
      return null
    } finally {
      pendingReferences.delete(postId)
    }
  })()

  pendingReferences.set(postId, request)
  return request
}

export function useYapprPostReference(
  url: string | null,
  options: UseYapprPostReferenceOptions = {}
): UseYapprPostReferenceResult {
  const { disabled = false } = options

  // `matched` is a pure pattern check on the URL and stays truthful even when
  // resolution is disabled — callers rely on it to keep internal post links
  // out of the external link-preview and media-gate paths.
  const referencedPostId = useMemo(() => {
    if (!url) return null
    return extractYapprPostId(url)
  }, [url])

  const matched = referencedPostId !== null
  const [reference, setReference] = useState<Reference | null>(null)
  const [loading, setLoading] = useState(false)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (disabled || !matched || !referencedPostId) {
      setReference(null)
      setLoading(false)
      setResolved(false)
      return
    }

    const cached = referenceCache.get(referencedPostId)
    if (cached) {
      setReference(cached)
      setLoading(false)
      setResolved(true)
      return
    }

    let cancelled = false
    setReference(null)
    setLoading(true)
    setResolved(false)

    fetchReferencedPost(referencedPostId).then((resolvedReference) => {
      if (cancelled) return
      setReference(resolvedReference)
      setLoading(false)
      setResolved(true)
    }).catch((error) => {
      if (cancelled) return
      logger.error('useYapprPostReference: Failed to apply linked post state:', error)
      setReference(null)
      setLoading(false)
      setResolved(true)
    })

    return () => {
      cancelled = true
    }
  }, [disabled, matched, referencedPostId])

  return {
    matched,
    post: reference && 'post' in reference ? reference.post : null,
    loading,
    resolved,
    hidden: reference !== null && 'hidden' in reference,
  }
}
