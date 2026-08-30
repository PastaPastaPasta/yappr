'use client'

import { logger } from '@/lib/logger';
import { useEffect, useMemo, useState } from 'react'
import type { Post } from '@/lib/types'
import { replyToPost } from '@/lib/services/post-service'
import { extractYapprPostId } from './use-link-preview'

interface UseYapprPostReferenceOptions {
  disabled?: boolean
}

export interface UseYapprPostReferenceResult {
  matched: boolean
  post: Post | null
  loading: boolean
  resolved: boolean
}

const referenceCache = new Map<string, Post | null>()
const pendingReferences = new Map<string, Promise<Post | null>>()

async function fetchReferencedPost(postId: string): Promise<Post | null> {
  if (referenceCache.has(postId)) {
    return referenceCache.get(postId) ?? null
  }

  const pending = pendingReferences.get(postId)
  if (pending) {
    return pending
  }

  const request = (async () => {
    try {
      const { postService } = await import('@/lib/services')
      const post = await postService.getPostById(postId)
      if (post) {
        referenceCache.set(postId, post)
        return post
      }

      const { replyService } = await import('@/lib/services/reply-service')
      const reply = await replyService.getReplyById(postId)
      const convertedReply = reply ? replyToPost(reply) : null
      referenceCache.set(postId, convertedReply)
      return convertedReply
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
  const [post, setPost] = useState<Post | null>(null)
  const [loading, setLoading] = useState(false)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (disabled || !matched || !referencedPostId) {
      setPost(null)
      setLoading(false)
      setResolved(false)
      return
    }

    if (referenceCache.has(referencedPostId)) {
      setPost(referenceCache.get(referencedPostId) ?? null)
      setLoading(false)
      setResolved(true)
      return
    }

    let cancelled = false
    setPost(null)
    setLoading(true)
    setResolved(false)

    fetchReferencedPost(referencedPostId).then((resolvedPost) => {
      if (cancelled) return
      setPost(resolvedPost)
      setLoading(false)
      setResolved(true)
    }).catch((error) => {
      if (cancelled) return
      logger.error('useYapprPostReference: Failed to apply linked post state:', error)
      setPost(null)
      setLoading(false)
      setResolved(true)
    })

    return () => {
      cancelled = true
    }
  }, [disabled, matched, referencedPostId])

  return {
    matched,
    post,
    loading,
    resolved,
  }
}
