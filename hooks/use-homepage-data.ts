'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Post, User } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { useSdk } from '@/contexts/sdk-context'

export interface TopUser {
  id: string
  username: string
  displayName: string
  postCount: number
}

export interface PlatformStats {
  totalPosts: number
  totalUsers: number
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

// Cache for homepage data
const cache = {
  platformStats: null as { data: { totalPosts: number; totalUsers: number }; timestamp: number } | null,
  featuredPosts: null as { data: Post[]; timestamp: number } | null,
  topUsers: null as { data: TopUser[]; timestamp: number } | null,
}

const STATS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const POSTS_CACHE_TTL = 2 * 60 * 1000 // 2 minutes
const USERS_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

export function useHomepageData(): HomepageData {
  const { isReady: sdkReady } = useSdk()

  const [platformStats, setPlatformStats] = useState<PlatformStats>({
    totalPosts: 0,
    totalUsers: 0,
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

  const loadingRef = useRef(false)
  const hasLoadedRef = useRef(false)

  const loadPlatformStats = useCallback(async (forceRefresh = false) => {
    // Check cache
    if (!forceRefresh && cache.platformStats &&
        Date.now() - cache.platformStats.timestamp < STATS_CACHE_TTL) {
      setPlatformStats({
        ...cache.platformStats.data,
        loading: false,
        error: null
      })
      return
    }

    setPlatformStats(prev => ({ ...prev, loading: true, error: null }))

    try {
      const [totalPosts, totalUsers] = await Promise.all([
        postService.countAllPosts(),
        postService.countUniqueAuthors()
      ])

      const data = { totalPosts, totalUsers }
      cache.platformStats = { data, timestamp: Date.now() }

      setPlatformStats({
        ...data,
        loading: false,
        error: null
      })
    } catch (error) {
      console.error('Error loading platform stats:', error)
      setPlatformStats(prev => ({
        ...prev,
        loading: false,
        error: 'Failed to load platform statistics'
      }))
    }
  }, [])

  const loadFeaturedPosts = useCallback(async (forceRefresh = false) => {
    // Check cache
    if (!forceRefresh && cache.featuredPosts &&
        Date.now() - cache.featuredPosts.timestamp < POSTS_CACHE_TTL) {
      setFeaturedPosts({
        posts: cache.featuredPosts.data,
        loading: false,
        error: null
      })
      return
    }

    setFeaturedPosts(prev => ({ ...prev, loading: true, error: null }))

    try {
      const posts = await postService.getTopPostsByLikes(5)

      // Fetch quoted posts for posts that have a quotedPostId
      const quotedPostIds = posts
        .filter((p) => p.quotedPostId)
        .map((p) => p.quotedPostId as string)

      if (quotedPostIds.length > 0) {
        try {
          const quotedPosts = await postService.getPostsByIds(quotedPostIds)
          const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

          for (const post of posts) {
            if (post.quotedPostId && quotedPostMap.has(post.quotedPostId)) {
              post.quotedPost = quotedPostMap.get(post.quotedPostId)
            }
          }
        } catch (quoteError) {
          console.error('Error fetching quoted posts for featured posts:', quoteError)
          // Don't fail the whole load if quoted posts fail
        }
      }

      cache.featuredPosts = { data: posts, timestamp: Date.now() }

      setFeaturedPosts({
        posts,
        loading: false,
        error: null
      })
    } catch (error) {
      console.error('Error loading featured posts:', error)
      setFeaturedPosts(prev => ({
        ...prev,
        loading: false,
        error: 'Failed to load featured posts'
      }))
    }
  }, [])

  const loadTopUsers = useCallback(async (forceRefresh = false) => {
    // Check cache
    if (!forceRefresh && cache.topUsers &&
        Date.now() - cache.topUsers.timestamp < USERS_CACHE_TTL) {
      setTopUsers({
        users: cache.topUsers.data,
        loading: false,
        error: null
      })
      return
    }

    setTopUsers(prev => ({ ...prev, loading: true, error: null }))

    try {
      // Get post counts per author
      const authorCounts = await postService.getAuthorPostCounts()

      if (authorCounts.size === 0) {
        setTopUsers({ users: [], loading: false, error: null })
        return
      }

      // Sort by post count and take top 6
      const sortedAuthors = Array.from(authorCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)

      const authorIds = sortedAuthors.map(([id]) => id)

      // Fetch profiles and usernames in parallel
      const [profiles, usernameMap] = await Promise.all([
        unifiedProfileService.getProfilesByIdentityIds(authorIds),
        dpnsService.resolveUsernamesBatch(authorIds)
      ])

      // Build profile map
      const profileMap = new Map<string, any>()
      for (const profile of profiles) {
        const ownerId = profile.$ownerId || (profile as any).ownerId
        if (ownerId) {
          profileMap.set(ownerId, profile)
        }
      }

      // Build top users array
      const users: TopUser[] = sortedAuthors.map(([authorId, postCount]) => {
        const profile = profileMap.get(authorId)
        const profileData = profile?.data || profile
        const username = usernameMap.get(authorId) || authorId.substring(0, 8) + '...'

        return {
          id: authorId,
          username,
          displayName: profileData?.displayName || username,
          postCount
        }
      })

      cache.topUsers = { data: users, timestamp: Date.now() }

      setTopUsers({
        users,
        loading: false,
        error: null
      })
    } catch (error) {
      console.error('Error loading top users:', error)
      setTopUsers(prev => ({
        ...prev,
        loading: false,
        error: 'Failed to load top users'
      }))
    }
  }, [])

  const refresh = useCallback(() => {
    if (!sdkReady) return

    // Clear cache
    cache.platformStats = null
    cache.featuredPosts = null
    cache.topUsers = null

    // Reload all data
    loadPlatformStats(true)
    loadFeaturedPosts(true)
    loadTopUsers(true)
  }, [sdkReady, loadPlatformStats, loadFeaturedPosts, loadTopUsers])

  // Initial load - wait for SDK to be ready
  useEffect(() => {
    if (!sdkReady) return
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true

    // Load all data in parallel
    loadPlatformStats()
    loadFeaturedPosts()
    loadTopUsers()
  }, [sdkReady, loadPlatformStats, loadFeaturedPosts, loadTopUsers])

  return {
    platformStats,
    featuredPosts,
    topUsers,
    refresh
  }
}
