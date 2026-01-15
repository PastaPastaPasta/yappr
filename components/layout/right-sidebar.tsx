'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { SearchInput } from '@/components/search/search-input'
import { formatNumber } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { postService, followService, likeService } from '@/lib/services'
import { cacheManager } from '@/lib/cache-manager'

interface UserStats {
  posts: number
  followers: number
  following: number
  likesGiven: number
}

interface GlobalStats {
  totalPosts: number
}

export function RightSidebar() {
  const { user } = useAuth()
  const [stats, setStats] = useState<UserStats | null>(null)
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [globalLoading, setGlobalLoading] = useState(false)

  useEffect(() => {
    if (!user?.identityId) {
      setStats(null)
      return
    }

    const fetchStats = async () => {
      // Check cache first to reduce network queries
      const cacheKey = `user_stats_${user.identityId}`
      const cached = cacheManager.get<UserStats>('sidebar', cacheKey)
      if (cached) {
        setStats(cached)
        return
      }

      setLoading(true)
      try {
        const [posts, followers, following, likes] = await Promise.all([
          postService.countUserPosts(user.identityId),
          followService.countFollowers(user.identityId),
          followService.countFollowing(user.identityId),
          likeService.countUserLikes(user.identityId)
        ])
        const newStats = { posts, followers, following, likesGiven: likes }
        setStats(newStats)
        // Cache for 2 minutes to reduce query frequency
        cacheManager.set('sidebar', cacheKey, newStats, { ttl: 120000 })
      } catch (error) {
        console.error('Error fetching user stats:', error)
        setStats({ posts: 0, followers: 0, following: 0, likesGiven: 0 })
      } finally {
        setLoading(false)
      }
    }

    void fetchStats()
  }, [user?.identityId])

  // Fetch global stats (independent of user login)
  useEffect(() => {
    const fetchGlobalStats = async () => {
      // Check cache first to reduce network queries
      const cacheKey = 'global_platform_stats'
      const cached = cacheManager.get<GlobalStats>('sidebar', cacheKey)
      if (cached) {
        setGlobalStats(cached)
        return
      }

      setGlobalLoading(true)
      try {
        const totalPosts = await postService.countAllPosts()
        const newGlobalStats = { totalPosts }
        setGlobalStats(newGlobalStats)
        // Cache for 5 minutes since global stats change slowly
        cacheManager.set('sidebar', cacheKey, newGlobalStats, { ttl: 300000 })
      } catch (error) {
        console.error('Error fetching global stats:', error)
        setGlobalStats({ totalPosts: 0 })
      } finally {
        setGlobalLoading(false)
      }
    }

    void fetchGlobalStats()
  }, [])

  return (
    <div className="hidden lg:block w-[350px] shrink-0 px-4 py-4 space-y-4 h-[calc(100vh-40px)] sticky top-[40px] overflow-y-auto scrollbar-hide">
      <SearchInput />
      <div className="bg-gray-50 dark:bg-gray-950 rounded-2xl overflow-hidden">
        <h2 className="text-xl font-bold px-4 py-3">Getting Started</h2>
        <div className="px-4 py-3 space-y-3 text-sm">
          <p className="text-gray-600 dark:text-gray-400">
            Welcome to Yappr! Here&apos;s what you can do:
          </p>
          <ul className="space-y-2">
            <li>
              <Link href={user?.identityId ? `/user?id=${user.identityId}&edit=true` : '/settings?section=account'} className="text-yappr-500 hover:text-yappr-600 dark:hover:text-yappr-400 hover:underline">
                • Create your profile
              </Link>
            </li>
            <li>
              <Link href="/feed" className="text-yappr-500 hover:text-yappr-600 dark:hover:text-yappr-400 hover:underline">
                • Share your first post
              </Link>
            </li>
            <li>
              <Link href="/explore" className="text-yappr-500 hover:text-yappr-600 dark:hover:text-yappr-400 hover:underline">
                • Explore and follow users
              </Link>
            </li>
          </ul>
        </div>
      </div>

      <div className="bg-gray-50 dark:bg-gray-950 rounded-2xl overflow-hidden">
        <h2 className="text-xl font-bold px-4 py-3 flex items-center gap-2">
          <ChartBarIcon className="h-5 w-5" />
          Stats
        </h2>
        <div className="px-4 py-3 space-y-2">
          {globalLoading ? (
            <div className="flex justify-between">
              <div className="h-4 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-4 w-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            </div>
          ) : globalStats ? (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">Total Posts</span>
              <span className="font-medium">{formatNumber(globalStats.totalPosts)}</span>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No stats available</p>
          )}
          {user && (
            <>
              {loading ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex justify-between">
                      <div className="h-4 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                      <div className="h-4 w-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : stats ? (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">Your Posts</span>
                    <span className="font-medium">{formatNumber(stats.posts)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">Followers</span>
                    <span className="font-medium">{formatNumber(stats.followers)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">Following</span>
                    <span className="font-medium">{formatNumber(stats.following)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">Likes Given</span>
                    <span className="font-medium">{formatNumber(stats.likesGiven)}</span>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="px-4 py-3 flex justify-center">
        <a
          href="https://github.com/dashpay/platform"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            src="/pbde-light.png"
            alt="Powered by Dash Evolution"
            width={140}
            height={47}
            className="dark:hidden"
            style={{ width: 'auto', height: 'auto' }}
          />
          <Image
            src="/pbde-dark.png"
            alt="Powered by Dash Evolution"
            width={140}
            height={47}
            className="hidden dark:block"
            style={{ width: 'auto', height: 'auto' }}
          />
        </a>
      </div>

      <div className="px-4 py-2 text-xs text-gray-500 space-x-2">
        <Link href="/terms" className="hover:underline">Terms</Link>
        <Link href="/privacy" className="hover:underline">Privacy</Link>
        <Link href="/cookies" className="hover:underline">Cookies</Link>
        <Link href="/about" className="hover:underline">About</Link>
      </div>
    </div>
  )
}