'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { fetchReplyParents } from '@/lib/feed/resolve-reply-parents'
import { replyToPost } from '@/lib/services/post-service'

const PAGE_SIZE = 50

function newRequest(userId: string | null) {
  return {
    userId, cancelled: false, busy: false, cursor: undefined as string | undefined,
    posts: [] as Post[], parentRequests: 0,
  }
}

/** One profile's reply history, with a document cursor independent of visible cards. */
export function useProfileReplies(userId: string | null, enrichProgressively: (posts: Post[]) => void) {
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [parents, setParents] = useState<Map<string, Post>>(new Map())
  const [parentsLoading, setParentsLoading] = useState(false)
  const request = useRef(newRequest(userId))

  useEffect(() => {
    const state = newRequest(userId)
    request.current = state
    setPosts([])
    setLoading(false)
    setLoadingMore(false)
    setLoaded(false)
    setHasMore(false)
    setError(null)
    setParents(new Map())
    setParentsLoading(false)
    return () => { state.cancelled = true }
  }, [userId])

  const load = useCallback(async (append = false) => {
    const state = request.current
    if (!userId || state.userId !== userId || state.cancelled || state.busy || (append && !state.cursor)) return
    state.busy = true
    setError(null)
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const { replyService } = await import('@/lib/services/reply-service')
      const result = await replyService.getUserReplies(userId, {
        limit: PAGE_SIZE,
        startAfter: append ? state.cursor : undefined,
      })
      if (state.cancelled) return
      const next = result.documents.map(replyToPost)
      state.cursor = result.nextCursor
      setHasMore(!!result.nextCursor)
      const known = new Set(state.posts.map(post => post.id))
      state.posts = append ? [...state.posts, ...next.filter(post => !known.has(post.id))] : next
      setPosts(state.posts)
      // Starting enrichment cancels its previous batch; include earlier pages
      // so a quick continuation cannot abandon their still-pending metadata.
      enrichProgressively(state.posts)
      state.parentRequests++
      setParentsLoading(true)
      fetchReplyParents(next)
        .then(found => {
          if (!state.cancelled) setParents(previous => new Map([...previous, ...found]))
        })
        .catch(err => logger.error('Failed to load reply parents:', err))
        .finally(() => {
          state.parentRequests--
          if (!state.cancelled) setParentsLoading(state.parentRequests > 0)
        })
    } catch (err) {
      logger.error('Failed to load profile replies:', err)
      if (!state.cancelled) setError('Could not load replies. Check your connection and try again.')
    } finally {
      state.busy = false
      if (!state.cancelled) {
        setLoaded(true)
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [userId, enrichProgressively])

  return {
    posts, loading, loadingMore, loaded, hasMore, error, parents, parentsLoading, load,
    onLoadMore: () => { void load(true) },
    onRetry: () => { void load(posts.length > 0) },
  }
}
