'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { PostCard } from '@/components/post/post-card'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { ComposeModal } from '@/components/compose/compose-modal'
import { useAppStore } from '@/lib/store'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import { LoadingState, useAsyncState } from '@/components/ui/loading-state'
import ErrorBoundary from '@/components/error-boundary'
import { getDashPlatformClient } from '@/lib/dash-platform-client'
import { cacheManager } from '@/lib/cache-manager'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { identifierToBase58 } from '@/lib/services/sdk-helpers'
import { getBlockedUserIds } from '@/hooks/use-block'

function FeedPage() {
  const [isHydrated, setIsHydrated] = useState(false)
  const { setComposeOpen } = useAppStore()
  const { user } = useAuth()
  const postsState = useAsyncState<any[]>(null)
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [lastPostId, setLastPostId] = useState<string | null>(null)
  const [followingNextWindow, setFollowingNextWindow] = useState<{ start: Date; end: Date; windowHours: number } | null>(null)
  const [activeTab, setActiveTab] = useState<'forYou' | 'following'>('forYou')

  // Progressive enrichment - renders posts immediately, fills in data as it loads
  const { enrichProgressively, enrichmentState, reset: resetEnrichment, getPostEnrichment } = useProgressiveEnrichment({
    currentUserId: user?.identityId
  })

  // Prevent hydration mismatches and restore tab from localStorage
  useEffect(() => {
    setIsHydrated(true)
    const savedTab = localStorage.getItem('feed-tab')
    if (savedTab === 'forYou' || savedTab === 'following') {
      setActiveTab(savedTab)
    }
  }, [])

  // Load posts function - using real WASM SDK with updated version
  const loadPosts = useCallback(async (
    forceRefresh: boolean = false,
    pagination?: { startAfter?: string; timeWindow?: { start: Date; end: Date; windowHours?: number } }
  ) => {
    // Use the setter functions directly, not the whole postsState object
    const { setLoading, setError, setData } = postsState
    const isPaginating = pagination?.startAfter || pagination?.timeWindow

    // Only show main loading state for initial load
    if (!isPaginating) {
      setLoading(true)
    }
    setError(null)

    try {
      console.log(`Feed: Loading ${activeTab} posts from Dash Platform...`, isPaginating ? '(paginating)' : '')

      const cacheKey = activeTab === 'following'
        ? `feed_following_${user?.identityId}`
        : 'feed_for_you'

      // Check cache first unless force refresh or paginating
      if (!forceRefresh && !isPaginating) {
        const cached = cacheManager.get<any[]>('feed', cacheKey)
        if (cached) {
          console.log('Feed: Using cached data')
          setData(cached)
          setLoading(false)
          // Set lastPostId from cached data
          if (cached.length > 0) {
            setLastPostId(cached[cached.length - 1].id)
            setHasMore(cached.length >= 20)
          }
          // Enrich cached posts (needed after back navigation when enrichment state is reset)
          enrichProgressively(cached)
          return
        }
      }

      let posts: any[]

      let followingCursor: { start: Date; end: Date; windowHours: number } | null = null

      if (activeTab === 'following' && user?.identityId) {
        // Following feed - get posts from followed users using time-window pagination
        // Auto-retry on empty windows until we find posts or hit Jan 1, 2025
        const { postService } = await import('@/lib/services')
        const MIN_DATE = new Date('2025-01-01T00:00:00Z')

        let currentWindow = pagination?.timeWindow
        let result: Awaited<ReturnType<typeof postService.getFollowingFeed>>

        do {
          result = await postService.getFollowingFeed(user.identityId, {
            timeWindowStart: currentWindow?.start,
            timeWindowEnd: currentWindow?.end,
            windowHours: currentWindow?.windowHours
          })

          // Parse cursor for next iteration or final state
          followingCursor = null
          if (result.nextCursor) {
            try {
              const cursor = JSON.parse(result.nextCursor)
              followingCursor = {
                start: new Date(cursor.start),
                end: new Date(cursor.end),
                windowHours: cursor.windowHours || 24
              }
            } catch (e) {
              console.warn('Failed to parse following feed cursor:', e)
            }
          }

          // If empty result, prepare next window for retry
          if (result.documents.length === 0 && followingCursor) {
            // Check if we've gone back past Jan 1, 2025
            if (followingCursor.end < MIN_DATE) {
              console.log('Feed: Reached Jan 1 2025 limit, stopping search')
              followingCursor = null // No more to fetch
              break
            }
            console.log(`Feed: Empty window, auto-retrying from ${followingCursor.end.toISOString()}`)
            currentWindow = followingCursor
          }
        } while (result.documents.length === 0 && followingCursor)

        // Transform the Post objects to match our UI format
        posts = result.documents.map((post: any) => ({
          id: post.id,
          content: post.content || 'No content',
          author: {
            id: post.author?.id || 'unknown',
            username: post.author?.username || `user_${(post.author?.id || '').slice(-6)}`,
            handle: post.author?.username || `user_${(post.author?.id || '').slice(-6)}`,
            displayName: post.author?.displayName || `User ${(post.author?.id || '').slice(-6)}`,
            avatar: '',
            followers: 0,
            following: 0,
            verified: false,
            joinedAt: new Date()
          },
          createdAt: post.createdAt || new Date(),
          likes: post.likes || 0,
          replies: post.replies || 0,
          reposts: post.reposts || 0,
          views: post.views || 0,
          liked: post.liked || false,
          reposted: post.reposted || false,
          bookmarked: post.bookmarked || false,
          replyToId: post.replyToId || undefined
        }))
      } else {
        // For You feed - get all posts
        const dashClient = getDashPlatformClient()
        const queryOptions: any = {
          limit: 20,
          forceRefresh: forceRefresh,
          startAfter: pagination?.startAfter
        }

        console.log('Feed: Loading all posts', pagination?.startAfter ? `starting after ${pagination.startAfter}` : '')
        const rawPosts = await dashClient.queryPosts(queryOptions)

        // Transform posts to match our UI format
        // SDK v3 toJSON() returns system fields with $ prefix ($id, $ownerId, etc.)
        posts = rawPosts.map((doc: any) => {
          const data = doc.data || doc
          const authorIdStr = doc.$ownerId || doc.ownerId || 'unknown'

          // replyToPostId comes as base64 from SDK v3 toJSON()
          // Convert to base58 for consistent handling
          const rawReplyToId = data.replyToPostId || doc.replyToPostId
          const replyToId = rawReplyToId ? identifierToBase58(rawReplyToId) : undefined

          return {
            id: doc.$id || doc.id || Math.random().toString(36).substr(2, 9),
            content: data.content || 'No content',
            author: {
              id: authorIdStr,
              username: `user_${authorIdStr.slice(-6)}`,
              handle: `user_${authorIdStr.slice(-6)}`,
              displayName: `User ${authorIdStr.slice(-6)}`,
              avatar: '',
              followers: 0,
              following: 0,
              verified: false,
              joinedAt: new Date()
            },
            createdAt: new Date(doc.$createdAt || doc.createdAt || Date.now()),
            likes: 0,
            replies: 0,
            reposts: 0,
            views: 0,
            liked: false,
            reposted: false,
            bookmarked: false,
            replyToId: replyToId || undefined
          }
        })
      }

      // Sort posts by createdAt to ensure newest first
      let sortedPosts = posts.sort((a: any, b: any) => {
        const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt).getTime()
        const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt).getTime()
        return bTime - aTime
      })

      // Update pagination state based on feed type
      if (activeTab === 'following') {
        setFollowingNextWindow(followingCursor)
        // Has more if service returned a cursor (can search further back)
        setHasMore(followingCursor !== null)

        // For following feed: empty window doesn't mean done, just skip to next window
        if (sortedPosts.length === 0) {
          console.log('Feed: No posts in this time window, cursor points to next window')
          if (!isPaginating) {
            setData([])
          }
          return
        }
      } else {
        // For You feed: empty means done
        if (sortedPosts.length === 0) {
          console.log('Feed: No posts found on platform')
          if (!isPaginating) {
            setData([])
          }
          setHasMore(false)
          return
        }
        setLastPostId(sortedPosts[sortedPosts.length - 1].id)
        setHasMore(sortedPosts.length >= 20)
      }

      // PROGRESSIVE LOADING: Show posts IMMEDIATELY with skeleton placeholders
      // Enrichment data (usernames, avatars, stats) will fill in progressively
      if (isPaginating) {
        setData((currentPosts: any[] | null) => {
          // Deduplicate - filter out posts that already exist
          const existingIds = new Set((currentPosts || []).map(p => p.id))
          const newPosts = sortedPosts.filter(p => !existingIds.has(p.id))
          const allPosts = [...(currentPosts || []), ...newPosts]
          console.log(`Feed: Appended ${newPosts.length} new posts (${sortedPosts.length - newPosts.length} duplicates filtered)`)
          return allPosts
        })
      } else {
        setData(sortedPosts)
      }

      // Start progressive enrichment (non-blocking)
      // This will update enrichmentState as data loads, triggering re-renders
      enrichProgressively(sortedPosts)

      // Filter blocked users ASYNC - posts may briefly appear then disappear
      // This prioritizes fastest time-to-first-content
      if (user?.identityId) {
        getBlockedUserIds(user.identityId).then(blockedIds => {
          if (blockedIds.length > 0) {
            const blockedSet = new Set(blockedIds)
            setData((currentPosts: any[] | null) =>
              (currentPosts || []).filter((post: any) => !blockedSet.has(post.author.id))
            )
          }
        }).catch(err => console.error('Feed: Failed to filter blocked users:', err))
      }

      // Cache the raw posts (enrichment is progressive, not cached)
      if (!isPaginating && sortedPosts.length > 0) {
        cacheManager.set('feed', cacheKey, sortedPosts)
      }

    } catch (error) {
      console.error('Feed: Failed to load posts from platform:', error)

      // Show specific error message but fall back gracefully
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.log('Feed: Falling back to empty state due to error:', errorMessage)

      // Set empty data instead of showing error to user
      setData([])

      // Only show error to user if it's a critical issue
      if (errorMessage.includes('Contract ID not configured') ||
          errorMessage.includes('Not logged in')) {
        setError(errorMessage)
      }
    } finally {
      setLoading(false)
    }
  }, [postsState.setLoading, postsState.setError, postsState.setData, enrichProgressively, activeTab, user?.identityId])

  // Load more posts (pagination)
  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return

    // Check appropriate pagination state based on active tab
    if (activeTab === 'following') {
      if (!followingNextWindow) return
    } else {
      if (!lastPostId) return
    }

    setIsLoadingMore(true)
    try {
      if (activeTab === 'following' && followingNextWindow) {
        await loadPosts(false, { timeWindow: followingNextWindow })
      } else if (lastPostId) {
        await loadPosts(false, { startAfter: lastPostId })
      }
    } finally {
      setIsLoadingMore(false)
    }
  }, [activeTab, lastPostId, followingNextWindow, isLoadingMore, hasMore, loadPosts])

  // Listen for new posts created
  useEffect(() => {
    const handlePostCreated = () => {
      // Reset enrichment tracking so new data gets enriched
      resetEnrichment()
      loadPosts(true) // Force refresh when new post is created
    }

    window.addEventListener('post-created', handlePostCreated)

    return () => {
      window.removeEventListener('post-created', handlePostCreated)
    }
  }, [loadPosts, resetEnrichment])

  // Load posts on mount and when tab changes
  // This single effect handles both initial load and tab switches to avoid race conditions
  useEffect(() => {
    resetEnrichment()
    postsState.setData(null) // Clear current posts to show loading state
    setLastPostId(null)
    setFollowingNextWindow(null)
    setHasMore(true)
    loadPosts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl">
          <div className="px-4 py-3 flex items-center justify-between">
            <h1 className="text-xl font-bold">Home</h1>
            <button
              onClick={() => {
                resetEnrichment()
                loadPosts(true)
              }}
              disabled={postsState.loading}
              className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            >
              <ArrowPathIcon className={`h-5 w-5 text-gray-500 ${postsState.loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Feed Tabs */}
          <div className="flex border-b border-gray-200 dark:border-gray-800">
            <button
              onClick={() => {
                setActiveTab('forYou')
                localStorage.setItem('feed-tab', 'forYou')
              }}
              className={cn(
                'flex-1 py-4 text-center font-medium transition-colors relative',
                activeTab === 'forYou'
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              For You
              {activeTab === 'forYou' && (
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
              )}
            </button>
            <button
              onClick={() => {
                setActiveTab('following')
                localStorage.setItem('feed-tab', 'following')
              }}
              className={cn(
                'flex-1 py-4 text-center font-medium transition-colors relative',
                activeTab === 'following'
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              Following
              {activeTab === 'following' && (
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
              )}
            </button>
          </div>
        </header>

        <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-2 md:p-4">
          {user ? (
            <div className="flex gap-3">
              <div className="h-10 w-10 md:h-12 md:w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0">
                {isHydrated ? (
                  <UserAvatar userId={user.identityId} size="lg" alt="Your avatar" />
                ) : (
                  <div className="w-full h-full bg-gray-300 dark:bg-gray-700 animate-pulse rounded-full" />
                )}
              </div>
              <button
                onClick={() => setComposeOpen(true)}
                className="flex-1 text-left px-4 py-3 bg-gray-50 dark:bg-gray-950 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              >
                What&apos;s happening?
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center">
              <Link
                href="/login"
                className="text-yappr-500 hover:text-yappr-600 font-medium py-1"
              >
                Login to share your thoughts
              </Link>
            </div>
          )}
        </div>

        <ErrorBoundary level="component">
          <LoadingState
            loading={postsState.loading || postsState.data === null}
            error={postsState.error}
            isEmpty={!postsState.loading && postsState.data !== null && postsState.data.length === 0}
            onRetry={loadPosts}
            loadingText="Connecting to Dash Platform..."
            emptyText={activeTab === 'following' ? "Your following feed is empty" : "No posts yet"}
            emptyDescription={activeTab === 'following' ? "Follow some people to see their posts here!" : "Be the first to share something!"}
          >
            <div>
              {postsState.data?.map((post) => (
                <ErrorBoundary key={post.id} level="component">
                  <PostCard
                    post={post}
                    isOwnPost={user?.identityId === post.author.id}
                    enrichment={getPostEnrichment(post)}
                  />
                </ErrorBoundary>
              ))}
              {hasMore && postsState.data && postsState.data.length > 0 && (
                <div className="p-4 flex justify-center border-t border-gray-200 dark:border-gray-800">
                  <button
                    onClick={loadMore}
                    disabled={isLoadingMore}
                    className="px-6 py-2 rounded-full bg-yappr-500 text-white hover:bg-yappr-600 disabled:opacity-50 transition-colors"
                  >
                    {isLoadingMore ? 'Loading...' : 'Load More'}
                  </button>
                </div>
              )}
            </div>
          </LoadingState>
        </ErrorBoundary>
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  )
}

export default withAuth(FeedPage, { optional: true })