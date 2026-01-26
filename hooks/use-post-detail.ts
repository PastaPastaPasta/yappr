import { useState, useEffect, useCallback, useRef } from 'react'
import { Post, Reply, ReplyThread } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { usePostEnrichment } from './use-post-enrichment'
import { useAppStore } from '@/lib/store'
import { ProgressiveEnrichment } from '@/components/post/post-card'

interface PostDetailState {
  post: Post | null
  replies: Reply[]
  replyThreads: ReplyThread[]
}

interface UsePostDetailOptions {
  postId: string | null
  enabled?: boolean
}

interface UsePostDetailResult {
  /** The main post */
  post: Post | null
  /** Replies to this post (flat list for backwards compat) */
  replies: Reply[]
  /** Threaded replies with nesting and author thread info */
  replyThreads: ReplyThread[]
  /** Whether initial load is in progress (false if using cached data) */
  isLoading: boolean
  /** Whether replies are still loading (separate from main post) */
  isLoadingReplies: boolean
  /** Enrichment data for the main post (from cache or progressive loading) */
  postEnrichment?: ProgressiveEnrichment
  /** Error message if load failed */
  error: string | null
  /** Refetch all data */
  refresh: () => Promise<void>
  /** Add an optimistic reply (before server confirms) */
  addOptimisticReply: (reply: Reply) => void
  /** Update the main post's fields */
  updatePost: (updates: Partial<Post>) => void
  /** Update a specific reply */
  updateReply: (replyId: string, updates: Partial<Reply>) => void
}

/**
 * Build a threaded reply tree from flat replies and nested replies.
 * Author's thread is shown first (all at same indent level), then other replies with nesting.
 *
 * @param mainPost - The main post being replied to
 * @param authorThreadChain - Pre-fetched complete author thread chain (all levels)
 * @param otherDirectReplies - All other direct replies that are NOT part of author thread
 * @param nestedRepliesMap - Map of replyId -> nested replies for non-author posts
 */
