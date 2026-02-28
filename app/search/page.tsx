'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, Suspense, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, MagnifyingGlassIcon, HashtagIcon, UserIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { UserAvatar } from '@/components/ui/avatar-image'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@/lib/utils'
import { dpnsService } from '@/lib/services/dpns-service'
import { hashtagService } from '@/lib/services/hashtag-service'
import { unifiedProfileService } from '@/lib/services'
import { useSettingsStore } from '@/lib/store'
import type { BlogPost } from '@/lib/types'

interface UserResult {
  id: string
  username: string
  displayName: string
  bio?: string
}

interface HashtagResult {
  hashtag: string
  postCount: number
}

interface BlogPostResult extends BlogPost {
  authorUsername?: string
  authorDisplayName?: string
  blogName?: string
}

function SearchPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const query = searchParams.get('q') || ''
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [users, setUsers] = useState<UserResult[]>([])
  const [hashtags, setHashtags] = useState<HashtagResult[]>([])
  const [blogPosts, setBlogPosts] = useState<BlogPostResult[]>([])
  const [isLoading, setIsLoading] = useState(query.trim().length >= 3)
  const searchIdRef = useRef(0)

  useEffect(() => {
    const currentSearchId = ++searchIdRef.current
    logger.info(`Search: Starting search #${currentSearchId} for query: "${query}"`)

    const performSearch = async () => {
      const trimmedQuery = query.trim()

      if (!trimmedQuery) {
        setUsers([])
        setHashtags([])
        setBlogPosts([])
        setIsLoading(false)
        return
      }

      // Require at least 3 characters to search (like DashPay)
      if (trimmedQuery.length < 3) {
        logger.info('Search: Query too short, need at least 3 characters')
        setUsers([])
        setHashtags([])
        setBlogPosts([])
        setIsLoading(false)
        return
      }

      setIsLoading(true)

      try {
        // Search in parallel
        const [userResults, hashtagResults, blogResults] = await Promise.all([
          searchUsers(trimmedQuery),
          searchHashtags(trimmedQuery),
          searchBlogPosts(trimmedQuery),
        ])

        // Only update state if this is still the current search
        if (currentSearchId !== searchIdRef.current) {
          logger.info(`Search: Ignoring stale results for search #${currentSearchId}`)
          return
        }

        setUsers(userResults)
        setHashtags(hashtagResults)
        setBlogPosts(blogResults)
      } catch (error) {
        logger.error('Search failed:', error)
      } finally {
        if (currentSearchId === searchIdRef.current) {
          setIsLoading(false)
        }
      }
    }

    performSearch().catch(err => logger.error('Search failed:', err))
  }, [query])

  const searchUsers = async (searchQuery: string): Promise<UserResult[]> => {
    try {
      const trimmedQuery = searchQuery.trim()
      logger.info(`Search: searchUsers called with: "${trimmedQuery}"`)

      // Require at least 3 characters to search (like DashPay)
      if (trimmedQuery.length < 3) {
        logger.info('Search: Query too short, need at least 3 characters')
        return []
      }

      // Search DPNS usernames by prefix
      const dpnsResults = await dpnsService.searchUsernamesWithDetails(trimmedQuery, 10)
      logger.info(`Search: DPNS prefix search returned ${dpnsResults.length} results`)

      // If prefix search returns nothing, try exact name resolution as fallback
      if (dpnsResults.length === 0) {
        logger.info(`Search: Trying exact name resolution for "${trimmedQuery}"`)
        const exactIdentity = await dpnsService.resolveIdentity(trimmedQuery)
        if (exactIdentity) {
          logger.info(`Search: Found exact match for "${trimmedQuery}"`)
          dpnsResults.push({
            username: `${trimmedQuery.toLowerCase().replace(/\.dash$/, '')}.dash`,
            ownerId: exactIdentity
          })
        }
      }

      if (dpnsResults.length === 0) {
        return []
      }

      // Get unique owner IDs
      const ownerIds = Array.from(new Set(dpnsResults.map(r => r.ownerId).filter(Boolean)))

      // Fetch profiles for display names
      let profiles: any[] = []
      if (ownerIds.length > 0) {
        try {
          profiles = await unifiedProfileService.getProfilesByIdentityIds(ownerIds)
        } catch (error) {
          logger.error('Failed to fetch profiles:', error)
        }
      }

      // Create profile map
      const profileMap = new Map(profiles.map(p => [p.$ownerId || (p as any).ownerId, p]))

      // Group by owner to handle multiple usernames per owner
      const ownerToNames = new Map<string, string[]>()
      dpnsResults.forEach(result => {
        if (result.ownerId) {
          const names = ownerToNames.get(result.ownerId) || []
          names.push(result.username)
          ownerToNames.set(result.ownerId, names)
        }
      })

      // Build results
      const results: UserResult[] = await Promise.all(
        Array.from(ownerToNames.entries()).map(async ([ownerId, names]) => {
          const profile = profileMap.get(ownerId)
          const profileData = (profile as any)?.data || profile
          const sortedNames = await dpnsService.sortUsernamesByContested(names)
          const primaryUsername = sortedNames[0]

          return {
            id: ownerId,
            username: primaryUsername,
            displayName: profileData?.displayName || primaryUsername,
            bio: profileData?.bio
          }
        })
      )

      return results
    } catch (error) {
      logger.error('User search failed:', error)
      return []
    }
  }

  const searchHashtags = async (searchQuery: string): Promise<HashtagResult[]> => {
    try {
      const results: HashtagResult[] = []
      const normalizedQuery = searchQuery.replace(/^#/, '').toLowerCase()

      // Get trending hashtags and filter by query
      const trending = await hashtagService.getTrendingHashtags({
        timeWindowHours: 168, // 1 week
        minPosts: 1,
        limit: 50
      })

      // Filter trending hashtags that contain the query
      const matchingTrending = trending.filter(h =>
        h.hashtag.includes(normalizedQuery)
      )

      results.push(...matchingTrending)

      // Check if exact match exists but isn't in trending
      if (/^[a-z0-9_]{1,63}$/.test(normalizedQuery)) {
        const alreadyExists = results.some(h => h.hashtag === normalizedQuery)
        if (!alreadyExists) {
          // Check if hashtag has any posts and get real count
          const postCount = await hashtagService.getPostCountByHashtag(normalizedQuery)
          if (postCount > 0) {
            results.unshift({ hashtag: normalizedQuery, postCount })
          }
        }
      }

      return results
    } catch (error) {
      logger.error('Hashtag search failed:', error)
      return []
    }
  }

  const searchBlogPosts = async (searchQuery: string): Promise<BlogPostResult[]> => {
    try {
      const { blogService, blogPostService } = await import('@/lib/services')

      const allBlogs = await blogService.getAllBlogs()
      if (allBlogs.length === 0) return []

      const blogMap = new Map(allBlogs.map(b => [b.id, b]))
      const blogIds = allBlogs.map(b => b.id)
      const matchingPosts = await blogPostService.searchPosts(blogIds, searchQuery, 10)

      if (matchingPosts.length === 0) return []

      // Resolve author info
      const ownerIds = Array.from(new Set(matchingPosts.map(p => p.ownerId)))
      const [usernameEntries, profileEntries] = await Promise.all([
        Promise.all(ownerIds.map(async id => {
          const name = await dpnsService.resolveUsername(id).catch(() => null)
          return [id, name] as const
        })),
        Promise.all(ownerIds.map(async id => {
          const profile = await unifiedProfileService.getProfile(id).catch(() => null)
          return [id, profile] as const
        })),
      ])

      const usernameMap = new Map(usernameEntries)
      const profileMap = new Map(profileEntries)

      return matchingPosts.map(post => ({
        ...post,
        authorUsername: usernameMap.get(post.ownerId) || undefined,
        authorDisplayName: profileMap.get(post.ownerId)?.displayName || undefined,
        blogName: blogMap.get(post.blogId)?.name || undefined,
      }))
    } catch (error) {
      logger.error('Blog post search failed:', error)
      return []
    }
  }

  const handleUserClick = (userId: string) => {
    router.push(`/user?id=${userId}`)
  }

  const handleHashtagClick = (hashtag: string) => {
    router.push(`/hashtag?tag=${encodeURIComponent(hashtag)}`)
  }

  const handleBlogPostClick = (post: BlogPostResult) => {
    if (post.authorUsername && post.slug) {
      router.push(`/blog?user=${encodeURIComponent(post.authorUsername)}&post=${encodeURIComponent(post.slug)}`)
    }
  }

  if (!query) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
            <div className="p-12 text-center">
              <MagnifyingGlassIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">Search Yappr</h2>
              <p className="text-gray-500">
                Enter a search term to find users and hashtags
              </p>
            </div>
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          {/* Header */}
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center gap-4 p-4">
              <button
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-bold">Search</h1>
                <p className="text-sm text-gray-500">
                  Results for &quot;{query}&quot;
                </p>
              </div>
            </div>
          </header>

          {/* Content */}
          {isLoading ? (
            <div className="p-8 text-center">
              <Spinner size="md" className="mx-auto mb-4" />
              <p className="text-gray-500">Searching...</p>
            </div>
          ) : (
            <div>
              {/* Users Section */}
              <section>
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                  <h2 className="font-semibold flex items-center gap-2">
                    <UserIcon className="h-5 w-5" />
                    Users
                  </h2>
                </div>
                {users.length > 0 ? (
                  <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {users.map((user, index) => (
                      <motion.div
                        key={user.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        onClick={() => handleUserClick(user.id)}
                        className="flex items-center gap-3 p-4 hover:bg-gray-50 dark:hover:bg-gray-950 cursor-pointer transition-colors"
                      >
                        <div className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900">
                          <UserAvatar userId={user.id} size="lg" alt={user.displayName} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold truncate">{user.displayName}</h3>
                          <p className="text-sm text-gray-500 truncate">@{user.username}</p>
                          {user.bio && (
                            <p className="text-sm text-gray-600 dark:text-gray-400 truncate mt-1">{user.bio}</p>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center">
                    <p className="text-gray-500">No users found</p>
                  </div>
                )}
              </section>

              {/* Hashtags Section */}
              <section>
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                  <h2 className="font-semibold flex items-center gap-2">
                    <HashtagIcon className="h-5 w-5" />
                    Hashtags
                  </h2>
                </div>
                {hashtags.length > 0 ? (
                  <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {hashtags.map((tag, index) => (
                      <motion.div
                        key={tag.hashtag}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        onClick={() => handleHashtagClick(tag.hashtag)}
                        className="p-4 hover:bg-gray-50 dark:hover:bg-gray-950 cursor-pointer transition-colors"
                      >
                        <p className="font-bold text-yappr-500">#{tag.hashtag}</p>
                        <p className="text-sm text-gray-500">
                          {formatNumber(tag.postCount)} {tag.postCount === 1 ? 'post' : 'posts'}
                        </p>
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center">
                    <p className="text-gray-500">No hashtags found</p>
                  </div>
                )}
              </section>

              {/* Blog Posts Section */}
              <section>
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                  <h2 className="font-semibold flex items-center gap-2">
                    <DocumentTextIcon className="h-5 w-5" />
                    Blog Posts
                  </h2>
                </div>
                {blogPosts.length > 0 ? (
                  <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {blogPosts.map((post, index) => (
                      <motion.button
                        type="button"
                        key={post.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        onClick={() => handleBlogPostClick(post)}
                        disabled={!post.authorUsername || !post.slug}
                        className={`w-full p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors text-left ${post.authorUsername && post.slug ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
                      >
                        <div className="flex gap-3">
                          {post.coverImage && (
                            <IpfsImage
                              src={post.coverImage}
                              alt={post.title}
                              className="h-16 w-16 rounded-lg object-cover flex-shrink-0"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-gray-900 dark:text-gray-100 line-clamp-1">
                              {post.title || 'Untitled'}
                            </p>
                            {post.subtitle && (
                              <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-1 mt-0.5">
                                {post.subtitle}
                              </p>
                            )}
                            <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                              {post.blogName && <span className="font-medium">{post.blogName}</span>}
                              {post.blogName && post.authorDisplayName && <span>·</span>}
                              {post.authorDisplayName && <span>{post.authorDisplayName}</span>}
                              {(post.blogName || post.authorDisplayName) && <span>·</span>}
                              <span>{post.createdAt.toLocaleDateString()}</span>
                            </div>
                            {post.labels && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {post.labels.split(',').slice(0, 3).map((label) => (
                                  <span
                                    key={label.trim()}
                                    className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-yappr-100 dark:bg-yappr-900/30 text-yappr-700 dark:text-yappr-300 rounded"
                                  >
                                    {label.trim()}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.button>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center">
                    <p className="text-gray-500">No blog posts found</p>
                  </div>
                )}
              </section>
            </div>
          )}
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100vh-40px)] flex items-center justify-center">
        <Spinner size="md" />
      </div>
    }>
      <SearchPageContent />
    </Suspense>
  )
}
