'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { Post } from '@/lib/types'
import { useSdk } from '@/contexts/sdk-context'
import { useAuth } from '@/contexts/auth-context'
import { loadHomepage, type HomepageSnapshot, type HomepageTopUser } from '@/lib/home/load-homepage'
import { moderationViewAll } from '@/lib/moderation-view'

export type TopUser = HomepageTopUser

export interface PlatformStats {
  totalPosts: number
  authorCount: number
  authorCountCapped: boolean
  postsToday: number | null
  loading: boolean
  error: string | null
}

export interface FeaturedPostsState {
  posts: Post[]
  loading: boolean
  error: string | null
}

export interface TopUsersState {
  users: TopUser[]
  loading: boolean
  error: string | null
}

export interface HomepageData {
  platformStats: PlatformStats
  featuredPosts: FeaturedPostsState
  topUsers: TopUsersState
  refresh: () => void
}

// One snapshot feeds all three slices: the loader proves the featured posts,
// their authors and the top contributors together (see lib/home/load-homepage).
// `allLanes`: read under the moderator view, so it holds hidden and restricted
// posts; only a load under the same view may reuse it.
let cache: { data: HomepageSnapshot; timestamp: number; allLanes: boolean } | null = null
const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

/**
 * `skipSignedIn`: a page that sends signed-in viewers elsewhere (`/` bounces
 * them to the feed) reads nothing for them, and waits for the stored session
 * to be checked before reading anything.
 */
export function useHomepageData({ skipSignedIn = false }: { skipSignedIn?: boolean } = {}): HomepageData {
  const { isReady: sdkReady } = useSdk()
  const { user, isAuthRestoring } = useAuth()
  const enabled = sdkReady && !(skipSignedIn && (isAuthRestoring || user))

  const [platformStats, setPlatformStats] = useState<PlatformStats>({
    totalPosts: 0,
    authorCount: 0,
    authorCountCapped: false,
    postsToday: null,
    loading: true,
    error: null
  })

  const [featuredPosts, setFeaturedPosts] = useState<FeaturedPostsState>({
    posts: [],
    loading: true,
    error: null
  })

  const [topUsers, setTopUsers] = useState<TopUsersState>({
    users: [],
    loading: true,
    error: null
  })

  const hasLoadedRef = useRef(false)

  const applySnapshot = useCallback((snapshot: HomepageSnapshot) => {
    setPlatformStats({
      totalPosts: snapshot.totalPosts,
      authorCount: snapshot.authorCount,
      authorCountCapped: snapshot.authorCountCapped,
      postsToday: snapshot.postsToday,
      loading: false,
      error: null,
    })
    setFeaturedPosts({ posts: snapshot.featuredPosts, loading: false, error: null })
    setTopUsers({ users: snapshot.topUsers, loading: false, error: null })
  }, [])

  const load = useCallback(async (forceRefresh = false) => {
    const allLanes = moderationViewAll()
    if (!forceRefresh && cache && cache.allLanes === allLanes && Date.now() - cache.timestamp < CACHE_TTL) {
      applySnapshot(cache.data)
      return
    }

    setPlatformStats(prev => ({ ...prev, loading: true, error: null }))
    setFeaturedPosts(prev => ({ ...prev, loading: true, error: null }))
    setTopUsers(prev => ({ ...prev, loading: true, error: null }))

    try {
      // The featured cards render as soon as they are proved; the stats and
      // contributors follow with the full snapshot.
      const snapshot = await loadHomepage((posts) => setFeaturedPosts({ posts, loading: false, error: null }))
      // Hidden posts are judged when the read lands: keep it only if the view did not change meanwhile.
      if (moderationViewAll() === allLanes) cache = { data: snapshot, timestamp: Date.now(), allLanes }
      applySnapshot(snapshot)
    } catch (error) {
      logger.error('Error loading homepage:', error)
      setPlatformStats(prev => ({ ...prev, loading: false, error: 'Failed to load platform statistics' }))
      setFeaturedPosts(prev => ({ ...prev, loading: false, error: 'Failed to load featured posts' }))
      setTopUsers(prev => ({ ...prev, loading: false, error: 'Failed to load top users' }))
    }
  }, [applySnapshot])

  const refresh = useCallback(() => {
    if (!enabled) return
    cache = null
    load(true).catch((error) => logger.error('Homepage refresh failed:', error))
  }, [enabled, load])

  // Initial load - wait for the SDK (and, when skipping signed-in viewers, the session check)
  useEffect(() => {
    if (!enabled) return
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true
    load().catch((error) => logger.error('Homepage load failed:', error))
  }, [enabled, load])

  return {
    platformStats,
    featuredPosts,
    topUsers,
    refresh
  }
}