function buildReplyTree(
  mainPost: Post,
  authorThreadChain: Reply[],
  otherDirectReplies: Reply[],
  nestedRepliesMap: Map<string, Reply[]>
): ReplyThread[] {
  const threads: ReplyThread[] = []
  const authorThreadIds = new Set(authorThreadChain.map(r => r.id))

  // Add author's thread first - all at same level (no nesting within thread)
  authorThreadChain.forEach((reply, index) => {
    // Get replies to this thread post that are NOT part of the author thread
    const nestedReplies = (nestedRepliesMap.get(reply.id) || [])
      .filter(nested => !authorThreadIds.has(nested.id))

    threads.push({
      content: reply,
      isAuthorThread: true,
      isThreadContinuation: index > 0,
      nestedReplies: nestedReplies.map(nested => ({
        content: nested,
        isAuthorThread: false,
        isThreadContinuation: false,
        nestedReplies: [] // 2-level max for non-author replies
      }))
    })
  })

  // Add other direct replies (not part of author thread)
  otherDirectReplies.forEach(reply => {
    const nestedReplies = nestedRepliesMap.get(reply.id) || []
    threads.push({
      content: reply,
      isAuthorThread: false,
      isThreadContinuation: false,
      nestedReplies: nestedReplies.map(nested => ({
        content: nested,
        isAuthorThread: false,
        isThreadContinuation: false,
        nestedReplies: [] // 2-level max for non-author replies
      }))
    })
  })

  return threads
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
 *   replyThreads,
 *   isLoading,
 *   addOptimisticReply
 * } = usePostDetail({ postId, enabled: !!user })
 * ```
 */
export function usePostDetail({
  postId,
  enabled = true
}: UsePostDetailOptions): UsePostDetailResult {
  // Get initial navigation data synchronously from store (for useState initializers)
  // This must be done outside hooks to capture the value at component mount time
  const getInitialData = () => {
    if (!postId || !enabled) return null
    const pending = useAppStore.getState().pendingPostNavigation
    if (pending && pending.post.id === postId) {
      return pending
    }
    return null
  }

  const [state, setState] = useState<PostDetailState>(() => {
    const initial = getInitialData()
    return {
      post: initial?.post || null,
      replies: [],
      replyThreads: []
    }
  })

  const [isLoading, setIsLoading] = useState(() => {
    // Not loading if no postId or disabled
    if (!postId || !enabled) return false
    const initial = getInitialData()
    return !initial?.post
  })

  const [isLoadingReplies, setIsLoadingReplies] = useState(() => {
    // Not loading replies if no postId or disabled
    if (!postId || !enabled) return false
    return true
  })

  const [postEnrichment, setPostEnrichment] = useState<ProgressiveEnrichment | undefined>(() => {
    const initial = getInitialData()
    return initial?.enrichment
  })

  const [error, setError] = useState<string | null>(null)

  // Track loaded post to prevent duplicate loads
  const loadedPostIdRef = useRef<string | null>(null)
  // Incrementing token to ignore stale async responses
  const loadRequestIdRef = useRef(0)

  // Track if we used navigation data for initial render (computed once at mount)
  const usedNavigationDataRef = useRef<boolean>(!!getInitialData()?.post)

  // Enrichment hook with callback to update state
  // Note: enrichment works on posts, replies have their own author resolution
  const { enrich, reset: resetEnrichment } = usePostEnrichment({
    onEnriched: (enrichedPosts) => {
      setState(current => {
        const enrichedMap = new Map(enrichedPosts.map(p => [p.id, p]))

        return {
          post: current.post ? (enrichedMap.get(current.post.id) || current.post) : null,
          replies: current.replies,
          replyThreads: current.replyThreads
        }
      })
    }
  })

  const loadPost = useCallback(async () => {
    if (!postId || !enabled) return

    // Prevent duplicate loads
    if (loadedPostIdRef.current === postId) return
    loadedPostIdRef.current = postId
    const requestId = ++loadRequestIdRef.current
    const isCurrent = () => loadRequestIdRef.current === requestId

    // Only show main loading if no navigation data was available
    if (!usedNavigationDataRef.current) {
      setIsLoading(true)
    }
    // Always loading replies until we fetch them
    setIsLoadingReplies(true)
    setError(null)

    let loadedPost: Post | null = null

    try {
      // Load post (transformDocument returns post with defaults, no enrichment)
      // Try post first, then reply if not found (replies are a separate document type)
      loadedPost = await postService.getPostById(postId, { skipEnrichment: true })

      if (!loadedPost) {
        // Not a post - check if it's a reply
        const reply = await replyService.getReplyById(postId, { skipEnrichment: true })
        if (reply) {
          // Treat the reply as the main "post" for this detail view
          loadedPost = reply as Post
        }
      }

      if (!isCurrent()) return

      if (!loadedPost) {
        setState({ post: null, replies: [], replyThreads: [] })
        setIsLoading(false)
        setIsLoadingReplies(false)
        return
      }

      // Show the main post as soon as it's available
      setState({ post: loadedPost, replies: [], replyThreads: [] })
      setIsLoading(false)

      // Enrich the main post without blocking replies or UI
      enrich([loadedPost]).catch((err) => {
        console.error('usePostDetail: Failed to enrich main post:', err)
      })
    } catch (err) {
      if (!isCurrent()) return
      console.error('usePostDetail: Failed to load post:', err)
      setError(err instanceof Error ? err.message : 'Failed to load post')
      // Only clear state if we don't have navigation data to show
      if (!usedNavigationDataRef.current) {
        setState({ post: null, replies: [], replyThreads: [] })
      }
      setIsLoading(false)
      setIsLoadingReplies(false)
      return
    }

    if (!loadedPost) return

    try {
      // Load direct replies (now from reply-service)
      const repliesResult = await replyService.getReplies(postId)
      if (!isCurrent()) return
      const directReplies = repliesResult.documents

      // Build author's thread chain recursively
      // Find author's direct reply, then follow the chain of author replies
      const mainAuthorId = loadedPost.author.id
      const authorThreadChain: Reply[] = []
      const authorThreadIds = new Set<string>([loadedPost.id])

      // Helper to recursively fetch author's thread continuation
      const fetchAuthorThreadContinuation = async (parentIds: string[]): Promise<Reply[]> => {
        if (parentIds.length === 0) return []
        const nestedMap = await replyService.getNestedReplies(parentIds)
        const authorContinuations: Reply[] = []

        nestedMap.forEach((nested, parentId) => {
          for (const reply of nested) {
            if (reply.author.id === mainAuthorId && authorThreadIds.has(parentId)) {
              authorContinuations.push(reply)
              authorThreadIds.add(reply.id)
            }
          }
        })
        return authorContinuations
      }

      // Start with author's direct replies to main post
      const sortedDirectReplies = [...directReplies].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      )

      for (const reply of sortedDirectReplies) {
        if (reply.author.id === mainAuthorId) {
          authorThreadChain.push(reply)
          authorThreadIds.add(reply.id)
        }
      }

      // Recursively fetch author's thread continuations (replies to thread posts)
      let currentThreadIds = authorThreadChain.map(r => r.id)
      while (currentThreadIds.length > 0) {
        const continuations = await fetchAuthorThreadContinuation(currentThreadIds)
        if (continuations.length === 0) break

        // Sort and add to chain
        continuations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        authorThreadChain.push(...continuations)
        currentThreadIds = continuations.map(r => r.id)
      }

      // Other direct replies (not part of author thread)
      const otherDirectReplies = directReplies.filter(r => !authorThreadIds.has(r.id))

      // Fetch nested replies for all posts (author thread + other direct replies)
      const allDirectReplyIds = directReplies.map(r => r.id)
      const allThreadReplyIds = authorThreadChain.map(r => r.id)
      const allIdsForNested = Array.from(new Set([...allDirectReplyIds, ...allThreadReplyIds]))

      const nestedRepliesMap = allIdsForNested.length > 0
        ? await replyService.getNestedReplies(allIdsForNested)
        : new Map<string, Reply[]>()

      // Build threaded reply tree
      const replyThreads = buildReplyTree(loadedPost, authorThreadChain, otherDirectReplies, nestedRepliesMap)

      // All replies for backwards compat
      const replies = [...directReplies, ...authorThreadChain.filter(r => !directReplies.some(d => d.id === r.id))]

      // Fetch quoted posts for main post only (replies don't have quotes)
      if (loadedPost.quotedPostId) {
        try {
          const quotedPosts = await postService.getPostsByIds([loadedPost.quotedPostId])
          if (quotedPosts.length > 0) {
            loadedPost.quotedPost = quotedPosts[0]
          }
        } catch (quoteError) {
          console.error('Failed to fetch quoted post:', quoteError)
        }
      }

      // Update replies after they're ready, preserve any enriched main post
      setState(current => {
        const mergedPost = current.post
          ? { ...current.post, quotedPost: loadedPost.quotedPost || current.post.quotedPost }
          : loadedPost

        return { post: mergedPost, replies, replyThreads }
      })
    } catch (err) {
      if (!isCurrent()) return
      console.error('usePostDetail: Failed to load replies:', err)
      setError(err instanceof Error ? err.message : 'Failed to load replies')
    } finally {
      if (isCurrent()) {
        setIsLoadingReplies(false)
      }
    }
  }, [postId, enabled, enrich])

  // Load on mount/postId change/enabled change
  useEffect(() => {
    loadedPostIdRef.current = null // Reset on postId change
    resetEnrichment() // Reset enrichment tracking

    // Handle disabled or no postId - reset all state
    if (!postId || !enabled) {
      setState({ post: null, replies: [], replyThreads: [] })
      setPostEnrichment(undefined)
      setIsLoading(false)
      setIsLoadingReplies(false)
      setError(null)
      usedNavigationDataRef.current = false
      return
    }

    // Check for pending navigation data for the new postId
    const store = useAppStore.getState()
    const pending = store.pendingPostNavigation
    if (pending && pending.post.id === postId) {
      // Use navigation data immediately, reset stale context
      setState({
        post: pending.post,
        replies: [],
        replyThreads: []
      })
      setPostEnrichment(pending.enrichment)
      usedNavigationDataRef.current = true
      setIsLoading(false)
      setIsLoadingReplies(true) // Will load replies
      setError(null)
      // Clear the pending navigation
      store.consumePendingPostNavigation(postId)
    } else {
      // No pending data - reset state and show loading
      setState({ post: null, replies: [], replyThreads: [] })
      setPostEnrichment(undefined)
      usedNavigationDataRef.current = false
      setIsLoading(true)
      setIsLoadingReplies(true)
      setError(null)
    }

    loadPost()
  }, [postId, enabled, loadPost, resetEnrichment])

  const refresh = useCallback(async () => {
    loadedPostIdRef.current = null
    resetEnrichment()
    await loadPost()
  }, [loadPost, resetEnrichment])

  const addOptimisticReply = useCallback((reply: Reply) => {
    setState(current => {
      // Create a new thread entry for the reply
      const newThread: ReplyThread = {
        content: reply,
        isAuthorThread: false,
        isThreadContinuation: false,
        nestedReplies: []
      }

      return {
        ...current,
        replies: [reply, ...current.replies],
        replyThreads: [newThread, ...current.replyThreads],
        post: current.post
          ? { ...current.post, replies: current.post.replies + 1 }
          : null
      }
    })
  }, [])

  const updatePost = useCallback((updates: Partial<Post>) => {
    setState(current => ({
      ...current,
      post: current.post ? { ...current.post, ...updates } : null
    }))
  }, [])

  const updateReply = useCallback((replyId: string, updates: Partial<Reply>) => {
    setState(current => ({
      ...current,
      replies: current.replies.map(reply =>
        reply.id === replyId ? { ...reply, ...updates } : reply
      )
    }))
  }, [])

  // Listen for reply-created events (from ComposeModal) to add replies
  useEffect(() => {
    if (!postId) return

    const handleReplyCreated = (event: CustomEvent<{ reply: any }>) => {
      const newReply = event.detail?.reply
      if (!newReply) return

      // Check if this is a reply to the current post or any reply we're showing
      const parentId = newReply.parentId
      const isReplyToCurrentPost = parentId === postId
      const isReplyToAReply = state.replies.some(r => r.id === parentId)

      if (isReplyToCurrentPost || isReplyToAReply) {
        // Refresh to get the new reply with proper data
        refresh()
      }
    }

    window.addEventListener('reply-created', handleReplyCreated as EventListener)
    return () => {
      window.removeEventListener('reply-created', handleReplyCreated as EventListener)
    }
  }, [postId, state.replies, refresh])

  return {
    post: state.post,
    replies: state.replies,
    replyThreads: state.replyThreads,
    isLoading,
    isLoadingReplies,
    postEnrichment,
    error,
    refresh,
    addOptimisticReply,
    updatePost,
    updateReply
  }
}
