import { useState, useEffect, useCallback, useRef } from 'react'
import { Post, ReplyThread } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { usePostEnrichment } from './use-post-enrichment'
import { useAppStore, CachedPost } from '@/lib/store'
import { ProgressiveEnrichment } from '@/components/post/post-card'

interface PostDetailState {
  post: Post | null
  parentPost: Post | null
  replies: Post[]
  replyThreads: ReplyThread[]
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
  /** Replies to this post (flat list for backwards compat) */
  replies: Post[]
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
  addOptimisticReply: (reply: Post) => void
  /** Update the main post's fields */
  updatePost: (updates: Partial<Post>) => void
  /** Update a specific reply */
  updateReply: (replyId: string, updates: Partial<Post>) => void
}

/**
 * Build a threaded reply tree from flat replies and nested replies.
 * Author's thread is shown first (all at same indent level), then other replies with nesting.
 *
 * @param authorThreadChain - Pre-fetched complete author thread chain (all levels)
 * @param allReplies - All other replies (direct + nested) that are NOT part of author thread
 * @param nestedRepliesMap - Map of postId -> nested replies for non-author posts
 */
function buildReplyTree(
  mainPost: Post,
  authorThreadChain: Post[],
  otherDirectReplies: Post[],
  nestedRepliesMap: Map<string, Post[]>
): ReplyThread[] {
  const threads: ReplyThread[] = []
  const authorThreadIds = new Set(authorThreadChain.map(p => p.id))

  // Add author's thread first - all at same level (no nesting within thread)
  authorThreadChain.forEach((post, index) => {
    // Get replies to this thread post that are NOT part of the author thread
    const nestedReplies = (nestedRepliesMap.get(post.id) || [])
      .filter(nested => !authorThreadIds.has(nested.id))

    threads.push({
      post,
      isAuthorThread: true,
      isThreadContinuation: index > 0,
      nestedReplies: nestedReplies.map(nested => ({
        post: nested,
        isAuthorThread: false,
        isThreadContinuation: false,
        nestedReplies: [] // 2-level max for non-author replies
      }))
    })
  })

  // Add other direct replies (not part of author thread)
  otherDirectReplies.forEach(post => {
    const nestedReplies = nestedRepliesMap.get(post.id) || []
    threads.push({
      post,
      isAuthorThread: false,
      isThreadContinuation: false,
      nestedReplies: nestedReplies.map(nested => ({
        post: nested,
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
  // Get cached post for instant display
  const getCachedPost = useAppStore(state => state.getCachedPost)
  const cachedData = postId ? getCachedPost(postId) : undefined

  const [state, setState] = useState<PostDetailState>(() => ({
    // Use cached post immediately if available
    post: cachedData?.post || null,
    parentPost: null,
    replies: [],
    replyThreads: []
  }))
  // Only show main loading if no cached post
  const [isLoading, setIsLoading] = useState(!cachedData?.post)
  const [isLoadingReplies, setIsLoadingReplies] = useState(true)
  const [postEnrichment, setPostEnrichment] = useState<ProgressiveEnrichment | undefined>(
    cachedData?.enrichment
  )
  const [error, setError] = useState<string | null>(null)

  // Track loaded post to prevent duplicate loads
  const loadedPostIdRef = useRef<string | null>(null)
  // Track if we used cached data for initial render
  const usedCacheRef = useRef<boolean>(!!cachedData?.post)

  // Enrichment hook with callback to update state
  const { enrich, reset: resetEnrichment } = usePostEnrichment({
    onEnriched: (enrichedPosts) => {
      setState(current => {
        const enrichedMap = new Map(enrichedPosts.map(p => [p.id, p]))

        // Update enriched posts in replyThreads
        const updateThread = (thread: ReplyThread): ReplyThread => ({
          ...thread,
          post: enrichedMap.get(thread.post.id) || thread.post,
          nestedReplies: thread.nestedReplies.map(nested => ({
            ...nested,
            post: enrichedMap.get(nested.post.id) || nested.post
          }))
        })

        return {
          post: current.post ? (enrichedMap.get(current.post.id) || current.post) : null,
          parentPost: current.parentPost
            ? (enrichedMap.get(current.parentPost.id) || current.parentPost)
            : null,
          replies: current.replies.map(r => enrichedMap.get(r.id) || r),
          replyThreads: current.replyThreads.map(updateThread)
        }
      })
    }
  })

  const loadPost = useCallback(async () => {
    if (!postId || !enabled) return

    // Prevent duplicate loads
    if (loadedPostIdRef.current === postId) return
    loadedPostIdRef.current = postId

    // Check cache again (in case it was populated after mount)
    const freshCachedData = getCachedPost(postId)
    const hasCachedPost = usedCacheRef.current || !!freshCachedData?.post

    // Only show main loading if no cached data
    if (!hasCachedPost) {
      setIsLoading(true)
    }
    // Always loading replies until we fetch them
    setIsLoadingReplies(true)
    setError(null)

    try {
      // Load post (transformDocument returns post with defaults, no enrichment)
      const loadedPost = await postService.getPostById(postId, { skipEnrichment: true })

      if (!loadedPost) {
        setState({ post: null, parentPost: null, replies: [], replyThreads: [] })
        setIsLoadingReplies(false)
        return
      }

      // Load parent if this is a reply
      let parentPost: Post | null = null
      if (loadedPost.replyToId) {
        parentPost = await postService.getPostById(loadedPost.replyToId, { skipEnrichment: true })
      }

      // Load direct replies
      const repliesResult = await postService.getReplies(postId, { skipEnrichment: true })
      const directReplies = repliesResult.documents.map(reply => ({
        ...reply,
        replyToId: postId
      }))

      // Build author's thread chain recursively
      // Find author's direct reply, then follow the chain of author replies
      const mainAuthorId = loadedPost.author.id
      const authorThreadChain: Post[] = []
      const authorThreadIds = new Set<string>([loadedPost.id])

      // Helper to recursively fetch author's thread continuation
      const fetchAuthorThreadContinuation = async (parentIds: string[]): Promise<Post[]> => {
        if (parentIds.length === 0) return []
        const nestedMap = await postService.getNestedReplies(parentIds, { skipEnrichment: true })
        const authorContinuations: Post[] = []

        nestedMap.forEach((nested, parentId) => {
          for (const post of nested) {
            if (post.author.id === mainAuthorId && authorThreadIds.has(parentId)) {
              authorContinuations.push(post)
              authorThreadIds.add(post.id)
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
      let currentThreadIds = authorThreadChain.map(p => p.id)
      while (currentThreadIds.length > 0) {
        const continuations = await fetchAuthorThreadContinuation(currentThreadIds)
        if (continuations.length === 0) break

        // Sort and add to chain
        continuations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        authorThreadChain.push(...continuations)
        currentThreadIds = continuations.map(p => p.id)
      }

      // Other direct replies (not part of author thread)
      const otherDirectReplies = directReplies.filter(r => !authorThreadIds.has(r.id))

      // Fetch nested replies for all posts (author thread + other direct replies)
      const allDirectReplyIds = directReplies.map(r => r.id)
      const allThreadPostIds = authorThreadChain.map(p => p.id)
      const allPostIdsForNested = Array.from(new Set([...allDirectReplyIds, ...allThreadPostIds]))

      const nestedRepliesMap = allPostIdsForNested.length > 0
        ? await postService.getNestedReplies(allPostIdsForNested, { skipEnrichment: true })
        : new Map<string, Post[]>()

      // Build threaded reply tree
      const replyThreads = buildReplyTree(loadedPost, authorThreadChain, otherDirectReplies, nestedRepliesMap)

      // Collect all nested replies for enrichment (excluding author thread posts already collected)
      const allNestedReplies = Array.from(nestedRepliesMap.values())
        .flat()
        .filter(p => !authorThreadIds.has(p.id))

      // All replies for backwards compat and enrichment
      const replies = [...directReplies, ...authorThreadChain.filter(p => !directReplies.some(d => d.id === p.id))]

      // Fetch quoted posts for main post and all replies
      const allPostsToCheck = [loadedPost, parentPost, ...replies, ...allNestedReplies].filter(Boolean) as Post[]
      const quotedPostIds = allPostsToCheck
        .filter((p: any) => p.quotedPostId)
        .map((p: any) => p.quotedPostId)

      if (quotedPostIds.length > 0) {
        try {
          const quotedPosts = await postService.getPostsByIds(quotedPostIds)
          const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

          // Attach quoted posts
          if ((loadedPost as any).quotedPostId && quotedPostMap.has((loadedPost as any).quotedPostId)) {
            (loadedPost as any).quotedPost = quotedPostMap.get((loadedPost as any).quotedPostId)
          }
          if (parentPost && (parentPost as any).quotedPostId && quotedPostMap.has((parentPost as any).quotedPostId)) {
            (parentPost as any).quotedPost = quotedPostMap.get((parentPost as any).quotedPostId)
          }
          for (const reply of [...replies, ...allNestedReplies]) {
            if ((reply as any).quotedPostId && quotedPostMap.has((reply as any).quotedPostId)) {
              (reply as any).quotedPost = quotedPostMap.get((reply as any).quotedPostId)
            }
          }
        } catch (quoteError) {
          console.error('Failed to fetch quoted posts:', quoteError)
        }
      }

      // Set initial state immediately (with placeholder data)
      setState({ post: loadedPost, parentPost, replies, replyThreads })

      // Enrich all posts in batch (including nested replies)
      const allPosts = [loadedPost, parentPost, ...replies, ...allNestedReplies].filter(Boolean) as Post[]
      await enrich(allPosts)

    } catch (err) {
      console.error('usePostDetail: Failed to load post:', err)
      setError(err instanceof Error ? err.message : 'Failed to load post')
      // Only clear state if we don't have cached data to show
      if (!usedCacheRef.current) {
        setState({ post: null, parentPost: null, replies: [], replyThreads: [] })
      }
    } finally {
      setIsLoading(false)
      setIsLoadingReplies(false)
    }
  }, [postId, enabled, enrich, getCachedPost])

  // Load on mount/postId change
  useEffect(() => {
    loadedPostIdRef.current = null // Reset on postId change
    resetEnrichment() // Reset enrichment tracking

    // Check for cached post on postId change
    const newCachedData = postId ? getCachedPost(postId) : undefined
    if (newCachedData?.post) {
      // Use cached post immediately
      setState(current => ({
        ...current,
        post: newCachedData.post
      }))
      setPostEnrichment(newCachedData.enrichment)
      usedCacheRef.current = true
      setIsLoading(false)
    } else {
      usedCacheRef.current = false
      setIsLoading(true)
    }

    loadPost()
  }, [postId, loadPost, resetEnrichment, getCachedPost])

  const refresh = useCallback(async () => {
    loadedPostIdRef.current = null
    resetEnrichment()
    await loadPost()
  }, [loadPost, resetEnrichment])

  const addOptimisticReply = useCallback((reply: Post) => {
    setState(current => {
      // Create a new thread entry for the reply
      const newThread: ReplyThread = {
        post: reply,
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
    // Enrich the new reply to get DPNS username/display name
    enrich([reply])
  }, [enrich])

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

  // Listen for post-created events (from ComposeModal) to add replies
  useEffect(() => {
    if (!postId) return

    const handlePostCreated = (event: CustomEvent<{ post: any }>) => {
      const newPost = event.detail?.post
      if (!newPost) return

      // Check if this is a reply to the current post or any reply we're showing
      const replyToId = newPost.replyToPostId || newPost.replyToId
      const isReplyToCurrentPost = replyToId === postId
      const isReplyToAReply = state.replies.some(r => r.id === replyToId)

      if (isReplyToCurrentPost || isReplyToAReply) {
        // Refresh to get the new reply with proper data
        refresh()
      }
    }

    window.addEventListener('post-created', handlePostCreated as EventListener)
    return () => {
      window.removeEventListener('post-created', handlePostCreated as EventListener)
    }
  }, [postId, state.replies, refresh])

  return {
    post: state.post,
    parentPost: state.parentPost,
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
