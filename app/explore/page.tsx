'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MagnifyingGlassIcon, ArrowLeftIcon, HashtagIcon, FireIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { Spinner } from '@/components/ui/spinner'
import { BlogPostCard } from '@/components/blog/blog-post-card'
import { formatNumber } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { hashtagService, TrendingHashtag } from '@/lib/services/hashtag-service'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { isCashtagStorage, cashtagStorageToDisplay } from '@/lib/post-helpers'
import type { Post, BlogPost } from '@/lib/types'

interface RawPostDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  content?: string
}

interface BlogPostWithAuthor extends BlogPost {
  authorUsername?: string
  authorDisplayName?: string
  blogName?: string
}

export default function ExplorePage() {
  const router = useRouter()
  const { user } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchFocused, setIsSearchFocused] = useState(false)
  const [searchResults, setSearchResults] = useState<Post[]>([])
  const [blogSearchResults, setBlogSearchResults] = useState<BlogPostWithAuthor[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([])
  const [isLoadingTrends, setIsLoadingTrends] = useState(true)
  const [recentBlogPosts, setRecentBlogPosts] = useState<BlogPostWithAuthor[]>([])
  const [isLoadingBlogs, setIsLoadingBlogs] = useState(true)

  // Load trending hashtags
  useEffect(() => {
    const loadTrendingHashtags = async () => {
      try {
        setIsLoadingTrends(true)
        const trending = await hashtagService.getTrendingHashtags({
          timeWindowHours: 168, // 1 week
          minPosts: 1,
          limit: 12
        })
        setTrendingHashtags(trending)
      } catch (error) {
        logger.error('Failed to load trending hashtags:', error)
      } finally {
        setIsLoadingTrends(false)
      }
    }

    loadTrendingHashtags().catch(err => logger.error('Failed to load trending hashtags:', err))
  }, [])

  // Load recent blog posts for discovery
  useEffect(() => {
    const loadRecentBlogPosts = async () => {
      try {
        setIsLoadingBlogs(true)
        const { blogService, blogPostService } = await import('@/lib/services')
        const { dpnsService } = await import('@/lib/services/dpns-service')
        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

        const allBlogs = await blogService.getAllBlogs()
        if (allBlogs.length === 0) {
          setRecentBlogPosts([])
          return
        }

        const blogMap = new Map(allBlogs.map(b => [b.id, b]))
        const blogIds = allBlogs.map(b => b.id)
        const recentPosts = await blogPostService.getRecentPosts(blogIds, 10)

        if (recentPosts.length === 0) {
          setRecentBlogPosts([])
          return
        }

        // Resolve author info in parallel
        const ownerIds = Array.from(new Set(recentPosts.map(p => p.ownerId)))
        const [usernameMap, profileMap] = await Promise.all([
          Promise.all(ownerIds.map(async id => {
            const name = await dpnsService.resolveUsername(id).catch(() => null)
            return [id, name] as const
          })).then(entries => new Map(entries)),
          Promise.all(ownerIds.map(async id => {
            const profile = await unifiedProfileService.getProfile(id).catch(() => null)
            return [id, profile] as const
          })).then(entries => new Map(entries)),
        ])

        const postsWithAuthors: BlogPostWithAuthor[] = recentPosts.map(post => ({
          ...post,
          authorUsername: usernameMap.get(post.ownerId) || undefined,
          authorDisplayName: profileMap.get(post.ownerId)?.displayName || undefined,
          blogName: blogMap.get(post.blogId)?.name || undefined,
        }))

        setRecentBlogPosts(postsWithAuthors)
      } catch (error) {
        logger.error('Failed to load recent blog posts:', error)
        setRecentBlogPosts([])
      } finally {
        setIsLoadingBlogs(false)
      }
    }

    loadRecentBlogPosts().catch(err => logger.error('Failed to load blog posts:', err))
  }, [])

  // Search posts and blog posts when query changes
  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([])
      setBlogSearchResults([])
      setIsSearching(false)
      return
    }

    const searchAll = async () => {
      try {
        setIsSearching(true)

        // Search regular posts
        const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
        const dashClient = getDashPlatformClient()

        const allPosts = await dashClient.queryPosts({ limit: 100 })

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
              username: '',
              handle: '',
              displayName: '',
              avatar: '',
              followers: 0,
              following: 0,
              verified: false,
              joinedAt: new Date(),
              hasDpns: undefined
            },
            createdAt: new Date(post.$createdAt || 0),
            likes: 0,
            replies: 0,
            reposts: 0,
            views: 0
          }))

        setSearchResults(filtered)

        // Search blog posts
        const { blogService, blogPostService } = await import('@/lib/services')
        const { dpnsService } = await import('@/lib/services/dpns-service')
        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

        const allBlogs = await blogService.getAllBlogs()
        if (allBlogs.length > 0) {
          const blogMap = new Map(allBlogs.map(b => [b.id, b]))
          const blogIds = allBlogs.map(b => b.id)
          const matchingBlogPosts = await blogPostService.searchPosts(blogIds, searchQuery, 10)

          if (matchingBlogPosts.length > 0) {
            const blogOwnerIds = Array.from(new Set(matchingBlogPosts.map(p => p.ownerId)))
            const [usernameEntries, profileEntries] = await Promise.all([
              Promise.all(blogOwnerIds.map(async id => {
                const name = await dpnsService.resolveUsername(id).catch(() => null)
                return [id, name] as const
              })),
              Promise.all(blogOwnerIds.map(async id => {
                const profile = await unifiedProfileService.getProfile(id).catch(() => null)
                return [id, profile] as const
              })),
            ])

            const usernameMap = new Map(usernameEntries)
            const profileMap = new Map(profileEntries)

            const blogResults: BlogPostWithAuthor[] = matchingBlogPosts.map(post => ({
              ...post,
              authorUsername: usernameMap.get(post.ownerId) || undefined,
              authorDisplayName: profileMap.get(post.ownerId)?.displayName || undefined,
              blogName: blogMap.get(post.blogId)?.name || undefined,
            }))

            setBlogSearchResults(blogResults)
          } else {
            setBlogSearchResults([])
          }
        } else {
          setBlogSearchResults([])
        }
      } catch (error) {
        logger.error('Search failed:', error)
        setSearchResults([])
        setBlogSearchResults([])
      } finally {
        setIsSearching(false)
      }
    }

    const debounceTimer = setTimeout(searchAll, 300)
    return () => clearTimeout(debounceTimer)
  }, [searchQuery, user?.identityId])

  const handleHashtagClick = (hashtag: string) => {
    router.push(`/hashtag?tag=${encodeURIComponent(hashtag)}`)
  }

  const handleBlogPostClick = (post: BlogPostWithAuthor) => {
    if (post.authorUsername && post.slug) {
      router.push(`/blog?user=${encodeURIComponent(post.authorUsername)}&blog=${encodeURIComponent(post.blogId)}&post=${encodeURIComponent(post.slug)}`)
    }
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
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
                  placeholder="Search posts and blog articles"
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
                    <Spinner size="md" className="mx-auto mb-4" />
                    <p className="text-gray-500">Searching...</p>
                  </div>
                ) : (searchResults.length > 0 || blogSearchResults.length > 0) ? (
                  <>
                    {/* Blog post search results */}
                    {blogSearchResults.length > 0 && (
                      <div>
                        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
                          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
                            <DocumentTextIcon className="h-4 w-4" />
                            Blog Posts ({blogSearchResults.length})
                          </h3>
                        </div>
                        {blogSearchResults.map((post) => (
                          <BlogPostCard
                            key={post.id}
                            post={post}
                            onClick={handleBlogPostClick}
                            className="border-b border-gray-200 dark:border-gray-800"
                          />
                        ))}
                      </div>
                    )}

                    {/* Regular post search results */}
                    {searchResults.length > 0 && (
                      <div>
                        {blogSearchResults.length > 0 && (
                          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
                            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400">
                              Posts ({searchResults.length})
                            </h3>
                          </div>
                        )}
                        {searchResults.map((post) => <PostCard key={post.id} post={post} />)}
                      </div>
                    )}
                  </>
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
                {/* Recent Blog Posts */}
                {!isLoadingBlogs && recentBlogPosts.length > 0 && (
                  <>
                    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                      <h2 className="text-lg font-semibold flex items-center gap-2">
                        <DocumentTextIcon className="h-5 w-5 text-yappr-500" />
                        Recent Blog Posts
                      </h2>
                      <p className="text-sm text-gray-500 mt-1">
                        Latest articles from the community
                      </p>
                    </div>
                    <div>
                      {recentBlogPosts.map((post, index) => (
                        <BlogPostCard
                          key={post.id}
                          post={post}
                          onClick={handleBlogPostClick}
                          index={index}
                          className="border-b border-gray-200 dark:border-gray-800"
                        />
                      ))}
                    </div>
                  </>
                )}

                {isLoadingBlogs && (
                  <div className="p-6 text-center border-b border-gray-200 dark:border-gray-800">
                    <Spinner size="sm" className="mx-auto mb-2" />
                    <p className="text-sm text-gray-500">Loading blog posts...</p>
                  </div>
                )}

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
                      <Spinner size="md" className="mx-auto mb-4" />
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
