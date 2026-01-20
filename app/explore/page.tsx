'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MagnifyingGlassIcon, ArrowLeftIcon, HashtagIcon, FireIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { formatNumber } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { hashtagService, TrendingHashtag } from '@/lib/services/hashtag-service'
import { HASHTAG_CONTRACT_ID } from '@/lib/constants'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { isCashtagStorage, cashtagStorageToDisplay } from '@/lib/post-helpers'
import type { Post } from '@/lib/types'

interface RawPostDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  content?: string
}

export default function ExplorePage() {
  const router = useRouter()
  const { user } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchFocused, setIsSearchFocused] = useState(false)
  const [searchResults, setSearchResults] = useState<Post[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([])
  const [isLoadingTrends, setIsLoadingTrends] = useState(true)

  // Load trending hashtags
  useEffect(() => {
    const loadTrendingHashtags = async () => {
      if (!HASHTAG_CONTRACT_ID) {
        console.log('Hashtag contract not deployed yet')
        setIsLoadingTrends(false)
        return
      }

      try {
        setIsLoadingTrends(true)
        const trending = await hashtagService.getTrendingHashtags({
          timeWindowHours: 168, // 1 week
          minPosts: 1,
          limit: 12
        })
        setTrendingHashtags(trending)
      } catch (error) {
        console.error('Failed to load trending hashtags:', error)
      } finally {
        setIsLoadingTrends(false)
      }
    }

    loadTrendingHashtags().catch(err => console.error('Failed to load trending hashtags:', err))
  }, [])

  // Search posts when query changes
  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    const searchPosts = async () => {
      try {
        setIsSearching(true)
        const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
        const dashClient = getDashPlatformClient()

        const allPosts = await dashClient.queryPosts({ limit: 100 })

        // Get unique author IDs and check block status
        const typedPosts = allPosts as RawPostDocument[]
        const authorIds = Array.from(new Set(typedPosts.map(p => p.$ownerId).filter(Boolean)))
        const blockedMap = user?.identityId
          ? await checkBlockedForAuthors(user.identityId, authorIds)
          : new Map<string, boolean>()

        const filtered = typedPosts
          .filter(post =>
            post.$ownerId &&
            post.content?.toLowerCase().includes(searchQuery.toLowerCase()) &&
            !blockedMap.get(post.$ownerId)
          )
          .map(post => ({
            id: post.$id,
            content: post.content || '',
            author: {
              id: post.$ownerId,
              // Leave empty for PostCard skeleton - will be enriched progressively
              username: '',
              handle: '',
              displayName: '',
              avatar: '',
              followers: 0,
              following: 0,
              verified: false,
              joinedAt: new Date(),
              // undefined = still loading, will show skeleton in PostCard
              hasDpns: undefined
            },
            createdAt: new Date(post.$createdAt || 0),
            likes: 0,
            replies: 0,
            reposts: 0,
            views: 0
          }))

        setSearchResults(filtered)
      } catch (error) {
        console.error('Search failed:', error)
      } finally {
        setIsSearching(false)
      }
    }

    const debounceTimer = setTimeout(searchPosts, 300)
    return () => clearTimeout(debounceTimer)
  }, [searchQuery, user?.identityId])

  const handleHashtagClick = (hashtag: string) => {
    router.push(`/hashtag?tag=${encodeURIComponent(hashtag)}`)
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center gap-4 p-4">
              {isSearchFocused && (
                <button
                  onClick={() => {
                    setIsSearchFocused(false)
                    setSearchQuery('')
                  }}
                  className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
              )}

              <div className="relative flex-1">
                <MagnifyingGlassIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  placeholder="Search posts"
                  className="w-full h-12 pl-12 pr-4 bg-gray-100 dark:bg-gray-900 rounded-full focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:bg-transparent dark:focus:bg-transparent"
                />
              </div>
            </div>
          </header>

          <AnimatePresence mode="wait">
            {searchQuery ? (
              <motion.div
                key="search-results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {isSearching ? (
                  <div className="p-8 text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
                    <p className="text-gray-500">Searching...</p>
                  </div>
                ) : searchResults.length > 0 ? (
                  searchResults.map((post) => <PostCard key={post.id} post={post} />)
                ) : (
                  <div className="p-8 text-center">
                    <p className="text-gray-500">No results for &quot;{searchQuery}&quot;</p>
                    <p className="text-sm text-gray-400 mt-1">Try searching for something else</p>
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="explore-content"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {/* Trending Header */}
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <FireIcon className="h-5 w-5 text-orange-500" />
                    Trending Hashtags
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">
                    Based on recent post activity
                  </p>
                </div>

                {/* Trending Hashtags */}
                <div className="divide-y divide-gray-200 dark:divide-gray-800">
                  {isLoadingTrends ? (
                    <div className="p-8 text-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
                      <p className="text-gray-500">Loading trending hashtags...</p>
                    </div>
                  ) : trendingHashtags.length === 0 ? (
                    <div className="p-8 text-center">
                      <HashtagIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-500">No trending tags yet</p>
                      <p className="text-sm text-gray-400 mt-1">Post with #hashtags or $cashtags to see them here!</p>
                    </div>
                  ) : (
                    trendingHashtags.map((trend, index) => {
                      const isCashtag = isCashtagStorage(trend.hashtag)
                      const displayTag = isCashtag ? cashtagStorageToDisplay(trend.hashtag) : trend.hashtag
                      const tagSymbol = isCashtag ? '$' : '#'

                      return (
                        <motion.div
                          key={trend.hashtag}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.05 }}
                          onClick={() => handleHashtagClick(trend.hashtag)}
                          className="w-full p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors text-left cursor-pointer"
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-sm text-gray-400 w-6">#{index + 1}</span>
                            <div className="flex-1">
                              <p className="font-bold text-yappr-500 hover:underline">{tagSymbol}{displayTag}</p>
                              <p className="text-sm text-gray-500">
                                {formatNumber(trend.postCount)} {trend.postCount === 1 ? 'post' : 'posts'}
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )
                    })
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  )
}
