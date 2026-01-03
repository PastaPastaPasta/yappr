import { useState, useEffect, useCallback, useRef } from 'react'
import { Post } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { usePostEnrichment } from './use-post-enrichment'

interface PostDetailState {
  post: Post | null
  parentPost: Post | null
  replies: Post[]
}

interface UsePostDetailOptions {
  postId: string | null
  enabled?: boolean
}

interface UsePostDetailResult {
  /** The main post */
  post: Post | null
  /** Parent post if this is a reply */
  parentPost: Post | null
  /** Replies to this post */
  replies: Post[]
  /** Whether initial load is in progress */
  isLoading: boolean
  /** Error message if load failed */
  error: string | null
  /** Refetch all data */
  refresh: () => Promise<void>
  /** Add an optimistic reply (before server confirms) */
  addOptimisticReply: (reply: Post) => void
  /** Update the main post's fields */
  updatePost: (updates: Partial<Post>) => void
  /** Update a specific reply */
  updateReply: (replyId: string, updates: Partial<Post>) => void
}

/**
 * Hook for loading and managing post detail state.
 *
 * Handles:
 * - Loading post, parent (if reply), and replies
 * - Batch enrichment of all posts
 * - Optimistic updates for replies
 * - Loading and error states
 *
 * @example
 * ```tsx
 * const {
 *   post,
 *   parentPost,
 *   replies,
 *   isLoading,
 *   addOptimisticReply
 * } = usePostDetail({ postId, enabled: !!user })
 * ```
 */
export function usePostDetail({
  postId,
  enabled = true
}: UsePostDetailOptions): UsePostDetailResult {
  const [state, setState] = useState<PostDetailState>({
    post: null,
    parentPost: null,
    replies: []
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track loaded post to prevent duplicate loads
  const loadedPostIdRef = useRef<string | null>(null)

  // Enrichment hook with callback to update state
  const { enrich, reset: resetEnrichment } = usePostEnrichment({
    onEnriched: (enrichedPosts) => {
      setState(current => {
        const enrichedMap = new Map(enrichedPosts.map(p => [p.id, p]))
        return {
          post: current.post ? (enrichedMap.get(current.post.id) || current.post) : null,
          parentPost: current.parentPost
            ? (enrichedMap.get(current.parentPost.id) || current.parentPost)
            : null,
          replies: current.replies.map(r => enrichedMap.get(r.id) || r)
        }
      })
    }
  })

  const loadPost = useCallback(async () => {
    if (!postId || !enabled) return

    // Prevent duplicate loads
    if (loadedPostIdRef.current === postId) return
    loadedPostIdRef.current = postId

    setIsLoading(true)
    setError(null)

    try {
      // Load post (transformDocument returns post with defaults, no enrichment)
      const loadedPost = await postService.getPostById(postId, { skipEnrichment: true })

      if (!loadedPost) {
        setState({ post: null, parentPost: null, replies: [] })
        return
      }

      // Load parent if this is a reply
      let parentPost: Post | null = null
      if (loadedPost.replyToId) {
        parentPost = await postService.getPostById(loadedPost.replyToId, { skipEnrichment: true })
      }

      // Load replies
      const repliesResult = await postService.getReplies(postId, { skipEnrichment: true })
      const replies = repliesResult.documents.map(reply => ({
        ...reply,
        replyToId: postId
      }))

      // Set initial state immediately (with placeholder data)
      setState({ post: loadedPost, parentPost, replies })

      // Enrich all posts in batch
      const allPosts = [loadedPost, parentPost, ...replies].filter(Boolean) as Post[]
      await enrich(allPosts)

    } catch (err) {
      console.error('usePostDetail: Failed to load post:', err)
      setError(err instanceof Error ? err.message : 'Failed to load post')
      setState({ post: null, parentPost: null, replies: [] })
    } finally {
      setIsLoading(false)
    }
  }, [postId, enabled, enrich])

  // Load on mount/postId change
  useEffect(() => {
    loadedPostIdRef.current = null // Reset on postId change
    resetEnrichment() // Reset enrichment tracking
    loadPost()
  }, [postId, loadPost, resetEnrichment])

  const refresh = useCallback(async () => {
    loadedPostIdRef.current = null
    resetEnrichment()
    await loadPost()
  }, [loadPost, resetEnrichment])

  const addOptimisticReply = useCallback((reply: Post) => {
    setState(current => ({
      ...current,
      replies: [reply, ...current.replies],
      post: current.post
        ? { ...current.post, replies: current.post.replies + 1 }
        : null
    }))
  }, [])

  const updatePost = useCallback((updates: Partial<Post>) => {
    setState(current => ({
      ...current,
      post: current.post ? { ...current.post, ...updates } : null
    }))
  }, [])

  const updateReply = useCallback((replyId: string, updates: Partial<Post>) => {
    setState(current => ({
      ...current,
      replies: current.replies.map(reply =>
        reply.id === replyId ? { ...reply, ...updates } : reply
      )
    }))
  }, [])

  return {
    post: state.post,
    parentPost: state.parentPost,
    replies: state.replies,
    isLoading,
    error,
    refresh,
    addOptimisticReply,
    updatePost,
    updateReply
  }
}
