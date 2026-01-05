'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MagnifyingGlassIcon, ArrowLeftIcon, EllipsisHorizontalIcon, ArrowTrendingUpIcon, HashtagIcon, FireIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { formatNumber } from '@/lib/utils'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { getInitials } from '@/lib/utils'
import * as Tabs from '@radix-ui/react-tabs'
import { useAuth } from '@/contexts/auth-context'
import { useRouter } from 'next/navigation'
import { hashtagService, TrendingHashtag } from '@/lib/services/hashtag-service'
import { HASHTAG_CONTRACT_ID } from '@/lib/constants'

type TabType = 'trending' | 'news' | 'sports' | 'entertainment'

export default function ExplorePage() {
  const { user } = useAuth()
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchFocused, setIsSearchFocused] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('trending')
  const [searchHistory] = useState(['Web Development', 'React', 'TypeScript', 'Yappr'])
  const [posts, setPosts] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([])
  const [isLoadingTrends, setIsLoadingTrends] = useState(true)

  // Load trending posts (public data, no auth required)
  useEffect(() => {
    const loadTrendingPosts = async () => {
      try {
        setIsLoading(true)
        const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
        const dashClient = getDashPlatformClient()
        
        // Load recent posts (as trending)
        const fetchedPosts = await dashClient.queryPosts({ 
          limit: 20
        })
        
        // Transform posts
        const transformedPosts = fetchedPosts
          .filter((post: any) => post.$ownerId)
          .map((post: any) => ({
            id: post.$id,
            content: post.content,
            author: {
              id: post.$ownerId,
              username: post.$ownerId.slice(0, 8) + '...',
              handle: post.$ownerId.slice(0, 8).toLowerCase()
            },
            timestamp: new Date(post.$createdAt || 0).toISOString(),
            likes: 0,
            replies: 0,
            reposts: 0,
            views: 0
          }))
        
        setPosts(transformedPosts)
      } catch (error) {
        console.error('Failed to load posts:', error)
      } finally {
        setIsLoading(false)
      }
    }
    
    loadTrendingPosts()
  }, [])

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
          timeWindowHours: 48,
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

    loadTrendingHashtags()
  }, [])

  // Search posts when query changes
  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([])
      return
    }
    
    const searchPosts = async () => {
      try {
        const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
        const dashClient = getDashPlatformClient()
        
        // Simple content search - in production you'd want full-text search
        const allPosts = await dashClient.queryPosts({ limit: 100 })
        
        const filtered = allPosts
          .filter((post: any) =>
            post.$ownerId &&
            post.content?.toLowerCase().includes(searchQuery.toLowerCase())
          )
          .map((post: any) => ({
            id: post.$id,
            content: post.content,
            author: {
              id: post.$ownerId,
              username: post.$ownerId.slice(0, 8) + '...',
              handle: post.$ownerId.slice(0, 8).toLowerCase()
            },
            timestamp: new Date(post.$createdAt || 0).toISOString(),
            likes: 0,
            replies: 0,
            reposts: 0,
            views: 0
          }))
        
        setSearchResults(filtered)
      } catch (error) {
        console.error('Search failed:', error)
      }
    }
    
    const debounceTimer = setTimeout(searchPosts, 300)
    return () => clearTimeout(debounceTimer)
  }, [searchQuery])

  const displayPosts = searchQuery ? searchResults : posts
  
  // Use real trending data only - no mock fallback
  const displayTrends = trendingHashtags

  const handleHashtagClick = (hashtag: string) => {
    router.push(`/hashtag?tag=${encodeURIComponent(hashtag)}`)
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl">
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
                placeholder="Search"
                className="w-full h-12 pl-12 pr-4 bg-gray-100 dark:bg-gray-900 rounded-full focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:bg-transparent dark:focus:bg-transparent"
              />
            </div>
          </div>

          {!searchQuery && !isSearchFocused && (
            <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as TabType)}>
              <Tabs.List className="flex border-b border-gray-200 dark:border-gray-800 overflow-x-auto scrollbar-hide">
                <Tabs.Trigger
                  value="trending"
                  className="flex-1 py-4 px-6 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white whitespace-nowrap"
                >
                  Trending
                  {activeTab === 'trending' && (
                    <motion.div
                      layoutId="exploreTab"
                      className="absolute bottom-0 left-0 right-0 h-1 bg-yappr-500"
                    />
                  )}
                </Tabs.Trigger>
                <Tabs.Trigger
                  value="news"
                  className="flex-1 py-4 px-6 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white whitespace-nowrap"
                >
                  News
                  {activeTab === 'news' && (
                    <motion.div
                      layoutId="exploreTab"
                      className="absolute bottom-0 left-0 right-0 h-1 bg-yappr-500"
                    />
                  )}
                </Tabs.Trigger>
                <Tabs.Trigger
                  value="sports"
                  className="flex-1 py-4 px-6 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white whitespace-nowrap"
                >
                  Sports
                  {activeTab === 'sports' && (
                    <motion.div
                      layoutId="exploreTab"
                      className="absolute bottom-0 left-0 right-0 h-1 bg-yappr-500"
                    />
                  )}
                </Tabs.Trigger>
                <Tabs.Trigger
                  value="entertainment"
                  className="flex-1 py-4 px-6 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white whitespace-nowrap"
                >
                  Entertainment
                  {activeTab === 'entertainment' && (
                    <motion.div
                      layoutId="exploreTab"
                      className="absolute bottom-0 left-0 right-0 h-1 bg-yappr-500"
                    />
                  )}
                </Tabs.Trigger>
              </Tabs.List>
            </Tabs.Root>
          )}
        </header>

        <AnimatePresence mode="wait">
          {isSearchFocused && !searchQuery ? (
            <motion.div
              key="search-suggestions"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-4"
            >
              <h3 className="text-sm font-medium text-gray-500 mb-3">Recent searches</h3>
              <div className="space-y-1">
                {searchHistory.map((term, index) => (
                  <button
                    key={index}
                    onClick={() => setSearchQuery(term)}
                    className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-950 rounded-lg transition-colors"
                  >
                    <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                    <span>{term}</span>
                  </button>
                ))}
              </div>

              <h3 className="text-sm font-medium text-gray-500 mb-3 mt-6">Try searching for</h3>
              <div className="flex flex-wrap gap-2">
                {['People', 'Posts', 'Photos', 'Videos'].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setSearchQuery(suggestion.toLowerCase())}
                    className="px-4 py-2 bg-gray-100 dark:bg-gray-900 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : searchQuery ? (
            <motion.div
              key="search-results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <Tabs.Root defaultValue="top">
                <Tabs.List className="flex border-b border-gray-200 dark:border-gray-800">
                  <Tabs.Trigger
                    value="top"
                    className="flex-1 py-4 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white"
                  >
                    Top
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="latest"
                    className="flex-1 py-4 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white"
                  >
                    Latest
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="people"
                    className="flex-1 py-4 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white"
                  >
                    People
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="media"
                    className="flex-1 py-4 font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors relative data-[state=active]:text-gray-900 dark:data-[state=active]:text-white"
                  >
                    Media
                  </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="top">
                  {displayPosts.length > 0 ? (
                    displayPosts.map((post) => <PostCard key={post.id} post={post} />)
                  ) : (
                    <div className="p-8 text-center">
                      <p className="text-gray-500">No results for &quot;{searchQuery}&quot;</p>
                      <p className="text-sm text-gray-400 mt-1">Try searching for something else</p>
                    </div>
                  )}
                </Tabs.Content>

                <Tabs.Content value="people">
                  <div className="p-4">
                    <p className="text-center text-gray-500 py-8">
                      User search coming soon
                    </p>
                  </div>
                </Tabs.Content>
              </Tabs.Root>
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

              {/* Trending Topics */}
              <div className="divide-y divide-gray-200 dark:divide-gray-800">
                {isLoadingTrends ? (
                  <div className="p-8 text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
                    <p className="text-gray-500">Loading trending hashtags...</p>
                  </div>
                ) : displayTrends.length === 0 ? (
                  <div className="p-8 text-center">
                    <HashtagIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                    <p className="text-gray-500">No trending hashtags yet</p>
                    <p className="text-sm text-gray-400 mt-1">Post with #hashtags to see them here!</p>
                  </div>
                ) : (
                  displayTrends.map((trend, index) => (
                    <motion.div
                      key={trend.hashtag}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      onClick={() => handleHashtagClick(trend.hashtag)}
                      className="w-full p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors text-left cursor-pointer"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm text-gray-500">#{index + 1}</span>
                            <p className="font-bold text-lg text-yappr-500 hover:underline">#{trend.hashtag}</p>
                          </div>
                          <div className="flex items-center gap-4 text-sm text-gray-500">
                            <span>{formatNumber(trend.postCount)} {trend.postCount === 1 ? 'post' : 'posts'}</span>
                          </div>
                        </div>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-full transition-colors"
                        >
                          <EllipsisHorizontalIcon className="h-5 w-5 text-gray-500" />
                        </button>
                      </div>
                    </motion.div>
                  ))
                )}
              </div>

              {/* Featured Posts */}
              <div className="border-t border-gray-200 dark:border-gray-800 mt-4">
                <h3 className="text-lg font-bold p-4">Popular posts</h3>
                {isLoading ? (
                  <div className="p-8 text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
                    <p className="text-gray-500">Loading posts...</p>
                  </div>
                ) : (
                  posts.slice(0, 3).map((post) => (
                    <PostCard key={post.id} post={post} />
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

// Remove withAuth wrapper - explore is public