import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { Post, Reply, ReplyThread } from '@/lib/types'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { attachQuotedPosts } from '@/lib/feed/resolve-quoted-posts'
import { hasFlatThreads, targetKindOf, threadRootIdOf } from '@/lib/contract-topology'
import { usePostEnrichment } from './use-post-enrichment'
import { useAppStore } from '@/lib/store'
import { ProgressiveEnrichment } from '@/components/post/post-card'

interface PostDetailState {
  post: Post | null
  replies: Reply[]
  replyThreads: ReplyThread[]
  /** Chain of parent posts/replies leading to this post (if it's a deeply nested reply) */
  replyChain: Post[]
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
  /** Chain of parent posts/replies leading up to the main post (for nested replies) */
  replyChain: Post[]
  /** Whether initial load is in progress (false if using cached data) */
  isLoading: boolean
  /** Whether replies are still loading (separate from main post) */
  isLoadingReplies: boolean
  /** Whether another page of replies is available */
  hasMoreReplies: boolean
  /** Whether a Load More request is in flight */
  isLoadingMoreReplies: boolean
  /** Fetch the next page of replies */
  loadMoreReplies: () => Promise<void>
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

const byCreatedAtAsc = (a: Reply, b: Reply) => a.createdAt.getTime() - b.createdAt.getTime()

/**
 * Build a threaded reply tree from flat replies and nested replies.
 * Author's thread is shown first (all at same indent level), then other replies with nesting.
 *
 * @param authorThreadChain - Pre-fetched complete author thread chain (all levels)
 * @param otherDirectReplies - All other direct replies that are NOT part of author thread
 * @param nestedRepliesMap - Map of replyId -> nested replies for non-author posts
 */
function buildReplyTree(
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
 * Assemble a thread from the flat reply list a v3 `rootAndTime` query returns.
 *
 * Every reply in a thread names the same `rootPostId`, so one query has all of
 * them and the shape is reconstructed here rather than discovered by walking the
 * chain: children group under `replyToReplyId`, and the author's own
 * continuation is a local filter instead of the recursive round-trips v2 needs.
 */
function assembleFlatThread(mainPost: Post, allReplies: Reply[]): ReplyThread[] {
  const childrenOf = new Map<string, Reply[]>()
  const topOfThread: Reply[] = []

  for (const reply of [...allReplies].sort(byCreatedAtAsc)) {
    const parentId = reply.replyToReplyId
    if (!parentId) {
      topOfThread.push(reply)
      continue
    }
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(reply)
    else childrenOf.set(parentId, [reply])
  }

  // Viewing a reply shows ITS subtree; viewing the root post shows the thread's
  // top level. (A reply's page still loads the whole thread — one query — and
  // simply renders a slice of it.)
  const directReplies = targetKindOf(mainPost) === 'reply'
    ? childrenOf.get(mainPost.id) ?? []
    : topOfThread

  // The author's own continuation: their direct replies, then their replies to
  // those, and so on.
  const authorThreadChain: Reply[] = []
  const authorThreadIds = new Set<string>()
  let frontier = directReplies.filter((reply) => reply.author.id === mainPost.author.id)
  while (frontier.length > 0) {
    const next: Reply[] = []
    for (const reply of frontier) {
      if (authorThreadIds.has(reply.id)) continue
      authorThreadChain.push(reply)
      authorThreadIds.add(reply.id)
      next.push(
        ...(childrenOf.get(reply.id) ?? []).filter((child) => child.author.id === mainPost.author.id)
      )
    }
    frontier = next
  }

  const otherDirectReplies = directReplies.filter((reply) => !authorThreadIds.has(reply.id))
  return buildReplyTree(authorThreadChain, otherDirectReplies, childrenOf)
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
      replyThreads: [],
      replyChain: []
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

  const [isLoadingMoreReplies, setIsLoadingMoreReplies] = useState(false)
  const [hasMoreReplies, setHasMoreReplies] = useState(false)

  const [postEnrichment, setPostEnrichment] = useState<ProgressiveEnrichment | undefined>(() => {
    const initial = getInitialData()
    return initial?.enrichment
  })

  const [error, setError] = useState<string | null>(null)

  // Track loaded post to prevent duplicate loads
  const loadedPostIdRef = useRef<string | null>(null)
  // Incrementing token to ignore stale async responses
  const loadRequestIdRef = useRef(0)
  // The thread this page is showing, and where the next page of it starts.
  const threadRootIdRef = useRef<string | null>(null)
  const replyCursorRef = useRef<string | undefined>(undefined)

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
          replyThreads: current.replyThreads,
          replyChain: current.replyChain.map(p => enrichedMap.get(p.id) || p)
        }
      })

      // Drop the click-time navigation snapshot once fresh data for the main
      // post lands — a placeholder displayName captured mid-load would
      // otherwise shadow the resolved author forever
      if (postId && enrichedPosts.some(p => p.id === postId)) {
        setPostEnrichment(undefined)
      }
    }
  })

  /**
   * The posts shown above the main item.
   *
   * On v3 a reply names its thread root, so the ancestry is exactly one document
   * — no walk, and no ambiguity about which of several nesting levels is "the"
   * context. On v2 the only link is the polymorphic direct parent, so the chain
   * has to be walked one lookup at a time.
   */
  const fetchReplyChain = async (mainPost: Post): Promise<Post[]> => {
    const chain: Post[] = []

    if (hasFlatThreads()) {
      const rootPost = await postService.getPostById(threadRootIdOf(mainPost), { skipEnrichment: true })
      if (rootPost) chain.push(rootPost)
    } else {
      let currentParentId: string | undefined = mainPost.parentId
      const MAX_DEPTH = 50 // Safety limit to prevent infinite loops

      while (currentParentId && chain.length < MAX_DEPTH) {
        // First try as a post
        let parent = await postService.getPostById(currentParentId, { skipEnrichment: true })

        if (!parent) {
          // Try as a reply
          const reply = await replyService.getReplyById(currentParentId, { skipEnrichment: true })
          if (reply) {
            // The adapter (not a spread) so the Post shape is complete — a spread
            // leaves `quotes` undefined in a `quotes: number` field.
            parent = replyToPost(reply)
          }
        }

        if (!parent) break

        // Add to the beginning of the chain (we're walking backwards)
        chain.unshift(parent)

        // Continue up the chain if this parent also has a parent
        currentParentId = parent.parentId
      }
    }

    // Resolve whatever the chain items quote (reposts / quote posts).
    await attachQuotedPosts(chain)

    // Enrich all posts in the chain
    if (chain.length > 0) {
      try {
        await enrich(chain)
      } catch (err) {
        logger.error('usePostDetail: Failed to enrich reply chain:', err)
      }
    }

    return chain
  }

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
    replyCursorRef.current = undefined
    setHasMoreReplies(false)

    let loadedPost: Post | null = null

    try {
      // Load post (transformDocument returns post with defaults, no enrichment)
      // Try post first, then reply if not found (replies are a separate document type)
      loadedPost = await postService.getPostById(postId, { skipEnrichment: true })

      if (!loadedPost) {
        // Not a post - check if it's a reply
        const reply = await replyService.getReplyById(postId, { skipEnrichment: true })
        if (reply) {
          // Treat the reply as the main "post" for this detail view, tagged with
          // the doctype it actually came from.
          loadedPost = replyToPost(reply)
        }
      }

      if (!isCurrent()) return

      if (!loadedPost) {
        setState({ post: null, replies: [], replyThreads: [], replyChain: [] })
        setIsLoading(false)
        setIsLoadingReplies(false)
        return
      }

      threadRootIdRef.current = threadRootIdOf(loadedPost)

      // If the loaded item is a reply, show the context it hangs off
      let replyChain: Post[] = []
      if (targetKindOf(loadedPost) === 'reply') {
        replyChain = await fetchReplyChain(loadedPost)
        if (!isCurrent()) return
      }

      // Show the main post as soon as it's available
      setState({ post: loadedPost, replies: [], replyThreads: [], replyChain })
      setIsLoading(false)

      // Enrich the main post without blocking replies or UI
      enrich([loadedPost]).catch((err) => {
        logger.error('usePostDetail: Failed to enrich main post:', err)
      })
    } catch (err) {
      if (!isCurrent()) return
      logger.error('usePostDetail: Failed to load post:', err)
      setError(err instanceof Error ? err.message : 'Failed to load post')
      // Only clear state if we don't have navigation data to show
      if (!usedNavigationDataRef.current) {
        setState({ post: null, replies: [], replyThreads: [], replyChain: [] })
      }
      setIsLoading(false)
      setIsLoadingReplies(false)
      return
    }

    if (!loadedPost) return

    try {
      let replies: Reply[]
      let replyThreads: ReplyThread[]

      if (hasFlatThreads()) {
        // One query for the entire thread, keyed on the root every reply shares.
        const result = await replyService.getReplies(threadRootIdOf(loadedPost))
        if (!isCurrent()) return
        replies = result.documents
        replyCursorRef.current = result.nextCursor
        setHasMoreReplies(Boolean(result.nextCursor))
        replyThreads = assembleFlatThread(loadedPost, replies)
      } else {
        ;({ replies, replyThreads } = await loadV2Thread(loadedPost, postId, isCurrent))
        if (!isCurrent()) return
      }

      // Resolve whatever the main post quotes (chain items are done in fetchReplyChain)
      await attachQuotedPosts([loadedPost])
      if (!isCurrent()) return
      const quotedPost = loadedPost.quotedPost

      // Update replies after they're ready, preserve any enriched main post and replyChain
      setState(current => {
        const mergedPost = current.post
          ? { ...current.post, quotedPost: quotedPost ?? current.post.quotedPost }
          : { ...loadedPost, quotedPost: quotedPost ?? loadedPost.quotedPost }

        return { post: mergedPost, replies, replyThreads, replyChain: current.replyChain }
      })
    } catch (err) {
      if (!isCurrent()) return
      logger.error('usePostDetail: Failed to load replies:', err)
      setError(err instanceof Error ? err.message : 'Failed to load replies')
    } finally {
      if (isCurrent()) {
        setIsLoadingReplies(false)
      }
    }
  }, [postId, enabled, enrich])

  /**
   * Fetch the next page of the thread (v3 only — v2's `getReplies` covers one
   * level, which the old code already fetched whole).
   */
  const loadMoreReplies = useCallback(async () => {
    const cursor = replyCursorRef.current
    const rootId = threadRootIdRef.current
    if (!cursor || !rootId || isLoadingMoreReplies) return

    setIsLoadingMoreReplies(true)
    try {
      const result = await replyService.getReplies(rootId, { startAfter: cursor })
      // Navigating away mid-flight would otherwise merge this thread's next page
      // into whatever post the page moved on to.
      if (threadRootIdRef.current !== rootId) return
      replyCursorRef.current = result.nextCursor
      setHasMoreReplies(Boolean(result.nextCursor))

      setState(current => {
        if (!current.post) return current
        const known = new Set(current.replies.map((reply) => reply.id))
        const merged = [...current.replies, ...result.documents.filter((reply) => !known.has(reply.id))]
        return { ...current, replies: merged, replyThreads: assembleFlatThread(current.post, merged) }
      })
    } catch (err) {
      logger.error('usePostDetail: Failed to load more replies:', err)
    } finally {
      setIsLoadingMoreReplies(false)
    }
  }, [isLoadingMoreReplies])

  // Load on mount/postId change/enabled change
  useEffect(() => {
    loadedPostIdRef.current = null // Reset on postId change
    resetEnrichment() // Reset enrichment tracking

    // Handle disabled or no postId - reset all state
    if (!postId || !enabled) {
      setState({ post: null, replies: [], replyThreads: [], replyChain: [] })
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
        replyThreads: [],
        replyChain: []
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
      setState({ post: null, replies: [], replyThreads: [], replyChain: [] })
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
      const newThread: ReplyThread = {
        content: reply,
        isAuthorThread: false,
        isThreadContinuation: false,
        nestedReplies: []
      }

      // A reply to a reply belongs UNDER that reply. Dropping it at the top would
      // show it in the wrong place, and on a flat thread nothing refetches in
      // between. A nesting target that is not on this page (a 3rd-level reply,
      // which the tree does not render) falls back to the top of the list.
      const nestUnder = reply.replyToReplyId
      const canNest = Boolean(nestUnder) && current.replyThreads.some((t) => t.content.id === nestUnder)

      return {
        ...current,
        replies: [reply, ...current.replies],
        replyThreads: canNest
          ? current.replyThreads.map((thread) =>
              thread.content.id === nestUnder
                ? { ...thread, nestedReplies: [...thread.nestedReplies, newThread] }
                : thread
            )
          : [newThread, ...current.replyThreads],
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

    const handleReplyCreated = (event: CustomEvent<{ reply?: Reply }>) => {
      const newReply = event.detail?.reply
      if (!newReply) return

      // A v3 reply names the thread it belongs to, so membership is exact — a
      // reply to a reply three levels down still refreshes this page. On v2 the
      // only signal is the direct parent, so the check stays as it was.
      const belongsHere = newReply.rootPostId
        ? newReply.rootPostId === threadRootIdRef.current
        : newReply.parentId === postId || state.replies.some(r => r.id === newReply.parentId)

      if (belongsHere) {
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
    replyChain: state.replyChain,
    isLoading,
    isLoadingReplies,
    hasMoreReplies,
    isLoadingMoreReplies,
    loadMoreReplies,
    postEnrichment,
    error,
    refresh,
    addOptimisticReply,
    updatePost,
    updateReply
  }
}

/**
 * v2 thread assembly: one query per level, plus a recursive walk to discover the
 * author's own continuation, because `reply.parentId` names only the direct
 * parent and nothing links a reply to its thread.
 */
async function loadV2Thread(
  loadedPost: Post,
  postId: string,
  isCurrent: () => boolean
): Promise<{ replies: Reply[]; replyThreads: ReplyThread[] }> {
  const repliesResult = await replyService.getReplies(postId)
  const directReplies = repliesResult.documents

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
  for (const reply of [...directReplies].sort(byCreatedAtAsc)) {
    if (reply.author.id === mainAuthorId) {
      authorThreadChain.push(reply)
      authorThreadIds.add(reply.id)
    }
  }

  // Recursively fetch author's thread continuations (replies to thread posts)
  let currentThreadIds = authorThreadChain.map(r => r.id)
  while (currentThreadIds.length > 0) {
    const continuations = await fetchAuthorThreadContinuation(currentThreadIds)
    if (!isCurrent()) break
    if (continuations.length === 0) break

    continuations.sort(byCreatedAtAsc)
    authorThreadChain.push(...continuations)
    currentThreadIds = continuations.map(r => r.id)
  }

  // Other direct replies (not part of author thread)
  const otherDirectReplies = directReplies.filter(r => !authorThreadIds.has(r.id))

  // Fetch nested replies for all posts (author thread + other direct replies)
  const allIdsForNested = Array.from(
    new Set([...directReplies.map(r => r.id), ...authorThreadChain.map(r => r.id)])
  )
  const nestedRepliesMap = allIdsForNested.length > 0
    ? await replyService.getNestedReplies(allIdsForNested)
    : new Map<string, Reply[]>()

  const replyThreads = buildReplyTree(authorThreadChain, otherDirectReplies, nestedRepliesMap)
  const replies = [
    ...directReplies,
    ...authorThreadChain.filter(r => !directReplies.some(d => d.id === r.id)),
  ]

  return { replies, replyThreads }
}
