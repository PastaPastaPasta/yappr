import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Post, Reply, ReplyThread } from '@/lib/types'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { attachQuotedPosts } from '@/lib/feed/resolve-quoted-posts'
import { isBareRepost, quotedTargetIdOf } from '@/lib/feed/quote-reposts'
import { hasFlatThreads, referencesMayDangle, targetKindOf, threadRootIdOf } from '@/lib/contract-topology'
import { withMissingReplyParents, type MissingParentReads } from '@/lib/feed/deleted-reply-stubs'
import { assembleFlatThread, authorThreadDepthFirst, buildReplyTree, byCreatedAtAsc, MAX_NESTED_DEPTH } from '@/lib/feed/reply-thread'
import { provenAbsent } from '@/lib/feed/prove-absent'
import { chunk, mapLimit, MAX_IN_CLAUSE_VALUES } from '@/lib/services/pagination-utils'
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
  /**
   * Thread root ids the chain could not load (v9: the contract's moderators
   * removed the root while this reply stayed). Rendered as removed stubs
   * above the chain.
   */
  removedChainIds: string[]
  /**
   * True while a reply is on screen (e.g. from cached navigation data) but its
   * thread's root has not been looked up yet, or the lookup failed: whether the
   * thread can still be replied to is not known, so nothing should be offered
   * to reply to.
   */
  replyRootPending: boolean
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

/**
 * Insert `newThread` under the reply with id `parentId`, at any rendered depth.
 * Returns null when the parent is not on this page (past the depth cap), so
 * the caller can fall back to the top of the list.
 */
function nestUnderReply(
  threads: ReplyThread[],
  parentId: string,
  newThread: ReplyThread
): ReplyThread[] | null {
  let changed = false
  const result = threads.map((thread) => {
    if (thread.content.id === parentId) {
      changed = true
      return { ...thread, nestedReplies: [...thread.nestedReplies, newThread] }
    }
    const nested = nestUnderReply(thread.nestedReplies, parentId, newThread)
    if (nested) {
      changed = true
      return { ...thread, nestedReplies: nested }
    }
    return thread
  })
  return changed ? result : null
}

/**
 * What keeps the replies under a missing parent in the thread
 * (`withMissingReplyParents`): the tombstoned parents a live-keyed
 * `repliesOf` does not list, read by id, and stubs for the parents proved
 * gone. Both reads reject, so a failed one fails the page.
 */
