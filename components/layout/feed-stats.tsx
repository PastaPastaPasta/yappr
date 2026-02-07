'use client'

import { useEffect, useState, useRef } from 'react'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { formatNumber } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { postService, followService } from '@/lib/services'
import { cacheManager } from '@/lib/cache-manager'

interface UserStats {
  posts: number
  followers: number
  following: number
}

interface GlobalStats {
  totalPosts: number
  activeUsers: number
}

// Skeleton placeholder for stats section
function StatsPlaceholder({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="flex justify-between">
          <div className="h-4 w-20 bg-zinc-200 dark:bg-zinc-800 rounded-lg animate-pulse" />
          <div className="h-4 w-8 bg-zinc-200 dark:bg-zinc-800 rounded-lg animate-pulse" />
        </div>
      ))}
    </div>
  )
}

export function FeedStats() {
  const { user } = useAuth()
  const [stats, setStats] = useState<UserStats | null>(null)
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [globalLoading, setGlobalLoading] = useState(false)
  const [shouldLoad, setShouldLoad] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Defer loading until the component is visible or after a delay
  // This ensures the main feed content loads first
  useEffect(() => {
    // Use Intersection Observer to load when visible
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setShouldLoad(true)
          observer.disconnect()
        }
      },
      { rootMargin: '100px' } // Start loading slightly before visible
    )

    // Also set a timeout as fallback - load after 2 seconds even if not visible
    const timeoutId = setTimeout(() => {
      setShouldLoad(true)
      observer.disconnect()
    }, 2000)

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => {
      observer.disconnect()
      clearTimeout(timeoutId)
    }
  }, [])

  // Fetch user stats only when shouldLoad is true
  useEffect(() => {
    if (!shouldLoad || !user?.identityId) {
      if (!user?.identityId) {
        setStats(null)
      }
      return
    }

    let cancelled = false
    const currentIdentityId = user.identityId

    const fetchStats = async () => {
      // Check cache first to reduce network queries
      const cacheKey = `user_stats_${currentIdentityId}`
      const cached = cacheManager.get<UserStats>('sidebar', cacheKey)
      if (cached) {
        if (!cancelled) {
          setStats(cached)
        }
        return
      }

      if (!cancelled) {
        setLoading(true)
      }
      try {
        const [posts, followers, following] = await Promise.all([
          postService.countUserPosts(currentIdentityId),
          followService.countFollowers(currentIdentityId),
          followService.countFollowing(currentIdentityId)
        ])
        if (!cancelled) {
          const newStats = { posts, followers, following }
          setStats(newStats)
          // Cache for 2 minutes to reduce query frequency
          cacheManager.set('sidebar', cacheKey, newStats, { ttl: 120000 })
        }
      } catch (error) {
        console.error('Error fetching user stats:', error)
        if (!cancelled) {
          setStats({ posts: 0, followers: 0, following: 0 })
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchStats().catch(err => console.error('Failed to fetch stats:', err))

    return () => {
      cancelled = true
    }
  }, [shouldLoad, user?.identityId])

  // Fetch global stats only when shouldLoad is true
  useEffect(() => {
    if (!shouldLoad) return

    let cancelled = false

    const fetchGlobalStats = async () => {
      // Check cache first to reduce network queries
      const cacheKey = 'global_platform_stats'
      const cached = cacheManager.get<GlobalStats>('sidebar', cacheKey)
      if (cached) {
        if (!cancelled) {
          setGlobalStats(cached)
        }
        return
      }

      if (!cancelled) {
        setGlobalLoading(true)
      }
      try {
        const [totalPosts, activeUsers] = await Promise.all([
          postService.countAllPosts(),
          postService.countUniqueAuthors()
        ])
        if (!cancelled) {
          const newGlobalStats = { totalPosts, activeUsers }
          setGlobalStats(newGlobalStats)
          // Cache for 5 minutes since global stats change slowly
          cacheManager.set('sidebar', cacheKey, newGlobalStats, { ttl: 300000 })
        }
      } catch (error) {
        console.error('Error fetching global stats:', error)
        if (!cancelled) {
          setGlobalStats({ totalPosts: 0, activeUsers: 0 })
        }
      } finally {
        if (!cancelled) {
          setGlobalLoading(false)
        }
      }
    }

    fetchGlobalStats().catch(err => console.error('Failed to fetch global stats:', err))

    return () => {
      cancelled = true
    }
  }, [shouldLoad])

  return (
    <div ref={containerRef} className="bg-zinc-50 dark:bg-zinc-900/50 rounded-2xl overflow-hidden border border-zinc-200/50 dark:border-zinc-800/30">
      <h2 className="text-base font-bold px-4 py-3 flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
        <ChartBarIcon className="h-4.5 w-4.5 text-zinc-500" />
        Stats
      </h2>
      <div className="px-4 py-3 space-y-2">
        {!shouldLoad || globalLoading || !globalStats ? (
          // Show placeholder until global stats are loaded
          <StatsPlaceholder rows={2} />
        ) : (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">Total Posts</span>
              <span className="font-medium">{formatNumber(globalStats.totalPosts)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">Active Users</span>
              <span className="font-medium">{formatNumber(globalStats.activeUsers)}</span>
            </div>
          </>
        )}
        {user && (
          <>
            {!shouldLoad || loading || !stats ? (
              // Show placeholder until user stats are loaded
              <StatsPlaceholder rows={3} />
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">Your Posts</span>
                  <span className="font-medium">{formatNumber(stats.posts)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">Followers</span>
                  <span className="font-medium">{formatNumber(stats.followers)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">Following</span>
                  <span className="font-medium">{formatNumber(stats.following)}</span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
