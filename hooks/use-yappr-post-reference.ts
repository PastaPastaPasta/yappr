'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Post, Reply } from '@/lib/types'
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

function convertReplyToPost(reply: Reply): Post {
  return {
    id: reply.id,
    author: reply.author,
    content: reply.content,
    createdAt: reply.createdAt,
    likes: reply.likes,
    reposts: reply.reposts,
    replies: reply.replies,
    views: reply.views,
    liked: reply.liked,
    reposted: reply.reposted,
    bookmarked: reply.bookmarked,
    media: reply.media,
    parentId: reply.parentId,
    parentOwnerId: reply.parentOwnerId,
    encryptedContent: reply.encryptedContent,
    epoch: reply.epoch,
    nonce: reply.nonce,
    _enrichment: reply._enrichment,
  }
}

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
      const convertedReply = reply ? convertReplyToPost(reply) : null
      referenceCache.set(postId, convertedReply)
      return convertedReply
    } catch (error) {
      console.error('useYapprPostReference: Failed to resolve linked post:', error)
      referenceCache.set(postId, null)
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

  const referencedPostId = useMemo(() => {
    if (!url || disabled) return null
    return extractYapprPostId(url)
  }, [url, disabled])

  const matched = referencedPostId !== null
  const [post, setPost] = useState<Post | null>(null)
  const [loading, setLoading] = useState(false)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (!matched || !referencedPostId) {
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
    })

    return () => {
      cancelled = true
    }
  }, [matched, referencedPostId])

  return {
    matched,
    post,
    loading,
    resolved,
  }
}
