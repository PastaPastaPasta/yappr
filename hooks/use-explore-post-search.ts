import { useCallback, useEffect, useRef, useState } from 'react'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { searchPostPage } from '@/lib/search/post-search'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'

interface SearchState {
  posts: Post[]
  cursor?: string
  scanned: number
  hasMore: boolean
  loading: boolean
  error: string | null
}

const emptyState: SearchState = {
  posts: [], scanned: 0, hasMore: true, loading: false, error: null,
}

export function useExplorePostSearch(query: string, userId?: string) {
  const [state, setState] = useState<SearchState>(emptyState)
  const generationRef = useRef(0)
  const pendingRef = useRef(false)

  const load = useCallback(async (generation: number, cursor?: string) => {
    try {
      const page = await searchPostPage(query, cursor)
      if (generationRef.current !== generation) return
      const authorIds = Array.from(new Set(page.posts.map(post => post.author.id).filter(Boolean)))
      const blocked = userId && authorIds.length
        ? await checkBlockedForAuthors(userId, authorIds)
        : new Map<string, boolean>()
      if (generationRef.current !== generation) return
      const visible = page.posts.filter(post => !blocked.get(post.author.id))
      // Preserve the display enrichment used by Explore: PostCard does not
      // resolve placeholder authors or engagement counts on its own.
      const { postService } = await import('@/lib/services/post-service')
      const enriched = await postService.enrichPostsBatch(visible)
      if (generationRef.current !== generation) return
      setState(current => {
        const posts = new Map(current.posts.map(post => [post.id, post]))
        enriched.forEach(post => posts.set(post.id, post))
        return {
          posts: Array.from(posts.values()), cursor: page.cursor,
          scanned: current.scanned + page.scanned, hasMore: page.hasMore,
          loading: false, error: null,
        }
      })
    } catch (error) {
      logger.error('Explore post search failed:', error)
      if (generationRef.current === generation) {
        setState(current => ({ ...current, loading: false, error: 'Could not search posts. Please try again.' }))
      }
    } finally {
      if (generationRef.current === generation) pendingRef.current = false
    }
  }, [query, userId])

  useEffect(() => {
    const generation = ++generationRef.current
    pendingRef.current = false
    setState({ ...emptyState, loading: !!query })
    if (!query) return
    const timer = setTimeout(() => {
      pendingRef.current = true
      void load(generation)
    }, 300)
    const generations = generationRef
    return () => {
      clearTimeout(timer)
      ++generations.current
    }
  }, [load, query])

  const loadMore = useCallback(async () => {
    if (!query || pendingRef.current || state.loading || !state.hasMore) return
    pendingRef.current = true
    setState(current => ({ ...current, loading: true, error: null }))
    await load(generationRef.current, state.cursor)
  }, [load, query, state.cursor, state.hasMore, state.loading])

  return {
    ...state,
    isSearching: state.loading && state.scanned === 0,
    isLoadingMore: state.loading && state.scanned > 0,
    loadMore,
  }
}
