'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { Post } from '@/lib/types'
import { useSdk } from '@/contexts/sdk-context'
import { loadHomepage, type HomepageSnapshot, type HomepageTopUser } from '@/lib/home/load-homepage'

export type TopUser = HomepageTopUser

export interface PlatformStats {
  totalPosts: number
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
let cache: { data: HomepageSnapshot; timestamp: number } | null = null
const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

export function useHomepageData(): HomepageData {
  const { isReady: sdkReady } = useSdk()

  const [platformStats, setPlatformStats] = useState<PlatformStats>({
    totalPosts: 0,
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
    setPlatformStats({ totalPosts: snapshot.totalPosts, loading: false, error: null })
    setFeaturedPosts({ posts: snapshot.featuredPosts, loading: false, error: null })
    setTopUsers({ users: snapshot.topUsers, loading: false, error: null })
  }, [])

  const load = useCallback(async (forceRefresh = false) => {
    if (!forceRefresh && cache && Date.now() - cache.timestamp < CACHE_TTL) {
      applySnapshot(cache.data)
      return
    }

    setPlatformStats(prev => ({ ...prev, loading: true, error: null }))
    setFeaturedPosts(prev => ({ ...prev, loading: true, error: null }))
    setTopUsers(prev => ({ ...prev, loading: true, error: null }))

    try {
      const snapshot = await loadHomepage()
      cache = { data: snapshot, timestamp: Date.now() }
      applySnapshot(snapshot)
    } catch (error) {
      logger.error('Error loading homepage:', error)
      setPlatformStats(prev => ({ ...prev, loading: false, error: 'Failed to load platform statistics' }))
      setFeaturedPosts(prev => ({ ...prev, loading: false, error: 'Failed to load featured posts' }))
      setTopUsers(prev => ({ ...prev, loading: false, error: 'Failed to load top users' }))
    }
  }, [applySnapshot])

  const refresh = useCallback(() => {
    if (!sdkReady) return
    cache = null
    load(true).catch((error) => logger.error('Homepage refresh failed:', error))
  }, [sdkReady, load])

  // Initial load - wait for SDK to be ready
  useEffect(() => {
    if (!sdkReady) return
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true
    load().catch((error) => logger.error('Homepage load failed:', error))
  }, [sdkReady, load])

  return {
    platformStats,
    featuredPosts,
    topUsers,
    refresh
  }
}