const missingParentReads: MissingParentReads = {
  // Fresh, not cached: a parent tombstoned since it was cached must read as the tombstone.
  getMany: (ids) => replyService.getManyOrThrow(ids),
  provenAbsent: (ids) => provenAbsent('reply', ids, { throwOnError: true }),
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
  const router = useRouter()
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
  const [removedChainIds, setRemovedChainIds] = useState<string[]>([])
  // The post id whose thread root has been looked up: a refresh of the same post
  // keeps its answer instead of blocking replies again. A failed load leaves it
  // unset, so replies stay blocked until a reload verifies the root.
  const [rootCheckedFor, setRootCheckedFor] = useState<string | null>(null)

  // Track loaded post to prevent duplicate loads
  const loadedPostIdRef = useRef<string | null>(null)
  // Incrementing token to ignore stale async responses
  const loadRequestIdRef = useRef(0)
  // The thread this page is showing, and where the next page of it starts.
  const threadRootIdRef = useRef<string | null>(null)
  const replyCursorRef = useRef<string | undefined>(undefined)
  // Accepted writes stay visible until a proved thread read includes them.
  const acceptedRepliesRef = useRef(new Map<string, { reply: Reply; confirmed: boolean; ancestors: Reply[] }>())
  /** The ids of the replies on screen, for Load More to tell a missing parent from one an earlier page holds. */
  const shownReplyIdsRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    shownReplyIdsRef.current = new Set(state.replies.map(reply => reply.id))
  }, [state.replies])
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const reconcileGenerationRef = useRef(0)

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
   * On v9 a reply names its thread root, so the ancestry is exactly one document
   * — no walk, and no ambiguity about which of several nesting levels is "the"
   * context. On v2 the only link is the polymorphic direct parent, so the chain
   * has to be walked one lookup at a time.
   */
  const fetchReplyChain = useCallback(async (mainPost: Post): Promise<{ chain: Post[]; removed: string[] }> => {
    const chain: Post[] = []
    const removed: string[] = []

    if (hasFlatThreads()) {
      const rootId = threadRootIdOf(mainPost)
      const rootPost = await postService.getOrThrow(rootId)
      if (rootPost) chain.push(rootPost)
      // The reply's `rootPostId` is a deletableDocument reference on v9: a
      // missing root is a moderator takedown (or on v10 its author's delete),
      // not a transport fault, and the page says so instead of showing an
      // orphaned reply.
      else if (referencesMayDangle()) removed.push(rootId)
    } else {
      let currentParentId: string | undefined = mainPost.parentId
      const MAX_DEPTH = 50 // Safety limit to prevent infinite loops

      while (currentParentId && chain.length < MAX_DEPTH) {
        // First try as a post
        let parent = await postService.getOrThrow(currentParentId)

        if (!parent) {
          // Try as a reply
          const reply = await replyService.getOrThrow(currentParentId)
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
        // The chain is not in state yet, so the enrichment callback cannot
        // update it. Install the returned authors and stats with the chain.
        return { chain: await enrich(chain), removed }
      } catch (err) {
        logger.error('usePostDetail: Failed to enrich reply chain:', err)
      }
    }

    return { chain, removed }
  }, [enrich])

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
      // The convenience getPostById/getReplyById helpers turn transport errors
      // into null. Use the underlying read so an outage reaches the retry UI
      // instead of looking like a proved missing document.
      loadedPost = await postService.getOrThrow(postId)

      if (!loadedPost) {
        // Not a post - check if it's a reply
        const reply = await replyService.getOrThrow(postId)
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

      // v10: a bare repost has no page of its own. It renders as its target,
      // and replies, likes and tips must act on the target, not on the repost
      // document, so its link goes to the target (a reply opens in its thread).
      const repostTarget = isBareRepost(loadedPost) ? quotedTargetIdOf(loadedPost) : undefined
      if (repostTarget) {
        router.replace(`/post?id=${repostTarget}`)
        return
      }

      threadRootIdRef.current = threadRootIdOf(loadedPost)

      // If the loaded item is a reply, show the context it hangs off
      let replyChain: Post[] = []
      if (targetKindOf(loadedPost) === 'reply') {
        const resolved = await fetchReplyChain(loadedPost)
        if (!isCurrent()) return
        replyChain = resolved.chain
        setRemovedChainIds(resolved.removed)
      } else {
        setRemovedChainIds([])
      }
      setRootCheckedFor(postId)

      // Show the main post as soon as it's available
      setState(current => {
        const sameThread = current.post?.id === postId
        return {
          post: loadedPost,
          replies: sameThread ? current.replies : [],
          replyThreads: sameThread ? current.replyThreads : [],
          replyChain
        }
      })
      setIsLoading(false)

      // Enrich the main post without blocking replies or UI
      enrich([loadedPost]).catch((err) => {
        logger.error('usePostDetail: Failed to enrich main post:', err)
      })
    } catch (err) {
      if (!isCurrent()) return
      logger.error('usePostDetail: Failed to load post:', err)
      setError('This post could not be loaded. Please try again.')
      // Keep this thread's last successful data during a failed refresh.
      setState(current => current.post?.id === postId
        ? current
        : { post: null, replies: [], replyThreads: [], replyChain: [] })
      setIsLoading(false)
      setIsLoadingReplies(false)
      return
    }

    if (!loadedPost) return

    try {
      let replies: Reply[]
      let replyThreads: ReplyThread[] = []
      let nextCursor: string | undefined

      if (hasFlatThreads()) {
        // One query for the entire thread, keyed on the root every reply shares
        // (v9: oldest first across branches; v10: grouped by parent, direct
        // replies first — see replyService.getReplies).
        const rootId = threadRootIdOf(loadedPost)
        const result = await replyService.getReplies(rootId)
        if (!isCurrent()) return
        replies = result.documents
        nextCursor = result.nextCursor

        // Viewing a reply renders a slice of the thread — its own subtree — but
        // the thread query pages from the root (oldest first on v9, parent by
        // parent on v10), so on threads longer than one page that slice can sit
        // entirely past the loaded page. Landing here from a "Continue thread" row would then show
        // "No replies yet" despite the row promising more. Fetch the focused
        // subtree level by level (targeted replyToReplyId queries, pinned to
        // the thread root on v10) down to the
        // full depth the page renders: every rendered reply then either shows
        // its children or is a nested item whose own Continue row (backed by
        // enrichment counts) leads onward.
        if (targetKindOf(loadedPost) === 'reply' && result.nextCursor) {
          const renderedDepth = MAX_NESTED_DEPTH + 1
          let frontier = [loadedPost.id]
          for (let depth = 0; depth < renderedDepth && frontier.length > 0; depth++) {
            const childrenMap = await replyService.getNestedReplies(frontier, { rootPostId: rootId, throwOnError: true })
            if (!isCurrent()) return
            const known = new Set(replies.map((reply) => reply.id))
            const fresh = Array.from(childrenMap.values()).flat()
              .filter((reply) => !known.has(reply.id))
            replies = [...replies, ...fresh]
            const frontierSet = new Set(frontier)
            frontier = replies
              .filter((reply) => reply.replyToReplyId && frontierSet.has(reply.replyToReplyId))
              .map((reply) => reply.id)
          }
        }

      } else {
        ;({ replies, replyThreads } = await loadV2Thread(loadedPost, postId, isCurrent))
        if (!isCurrent()) return
      }

      const fetchedReplies = new Map(replies.map(reply => [reply.id, reply]))
      const collectReplies = (threads: ReplyThread[]): void => {
        for (const thread of threads) {
          fetchedReplies.set(thread.content.id, thread.content)
          collectReplies(thread.nestedReplies)
        }
      }
      if (!hasFlatThreads()) collectReplies(replyThreads)
      const fetchedIds = new Set(fetchedReplies.keys())
      const acceptedReplies = new Map(acceptedRepliesRef.current)
      // Confirmation stops indexing retries, but saved content must still
      // reflect later edits and deletions. Refresh confirmed overlays and their
      // missing ancestry without accepting cached documents as fresh evidence.
      const retainedIds = [...new Set([...acceptedReplies].flatMap(([id, entry]) =>
        [...(entry.confirmed ? [id] : []), ...entry.ancestors.map(parent => parent.id)]))]
        .filter(id => !fetchedIds.has(id))
      const retainedPages = await mapLimit(chunk(retainedIds, MAX_IN_CLAUSE_VALUES), 2, ids =>
        replyService.query({ where: [['$id', 'in', ids]], limit: ids.length }))
      if (!isCurrent()) return
      const currentRetained = new Map(retainedPages.flatMap(page => page.documents).map(reply => [reply.id, reply]))
      for (const [id, entry] of acceptedReplies) {
        const freshReply = fetchedReplies.get(id) ?? currentRetained.get(id)
        if (entry.confirmed && !freshReply) {
          acceptedReplies.delete(id)
          continue
        }
        const ancestors = entry.ancestors.flatMap(parent => {
          const current = fetchedReplies.get(parent.id) ?? currentRetained.get(parent.id)
          return current ? [current] : []
        })
        if (fetchedIds.has(id) && ancestors.every(parent => fetchedIds.has(parent.id))) acceptedReplies.delete(id)
        else acceptedReplies.set(id, {
          ...entry, ancestors, reply: freshReply ?? entry.reply,
          confirmed: entry.confirmed || fetchedIds.has(id),
        })
      }
      const pendingIds = [...acceptedReplies].filter(([, entry]) => !entry.confirmed).map(([id]) => id)
      // A new reply can be beyond page one. Confirm its id without reading the
      // entire thread, and keep the overlay until a loaded page includes it.
      if (pendingIds.length > 0) {
        const confirmed = await replyService.getMany(pendingIds, { throwOnError: true })
        if (!isCurrent()) return
        for (const reply of confirmed) {
          const pending = acceptedReplies.get(reply.id)
          if (pending) acceptedReplies.set(reply.id, {
            ...pending, reply: { ...reply, author: pending.reply.author }, confirmed: true,
          })
        }
      }
      const overlayReplies = [...acceptedReplies.values()].flatMap(entry => [...entry.ancestors, entry.reply])
      const included = new Set(fetchedIds)
      for (const reply of overlayReplies) {
        if (included.has(reply.id)) continue
        included.add(reply.id)
        replies = [...replies, reply]
        if (!hasFlatThreads()) {
          const newThread: ReplyThread = { content: reply, isAuthorThread: false, isThreadContinuation: false, nestedReplies: [] }
          const parentId = reply.replyToReplyId ?? reply.parentId
          replyThreads = (parentId ? nestUnderReply(replyThreads, parentId, newThread) : null) ?? [...replyThreads, newThread]
        }
      }
      if (hasFlatThreads()) {
        replies = await withMissingReplyParents(replies, missingParentReads)
        if (!isCurrent()) return
        replyThreads = assembleFlatThread(loadedPost, replies)
      }

      // Resolve whatever the main post quotes (chain items are done in fetchReplyChain)
      await attachQuotedPosts([loadedPost])
      if (!isCurrent()) return
      const quotedPost = loadedPost.quotedPost

      // Commit reconciliation only when all page reads and proofs succeeded.
      acceptedRepliesRef.current = acceptedReplies
      // Publish pagination only after this page is complete. A failed nested
      // read or parent proof must not allow pagination past an uncommitted page.
      replyCursorRef.current = nextCursor
      setHasMoreReplies(Boolean(nextCursor))

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
      setError('Replies could not be refreshed. Please try again.')
    } finally {
      if (isCurrent()) {
        setIsLoadingReplies(false)
      }
    }
  }, [postId, enabled, enrich, fetchReplyChain, router])

  /**
   * Fetch the next page of the thread (v9 only — v2's `getReplies` covers one
   * level, which the old code already fetched whole).
   */
  const loadMoreReplies = useCallback(async () => {
    const cursor = replyCursorRef.current
    const rootId = threadRootIdRef.current
    if (!cursor || !rootId || isLoadingMoreReplies) return
    const requestId = loadRequestIdRef.current

    setIsLoadingMoreReplies(true)
    try {
      const result = await replyService.getReplies(rootId, { startAfter: cursor })
      // Navigating away mid-flight would otherwise merge this thread's next page
      // into whatever post the page moved on to.
      if (threadRootIdRef.current !== rootId || loadRequestIdRef.current !== requestId) return
      // A parent an earlier page holds is not missing: it is neither read again nor proved.
      const page = await withMissingReplyParents(result.documents, missingParentReads, shownReplyIdsRef.current)
      if (threadRootIdRef.current !== rootId || loadRequestIdRef.current !== requestId) return
      const fetched = new Map(result.documents.map(reply => [reply.id, reply]))
      for (const [id, entry] of acceptedRepliesRef.current) {
        acceptedRepliesRef.current.set(id, {
          ...entry,
          reply: fetched.get(id) ?? entry.reply,
          confirmed: entry.confirmed || fetched.has(id),
          ancestors: entry.ancestors.map(parent => fetched.get(parent.id) ?? parent),
        })
      }
      replyCursorRef.current = result.nextCursor
      setHasMoreReplies(Boolean(result.nextCursor))
      setError(null)

      setState(current => {
        if (!current.post) return current
        const onPage = new Set(page.map(reply => reply.id))
        const merged = [...current.replies.filter(reply => !onPage.has(reply.id)), ...page]
        return { ...current, replies: merged, replyThreads: assembleFlatThread(current.post, merged) }
      })
    } catch (err) {
      logger.error('usePostDetail: Failed to load more replies:', err)
      if (threadRootIdRef.current === rootId && loadRequestIdRef.current === requestId) {
        setError('Replies could not be refreshed. Please try again.')
      }
    } finally {
      setIsLoadingMoreReplies(false)
    }
  }, [isLoadingMoreReplies])

  const cancelRequests = useCallback(() => {
    acceptedRepliesRef.current.clear()
    loadRequestIdRef.current++
    reconcileGenerationRef.current++
    clearTimeout(reconcileTimerRef.current)
  }, [])

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

    loadPost().catch((err) => logger.error('usePostDetail: load failed:', err))
    return cancelRequests
  }, [postId, enabled, loadPost, resetEnrichment, cancelRequests])

  const refresh = useCallback(async () => {
    loadedPostIdRef.current = null
    resetEnrichment()
    await loadPost()
  }, [loadPost, resetEnrichment])

  const addOptimisticReply = useCallback((reply: Reply) => {
    setState(current => {
      if (current.replies.some(known => known.id === reply.id)) return current
      const newThread: ReplyThread = {
        content: reply,
        isAuthorThread: false,
        isThreadContinuation: false,
        nestedReplies: []
      }

      // A reply to a reply belongs UNDER that reply. Dropping it at the top would
      // show it in the wrong place, and on a flat thread nothing refetches in
      // between. A nesting target that is not on this page (past the rendered
      // depth cap) falls back to the top of the list.
      const nestUnder = reply.replyToReplyId ?? reply.parentId
      const nestedThreads = nestUnder
        ? nestUnderReply(current.replyThreads, nestUnder, newThread)
        : null

      return {
        ...current,
        replies: [reply, ...current.replies],
        replyThreads: nestedThreads ?? [newThread, ...current.replyThreads],
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

      const known = new Map(state.replies.map(reply => [reply.id, reply]))
      const collect = (threads: ReplyThread[]): void => {
        for (const thread of threads) {
          known.set(thread.content.id, thread.content)
          collect(thread.nestedReplies)
        }
      }
      collect(state.replyThreads)
      // Flat replies name the thread root; v2 replies name a direct parent,
      // including descendants rendered only in the nested tree.
      const belongsHere = newReply.rootPostId
        ? newReply.rootPostId === threadRootIdRef.current
        : newReply.parentId === postId || known.has(newReply.parentId)

      if (belongsHere) {
        // Keep the visible ancestry if refresh starts again at page one.
        const ancestors: Reply[] = []
        const seen = new Set([newReply.id])
        let parentId = newReply.replyToReplyId ?? newReply.parentId
        while (parentId && parentId !== postId && !seen.has(parentId)) {
          seen.add(parentId)
          const parent = known.get(parentId)
          if (!parent) break
          ancestors.unshift(parent)
          parentId = parent.replyToReplyId ?? parent.parentId
        }
        acceptedRepliesRef.current.set(newReply.id, { reply: newReply, confirmed: false, ancestors })
        addOptimisticReply(newReply)
        clearTimeout(reconcileTimerRef.current)
        const generation = ++reconcileGenerationRef.current
        // SDK reads already retry quorum rotations in sdk-read-retry.ts.
        // This bounded reconciliation also covers an accepted write not indexed yet,
        // or a refresh that exhausted the SDK's transport retries. Never resend it.
        const reconcile = async (attempt: number): Promise<void> => {
          await refresh()
          if (generation !== reconcileGenerationRef.current || ![...acceptedRepliesRef.current.values()].some(entry => !entry.confirmed)) return
          if (attempt < 3) {
            reconcileTimerRef.current = setTimeout(() => {
              reconcile(attempt + 1).catch(err => logger.error('Reply reconciliation failed:', err))
            }, [1000, 3000, 8000][attempt])
          } else {
            setError('Your reply is posted. The thread could not be refreshed. Please try again.')
          }
        }
        reconcile(0).catch(err => logger.error('Reply reconciliation failed:', err))
      }
    }

    window.addEventListener('reply-created', handleReplyCreated as EventListener)
    return () => {
      window.removeEventListener('reply-created', handleReplyCreated as EventListener)
    }
  }, [postId, state.replies, state.replyThreads, refresh, addOptimisticReply])

  return {
    post: state.post,
    replies: state.replies,
    replyThreads: state.replyThreads,
    replyChain: state.replyChain,
    removedChainIds,
    replyRootPending: state.post !== null && targetKindOf(state.post) === 'reply' && rootCheckedFor !== postId,
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
  const authorChildrenOf = new Map<string, Reply[]>()

  // Helper to recursively fetch author's thread continuation
  const fetchAuthorThreadContinuation = async (parentIds: string[]): Promise<Reply[]> => {
    if (parentIds.length === 0) return []
    const nestedMap = await replyService.getNestedReplies(parentIds, { throwOnError: true })
    const authorContinuations: Reply[] = []

    nestedMap.forEach((nested, parentId) => {
      const authorChildren: Reply[] = []
      for (const reply of nested) {
        if (reply.author.id === mainAuthorId && authorThreadIds.has(parentId) && !authorThreadIds.has(reply.id)) {
          authorContinuations.push(reply)
          authorChildren.push(reply)
          authorThreadIds.add(reply.id)
        }
      }
      authorChildrenOf.set(parentId, authorChildren)
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
    ? await replyService.getNestedReplies(allIdsForNested, { throwOnError: true })
    : new Map<string, Reply[]>()

  const orderedAuthorThread = authorThreadDepthFirst(mainAuthorId, directReplies, authorChildrenOf)
  const replyThreads = buildReplyTree(orderedAuthorThread, otherDirectReplies, nestedRepliesMap)
  const replies = [
    ...directReplies,
    ...authorThreadChain.filter(r => !directReplies.some(d => d.id === r.id)),
  ]

  return { replies, replyThreads }
}
