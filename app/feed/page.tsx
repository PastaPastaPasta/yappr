'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { PostCard } from '@/components/post/post-card'
import { FeedReplyContext } from '@/components/post/feed-reply-context'
import { FeedItem, isFeedReplyContext, getFeedItemTimestamp } from '@/lib/types'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { ComposeModal } from '@/components/compose/compose-modal'
import { useAppStore, useFeedStore } from '@/lib/store'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import { LoadingState } from '@/components/ui/loading-state'
import ErrorBoundary from '@/components/error-boundary'
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal'
import { getDashPlatformClient } from '@/lib/dash-platform-client'
import { cacheManager } from '@/lib/cache-manager'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { identifierToBase58 } from '@/lib/services/sdk-helpers'
import { Button } from '@/components/ui/button'
import type { MigrationStatus } from '@/lib/services/profile-migration-service'

function FeedPage() {
  const router = useRouter()
  const [isHydrated, setIsHydrated] = useState(false)
  const { setComposeOpen } = useAppStore()
  const { user } = useAuth()
  const { open: openLoginPrompt } = useLoginPromptModal()

  // Feed state from Zustand store - persists across navigation
  const feedStore = useFeedStore()
  const {
    forYouPosts,
    followingPosts,
    pagination,
    scrollPositions,
    followingUserId,
    setForYouPosts,
    setFollowingPosts,
    appendForYouPosts,
    appendFollowingPosts,
    setForYouPagination,
    setFollowingPagination,
    setScrollPosition,
    clearFeedState,
  } = feedStore

  // Local loading/error state (not persisted)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>('no_profile')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  // State for auto-refresh: pending new posts and the timestamp of the newest displayed post
  const [pendingNewPosts, setPendingNewPosts] = useState<FeedItem[]>([])
  const [newestPostTimestamp, setNewestPostTimestamp] = useState<number | null>(null)

  // Initialize tab from localStorage synchronously to avoid double-loading
  const [activeTab, setActiveTab] = useState<'forYou' | 'following'>(() => {
    // Only access localStorage on client side
    if (typeof window !== 'undefined') {
      const savedTab = localStorage.getItem('feed-tab')
      if (savedTab === 'forYou' || savedTab === 'following') {
        return savedTab
      }
    }
    return 'forYou'
  })

  // Get current posts based on active tab
  const currentPosts = activeTab === 'forYou' ? forYouPosts : followingPosts
  const hasMore = activeTab === 'forYou' ? pagination.forYou.hasMore : pagination.following.hasMore
  const lastPostId = pagination.forYou.lastPostId
  const followingNextWindow = pagination.following.nextWindow

  // Progressive enrichment - renders posts immediately, fills in data as it loads
  const { enrichProgressively, enrichmentState, reset: resetEnrichment, getPostEnrichment } = useProgressiveEnrichment({
    currentUserId: user?.identityId,
    skipFollowStatus: activeTab === 'following' // On Following tab, all authors are followed by definition
  })

  // Prevent hydration mismatches
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Check migration status on mount
  useEffect(() => {
    if (!user?.identityId) return

    const checkMigration = async () => {
      try {
        const { profileMigrationService } = await import('@/lib/services/profile-migration-service')
        const status = await profileMigrationService.getMigrationStatus(user.identityId)
        setMigrationStatus(status)
      } catch (error) {
        console.error('Failed to check migration status:', error)
      }
    }

    checkMigration().catch(err => console.error('Failed to check migration:', err))
  }, [user?.identityId])

  // Load posts function - using real WASM SDK with updated version
  const loadPosts = useCallback(async (
    forceRefresh: boolean = false,
    paginationArg?: { startAfter?: string; timeWindow?: { start: Date; end: Date; windowHours?: number } }
  ) => {
    const isPaginating = paginationArg?.startAfter || paginationArg?.timeWindow

    // Only show main loading state for initial load
    if (!isPaginating) {
      setIsLoading(true)
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
          if (activeTab === 'forYou') {
            setForYouPosts(cached)
            if (cached.length > 0) {
              setForYouPagination(cached[cached.length - 1].id, cached.length >= 20)
            }
          } else {
            setFollowingPosts(cached, user?.identityId || null)
            // Cursor can't be restored from cache; disable Load More since we have no cursor
            setFollowingPagination(null, false)
          }
          // Set newestPostTimestamp so auto-refresh interval works after back navigation
          if (cached.length > 0) {
            setNewestPostTimestamp(Math.max(...cached.map(getFeedItemTimestamp)))
            setPendingNewPosts([])
          }
          setIsLoading(false)
          // Enrich cached posts (needed after back navigation when enrichment state is reset)
          // Blocked users will be filtered via enrichmentState.blockStatus in render
          enrichProgressively(cached)
          return
        }
      }

      let posts: any[]

      let followingCursor: { start: Date; end: Date; windowHours: number } | null = null
      let forYouNextCursor: string | null = null // Track pagination cursor for For You feed
      let forYouHasMore = true // Track if there are more posts to fetch

      if (activeTab === 'following' && user?.identityId) {
        // Following feed - get posts from followed users using time-window pagination
        // Auto-retry on empty windows until we find posts or hit Jan 1, 2025
        const { postService } = await import('@/lib/services')
        const MIN_DATE = new Date('2025-01-01T00:00:00Z')

        let currentWindow = paginationArg?.timeWindow
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
        posts = result.documents.map((post: any) => {
          const hasResolvedUsername = !!(post.author?.username && !post.author.username.startsWith('user_'))
          return {
            id: post.id,
            content: post.content || 'No content',
            author: {
              id: post.author?.id || 'unknown',
              // Don't use fake username format - leave empty for display components to handle
              username: post.author?.username || '',
              handle: post.author?.username || '',
              // Use empty displayName - PostCard shows skeleton when hasDpns is undefined
              displayName: hasResolvedUsername ? (post.author?.displayName || '') : '',
              avatar: '',
              followers: 0,
              following: 0,
              verified: false,
              joinedAt: new Date(),
              // undefined = still loading, will show skeleton; true = has DPNS
              hasDpns: hasResolvedUsername ? true : undefined
            },
          createdAt: post.createdAt || new Date(),
          likes: post.likes || 0,
          replies: post.replies || 0,
          reposts: post.reposts || 0,
          views: post.views || 0,
          liked: post.liked || false,
          reposted: post.reposted || false,
          bookmarked: post.bookmarked || false,
          replyToId: post.replyToId || undefined,
          quotedPostId: post.quotedPostId || undefined
        }
        })

        // Fetch quoted posts for Following feed
        try {
          const { postService } = await import('@/lib/services')
          const quotedPostIds = posts
            .filter((p: any) => p.quotedPostId)
            .map((p: any) => p.quotedPostId)

          if (quotedPostIds.length > 0) {
            const quotedPosts = await postService.getPostsByIds(quotedPostIds)
            const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

            for (const post of posts) {
              if (post.quotedPostId && quotedPostMap.has(post.quotedPostId)) {
                post.quotedPost = quotedPostMap.get(post.quotedPostId)
              }
            }
          }
        } catch (quoteError) {
          console.error('Feed: Error fetching quoted posts for following feed:', quoteError)
        }

        // Fetch reposts from followed users and add to feed
        try {
          const { followService } = await import('@/lib/services')
          const { repostService } = await import('@/lib/services/repost-service')
          const { postService, unifiedProfileService } = await import('@/lib/services')

          // Get list of followed user IDs
          const followedUsers = await followService.getFollowing(user.identityId)
          const followedIds = followedUsers.map((f: any) => f.followedId || f.$id)

          if (followedIds.length > 0) {
            // Fetch recent reposts from each followed user
            const allReposts: any[] = []
            await Promise.all(followedIds.slice(0, 20).map(async (followedId: string) => {
              try {
                const userReposts = await repostService.getUserReposts(followedId)
                allReposts.push(...userReposts.map(r => ({ ...r, reposterId: followedId })))
              } catch (e) {
                // Ignore individual failures
              }
            }))

            if (allReposts.length > 0) {
              // Get unique post IDs and fetch original posts
              const existingPostIds = new Set(posts.map((p: any) => p.id))
              const repostPostIds = Array.from(new Set(allReposts.map(r => r.postId)))
                .filter(id => !existingPostIds.has(id)) // Don't duplicate posts already in feed

              if (repostPostIds.length > 0) {
                const repostedPosts = await postService.getPostsByIds(repostPostIds)
                const repostedPostMap = new Map(repostedPosts.map(p => [p.id, p]))

                // Fetch reposter profiles
                const reposterIds = Array.from(new Set(allReposts.map(r => r.reposterId)))
                const reposterProfiles = new Map<string, any>()
                await Promise.all(reposterIds.map(async (id) => {
                  try {
                    const profile = await unifiedProfileService.getProfileWithUsername(id)
                    if (profile) reposterProfiles.set(id, profile)
                  } catch (e) {}
                }))

                // Add reposted posts to feed
                for (const repost of allReposts) {
                  const originalPost = repostedPostMap.get(repost.postId)
                  if (originalPost && !existingPostIds.has(repost.postId)) {
                    existingPostIds.add(repost.postId) // Prevent duplicates from multiple reposters
                    const reposterProfile = reposterProfiles.get(repost.reposterId)
                    posts.push({
                      ...originalPost,
                      repostedBy: {
                        id: repost.reposterId,
                        // Empty string shows "Someone reposted" instead of "User XKSFJL reposted"
                        displayName: reposterProfile?.displayName || '',
                        username: reposterProfile?.username
                      },
                      repostTimestamp: new Date(repost.$createdAt)
                    })
                  }
                }
              }
            }
          }
        } catch (repostError) {
          console.error('Feed: Error fetching reposts for following feed:', repostError)
        }
      } else {
        // For You feed - get all posts and reposts
        // Auto-paginate to ensure we have enough non-reply posts after filtering
        const MIN_NON_REPLY_POSTS = 20 // Minimum posts to show before requiring "Load More"
        const MAX_FETCH_ITERATIONS = 5 // Safety limit to prevent infinite loops
        const dashClient = getDashPlatformClient()

        let allRawPosts: any[] = []
        let currentStartAfter = paginationArg?.startAfter
        let fetchIteration = 0
        let nonReplyCount = 0

        // Helper to transform a raw document to our post format
        const transformRawPost = (doc: any) => {
          const data = doc.data || doc
          const authorIdStr = doc.$ownerId || doc.ownerId || 'unknown'

          // replyToPostId comes as base64 from SDK v3 toJSON()
          // Convert to base58 for consistent handling
          const rawReplyToId = data.replyToPostId || doc.replyToPostId
          const replyToId = rawReplyToId ? identifierToBase58(rawReplyToId) : undefined

          // quotedPostId also comes as base64 from SDK v3 toJSON()
          const rawQuotedPostId = data.quotedPostId || doc.quotedPostId
          const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) : undefined

          return {
            id: doc.$id || doc.id || Math.random().toString(36).substr(2, 9),
            content: data.content || 'No content',
            author: {
              id: authorIdStr,
              // Don't use fake username format - leave empty for display components to handle
              username: '',
              handle: '',
              // Use empty string as displayName placeholder - PostCard shows skeleton when hasDpns is undefined
              displayName: '',
              avatar: '',
              followers: 0,
              following: 0,
              verified: false,
              joinedAt: new Date(),
              // undefined = still loading, will show skeleton in PostCard
              hasDpns: undefined
            },
            createdAt: new Date(doc.$createdAt || doc.createdAt || Date.now()),
            likes: 0,
            replies: 0,
            reposts: 0,
            views: 0,
            liked: false,
            reposted: false,
            bookmarked: false,
            replyToId: replyToId || undefined,
            quotedPostId: quotedPostId || undefined
          }
        }

        // Auto-paginate until we have enough non-reply posts or exhaust data
        let lastBatchSize = 0
        let exhaustedPosts = false

        do {
          const queryOptions: any = {
            limit: 20,
            forceRefresh: forceRefresh && fetchIteration === 0, // Only force refresh on first fetch
            startAfter: currentStartAfter
          }

          console.log('Feed: Loading posts', currentStartAfter ? `starting after ${currentStartAfter}` : '', `(iteration ${fetchIteration + 1})`)
          const rawPosts = await dashClient.queryPosts(queryOptions)
          lastBatchSize = rawPosts.length

          if (rawPosts.length === 0) {
            console.log('Feed: No more posts available')
            exhaustedPosts = true
            break
          }

          allRawPosts = [...allRawPosts, ...rawPosts]

          // Count non-reply posts so far
          nonReplyCount = allRawPosts.filter((doc: any) => {
            const data = doc.data || doc
            return !(data.replyToPostId || doc.replyToPostId)
          }).length

          // Update pagination cursor for next iteration
          const lastPost = rawPosts[rawPosts.length - 1]
          currentStartAfter = lastPost.$id || lastPost.id

          fetchIteration++

          // Continue if we don't have enough non-reply posts and haven't hit safety limit
          if (nonReplyCount < MIN_NON_REPLY_POSTS && fetchIteration < MAX_FETCH_ITERATIONS) {
            console.log(`Feed: Only ${nonReplyCount} non-reply posts, fetching more... (need ${MIN_NON_REPLY_POSTS})`)
          }
        } while (nonReplyCount < MIN_NON_REPLY_POSTS && fetchIteration < MAX_FETCH_ITERATIONS)

        console.log(`Feed: Fetched ${allRawPosts.length} total posts (${nonReplyCount} non-replies) in ${fetchIteration} iteration(s)`)

        // Store pagination state for For You feed
        forYouNextCursor = currentStartAfter || null
        // Has more if we didn't exhaust posts and the last batch was full
        forYouHasMore = !exhaustedPosts && lastBatchSize === 20

        // Transform all posts
        posts = allRawPosts.map(transformRawPost)

        // Fetch recent reposts and merge into timeline
        try {
          const { repostService } = await import('@/lib/services/repost-service')
          const { unifiedProfileService } = await import('@/lib/services')

          // Get recent reposts (we query all reposts without specific user filter for "For You")
          // This is a simplified approach - ideally we'd have a global reposts index
          // For now, we'll get reposts for the posts we already have
          const postIds = posts.map((p: any) => p.id)
          if (postIds.length > 0) {
            const reposts = await repostService.getRepostsByPostIds(postIds)

            // Group reposts by postId and get the most recent one for display
            const repostMap = new Map<string, any>()
            for (const repost of reposts) {
              const existing = repostMap.get(repost.postId)
              if (!existing || repost.$createdAt > existing.$createdAt) {
                repostMap.set(repost.postId, repost)
              }
            }

            // Get unique reposter IDs and fetch their profiles
            const reposterIds = Array.from(new Set(Array.from(repostMap.values()).map(r => r.$ownerId)))
            const reposterProfiles = new Map<string, any>()
            await Promise.all(reposterIds.map(async (id) => {
              try {
                const profile = await unifiedProfileService.getProfileWithUsername(id)
                if (profile) {
                  reposterProfiles.set(id, profile)
                }
              } catch (e) {
                // Ignore profile fetch errors
              }
            }))

            // Update posts with repost info for display
            for (const post of posts) {
              const repost = repostMap.get(post.id)
              if (repost && repost.$ownerId !== post.author.id) {
                // Create a reposted version of this post
                const repostTimestamp = new Date(repost.$createdAt)
                // Only show as reposted if it's newer than the original
                if (repostTimestamp > post.createdAt) {
                  const reposterProfile = reposterProfiles.get(repost.$ownerId)
                  post.repostedBy = {
                    id: repost.$ownerId,
                    // Empty string shows "Someone reposted" instead of "User XKSFJL reposted"
                    displayName: reposterProfile?.displayName || '',
                    username: reposterProfile?.username
                  }
                  post.repostTimestamp = repostTimestamp
                }
              }
            }
          }
        } catch (repostError) {
          console.error('Feed: Error fetching reposts:', repostError)
          // Continue without reposts - non-critical
        }

        // Fetch quoted posts and attach them to posts
        try {
          const { postService } = await import('@/lib/services')
          const quotedPostIds = posts
            .filter((p: any) => p.quotedPostId)
            .map((p: any) => p.quotedPostId)

          if (quotedPostIds.length > 0) {
            const quotedPosts = await postService.getPostsByIds(quotedPostIds)
            const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

            // Attach quoted posts to their parent posts
            for (const post of posts) {
              if (post.quotedPostId && quotedPostMap.has(post.quotedPostId)) {
                post.quotedPost = quotedPostMap.get(post.quotedPostId)
              }
            }
          }
        } catch (quoteError) {
          console.error('Feed: Error fetching quoted posts:', quoteError)
          // Continue without quoted posts - non-critical
        }
      }

      // For Following tab: Build reply context items for replies from followed users
      // Instead of showing replies directly, show the original post with context
      let feedItems: FeedItem[] = posts

      if (activeTab === 'following') {
        try {
          const { postService } = await import('@/lib/services')

          // Separate replies from non-reply posts
          const replies = posts.filter((p: any) => p.replyToId)
          const nonReplies = posts.filter((p: any) => !p.replyToId)

          if (replies.length > 0) {
            // Get unique parent post IDs
            const parentPostIds = Array.from(new Set(replies.map((r: any) => r.replyToId))) as string[]

            // Fetch parent posts
            const parentPosts = await postService.getPostsByIds(parentPostIds)
            const parentPostMap = new Map(parentPosts.map(p => [p.id, p]))

            // Build reply context items
            const replyContextItems: FeedItem[] = replies
              .filter((reply: any) => parentPostMap.has(reply.replyToId))
              .map((reply: any) => {
                const originalPost = parentPostMap.get(reply.replyToId)
                if (!originalPost) return null
                return {
                  type: 'reply_context' as const,
                  originalPost,
                  reply,
                  replier: {
                    id: reply.author.id,
                    username: reply.author.username,
                    displayName: reply.author.displayName
                  }
                }
              })
              .filter((item): item is NonNullable<typeof item> => item !== null)

            // Merge non-replies with reply contexts
            feedItems = [...nonReplies, ...replyContextItems]
            console.log(`Feed: Built ${replyContextItems.length} reply contexts from ${replies.length} replies`)
          }
        } catch (replyContextError) {
          console.error('Feed: Error building reply contexts:', replyContextError)
          // Fall back to filtering out replies
          feedItems = posts.filter((p: any) => !p.replyToId)
        }
      }

      // Sort feed items by timestamp
      // For reply contexts, use the reply's timestamp for sorting
      // For regular posts, use repostTimestamp if available, otherwise createdAt
      const sortedFeedItems = feedItems.sort((a: FeedItem, b: FeedItem) => {
        const getTime = (item: FeedItem): number => {
          if (isFeedReplyContext(item)) {
            // Use reply timestamp for sorting reply contexts
            return item.reply.createdAt instanceof Date
              ? item.reply.createdAt.getTime()
              : new Date(item.reply.createdAt).getTime()
          }
          // Regular post
          const post = item as any
          if (post.repostTimestamp instanceof Date) return post.repostTimestamp.getTime()
          if (post.createdAt instanceof Date) return post.createdAt.getTime()
          return new Date(post.createdAt).getTime()
        }
        return getTime(b) - getTime(a)
      })

      // Update pagination state based on feed type
      if (activeTab === 'following') {
        // Has more if service returned a cursor (can search further back)
        setFollowingPagination(followingCursor, followingCursor !== null)

        // For following feed: empty window doesn't mean done, just skip to next window
        if (sortedFeedItems.length === 0) {
          console.log('Feed: No posts in this time window, cursor points to next window')
          if (!isPaginating) {
            setFollowingPosts([], user?.identityId || null)
          }
          return
        }
      } else {
        // For You feed: empty means done
        // Filter to non-reply posts for determining if feed is empty
        const nonReplyFeedItems = sortedFeedItems.filter(item =>
          isFeedReplyContext(item) ? false : !(item as any).replyToId
        )
        if (nonReplyFeedItems.length === 0) {
          console.log('Feed: No non-reply posts found on platform')
          if (!isPaginating) {
            setForYouPosts([])
          }
          setForYouPagination(null, false)
          return
        }
        // For pagination, use the cursor from the fetch loop (not the last sorted item)
        // This ensures we continue from the correct chronological position
        // Has more based on whether the fetch loop found more data
        setForYouPagination(forYouNextCursor, forYouHasMore)
      }

      // PROGRESSIVE LOADING: Show posts IMMEDIATELY with skeleton placeholders
      // Enrichment data (usernames, avatars, stats) will fill in progressively
      if (isPaginating) {
        // Append to existing posts (deduplication handled by store)
        if (activeTab === 'forYou') {
          appendForYouPosts(sortedFeedItems)
        } else {
          appendFollowingPosts(sortedFeedItems)
        }
        console.log(`Feed: Appended ${sortedFeedItems.length} new items`)
      } else {
        if (activeTab === 'forYou') {
          setForYouPosts(sortedFeedItems)
        } else {
          setFollowingPosts(sortedFeedItems, user?.identityId || null)
        }
        // Track the newest post timestamp for auto-refresh feature
        if (sortedFeedItems.length > 0) {
          setNewestPostTimestamp(Math.max(...sortedFeedItems.map(getFeedItemTimestamp)))
          // Clear any pending new posts when doing a fresh load
          setPendingNewPosts([])
        }
      }

      // Start progressive enrichment (non-blocking)
      // This will update enrichmentState as data loads, triggering re-renders
      // Blocked users will be filtered via enrichmentState.blockStatus in render
      // Extract all posts from feed items for enrichment
      const postsToEnrich = sortedFeedItems.flatMap(item =>
        isFeedReplyContext(item) ? [item.originalPost, item.reply] : [item]
      )
      enrichProgressively(postsToEnrich)

      // Cache the raw feed items (enrichment is progressive, not cached)
      if (!isPaginating && sortedFeedItems.length > 0) {
        cacheManager.set('feed', cacheKey, sortedFeedItems)
      }

    } catch (error) {
      console.error('Feed: Failed to load posts from platform:', error)

      // Show specific error message but fall back gracefully
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.log('Feed: Falling back to empty state due to error:', errorMessage)

      // Set empty data instead of showing error to user
      if (activeTab === 'forYou') {
        setForYouPosts([])
      } else {
        setFollowingPosts([], user?.identityId || null)
      }

      // Only show error to user if it's a critical issue
      if (errorMessage.includes('Contract ID not configured') ||
          errorMessage.includes('Not logged in')) {
        setError(errorMessage)
      }
    } finally {
      setIsLoading(false)
    }
  }, [enrichProgressively, activeTab, user?.identityId, setForYouPosts, setFollowingPosts, appendForYouPosts, appendFollowingPosts, setForYouPagination, setFollowingPagination])

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

  // Check for new posts since the last displayed post
  const checkForNewPosts = useCallback(async () => {
    // Don't check if we don't have a timestamp reference yet or if we're loading
    if (!newestPostTimestamp || isLoading) return

    try {
      console.log('Feed: Checking for new posts since', new Date(newestPostTimestamp).toISOString())

      let newPosts: any[] = []

      if (activeTab === 'following' && user?.identityId) {
        // Following feed: Query posts from followed users with $createdAt > newestPostTimestamp
        const { followService } = await import('@/lib/services')
        const following = await followService.getFollowing(user.identityId)
        const followingIds = following.map((f: any) => f.followingId)

        if (followingIds.length > 0) {
          const { getEvoSdk } = await import('@/lib/services/evo-sdk-service')
          const { normalizeSDKResponse } = await import('@/lib/services/sdk-helpers')
          const sdk = await getEvoSdk()
          const { YAPPR_CONTRACT_ID } = await import('@/lib/constants')

          const response = await sdk.documents.query({
            dataContractId: YAPPR_CONTRACT_ID,
            documentTypeName: 'post',
            where: [
              ['$ownerId', 'in', followingIds],
              ['$createdAt', '>', newestPostTimestamp]
            ],
            orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
            limit: 50
          } as any)

          const documents = normalizeSDKResponse(response)
          newPosts = documents
        }
      } else {
        // For You feed: Query all posts with $createdAt > newestPostTimestamp
        const { getEvoSdk } = await import('@/lib/services/evo-sdk-service')
        const { normalizeSDKResponse } = await import('@/lib/services/sdk-helpers')
        const sdk = await getEvoSdk()
        const { YAPPR_CONTRACT_ID } = await import('@/lib/constants')

        const response = await sdk.documents.query({
          dataContractId: YAPPR_CONTRACT_ID,
          documentTypeName: 'post',
          where: [['$createdAt', '>', newestPostTimestamp]],
          orderBy: [['$createdAt', 'desc']],
          limit: 50
        } as any)

        const documents = normalizeSDKResponse(response)
        newPosts = documents
      }

      if (newPosts.length > 0) {
        console.log(`Feed: Found ${newPosts.length} new posts`)

        // Transform the documents to our UI format
        const { identifierToBase58 } = await import('@/lib/services/sdk-helpers')
        const transformedPosts = newPosts.map((doc: any) => {
          const data = doc.data || doc
          const authorIdStr = doc.$ownerId || doc.ownerId || 'unknown'
          const rawReplyToId = data.replyToPostId || doc.replyToPostId
          const replyToId = rawReplyToId ? identifierToBase58(rawReplyToId) : undefined
          const rawQuotedPostId = data.quotedPostId || doc.quotedPostId
          const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) : undefined

          return {
            id: doc.$id || doc.id || Math.random().toString(36).substr(2, 9),
            content: data.content || 'No content',
            author: {
              id: authorIdStr,
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
            createdAt: new Date(doc.$createdAt || doc.createdAt || Date.now()),
            likes: 0,
            replies: 0,
            reposts: 0,
            views: 0,
            liked: false,
            reposted: false,
            bookmarked: false,
            replyToId: replyToId || undefined,
            quotedPostId: quotedPostId || undefined
          }
        })

        // Filter out replies for For You tab
        const filteredNewPosts = activeTab === 'forYou'
          ? transformedPosts.filter((p: any) => !p.replyToId)
          : transformedPosts

        // Sort by createdAt descending (newest first)
        filteredNewPosts.sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())

        // Deduplicate against existing posts and already pending posts
        const existingIds = new Set([
          ...(currentPosts || []).map((item: FeedItem) =>
            isFeedReplyContext(item) ? item.reply.id : item.id
          ),
          ...pendingNewPosts.map(item =>
            isFeedReplyContext(item) ? item.reply.id : item.id
          )
        ])

        const uniqueNewPosts = filteredNewPosts.filter((p: any) => !existingIds.has(p.id))

        if (uniqueNewPosts.length > 0) {
          console.log(`Feed: ${uniqueNewPosts.length} unique new posts to show`)
          setPendingNewPosts(prev => [...uniqueNewPosts, ...prev])
        }
      }
    } catch (error) {
      console.error('Feed: Error checking for new posts:', error)
    }
  }, [newestPostTimestamp, activeTab, user?.identityId, isLoading, currentPosts, pendingNewPosts])

  // Show pending new posts when user clicks the button
  const showNewPosts = useCallback(() => {
    if (pendingNewPosts.length === 0) return

    // Get the newest timestamp from pending posts
    const newestPendingTimestamp = Math.max(...pendingNewPosts.map(getFeedItemTimestamp))

    // Prepend pending posts to current feed
    if (activeTab === 'forYou') {
      const existing = forYouPosts || []
      setForYouPosts([...pendingNewPosts, ...existing])
    } else {
      const existing = followingPosts || []
      setFollowingPosts([...pendingNewPosts, ...existing], user?.identityId || null)
    }

    // Start enrichment for the new posts
    const postsToEnrich = pendingNewPosts.flatMap(item =>
      isFeedReplyContext(item) ? [item.originalPost, item.reply] : [item]
    )
    enrichProgressively(postsToEnrich)

    // Update the newest timestamp
    setNewestPostTimestamp(newestPendingTimestamp)

    // Clear pending posts
    setPendingNewPosts([])
  }, [pendingNewPosts, activeTab, forYouPosts, followingPosts, setForYouPosts, setFollowingPosts, user?.identityId, enrichProgressively])

  // Periodically check for new posts (every 15 seconds)
  useEffect(() => {
    // Only start checking after initial posts are loaded
    if (!newestPostTimestamp) return

    const intervalId = setInterval(() => {
      checkForNewPosts().catch(err => console.error('Failed to check for new posts:', err))
    }, 15000) // 15 seconds

    return () => clearInterval(intervalId)
  }, [newestPostTimestamp, checkForNewPosts])

  // Listen for new posts created
  useEffect(() => {
    const handlePostCreated = () => {
      // Reset enrichment tracking so new data gets enriched
      resetEnrichment()
      loadPosts(true).catch(err => console.error('Failed to load posts:', err)) // Force refresh when new post is created
    }

    window.addEventListener('post-created', handlePostCreated)

    return () => {
      window.removeEventListener('post-created', handlePostCreated)
    }
  }, [loadPosts, resetEnrichment])

  // Track previous tab to detect tab switches vs initial mount/back navigation
  const previousTabRef = useRef<string | null>(null)
  const isInitialMountRef = useRef(true)
  // Track if we've enriched with the current user (to re-enrich when user becomes available)
  const lastEnrichmentUserIdRef = useRef<string | undefined>(undefined)

  // Load posts on mount and when tab changes
  // This effect distinguishes between:
  // 1. Initial mount / back navigation - restore from store if available
  // 2. Tab switch - clear and reload that tab's data
  // 3. User becomes available after initial mount - re-enrich with user context
  useEffect(() => {
    const wasTabSwitch = previousTabRef.current !== null && previousTabRef.current !== activeTab
    previousTabRef.current = activeTab

    // Check if we have existing data for this tab
    const existingPosts = activeTab === 'forYou' ? forYouPosts : followingPosts
    const isFollowingUserChanged = activeTab === 'following' && followingUserId !== user?.identityId

    // Check if user became available after we already enriched without user context
    const userBecameAvailable = user?.identityId && lastEnrichmentUserIdRef.current === undefined && !isInitialMountRef.current

    if (wasTabSwitch) {
      // Tab was switched - always load fresh data for the new tab
      // But don't clear the store - we keep cached data for each tab
      resetEnrichment()
      lastEnrichmentUserIdRef.current = undefined
      // Clear auto-refresh state on tab switch
      setPendingNewPosts([])
      setNewestPostTimestamp(null)

      // If we have cached data for this tab, use it; otherwise load fresh
      if (existingPosts && existingPosts.length > 0 && !isFollowingUserChanged) {
        // Re-enrich the existing posts (enrichment state was reset)
        const postsToEnrich = existingPosts.flatMap(item =>
          isFeedReplyContext(item) ? [item.originalPost, item.reply] : [item]
        )
        enrichProgressively(postsToEnrich)
        lastEnrichmentUserIdRef.current = user?.identityId
        // Restore scroll position
        const savedScrollPos = scrollPositions[activeTab]
        if (savedScrollPos > 0) {
          requestAnimationFrame(() => {
            window.scrollTo(0, savedScrollPos)
          })
        }
      } else {
        // No cached data or user changed, load fresh
        if (activeTab === 'forYou') {
          clearFeedState('forYou')
        } else {
          clearFeedState('following')
        }
        loadPosts().catch(err => console.error('Failed to load posts:', err))
      }
    } else if (isInitialMountRef.current) {
      // Initial mount or back navigation
      isInitialMountRef.current = false

      if (existingPosts && existingPosts.length > 0 && !isFollowingUserChanged) {
        // We have cached data - restore it
        console.log('Feed: Restoring cached posts from store')
        resetEnrichment()
        // Re-enrich the existing posts
        const postsToEnrich = existingPosts.flatMap(item =>
          isFeedReplyContext(item) ? [item.originalPost, item.reply] : [item]
        )
        enrichProgressively(postsToEnrich)
        lastEnrichmentUserIdRef.current = user?.identityId
        // Set newestPostTimestamp so auto-refresh interval works after back navigation
        setNewestPostTimestamp(Math.max(...existingPosts.map(getFeedItemTimestamp)))
        setPendingNewPosts([])
        // Restore scroll position after a short delay to let content render
        const savedScrollPos = scrollPositions[activeTab]
        if (savedScrollPos > 0) {
          requestAnimationFrame(() => {
            window.scrollTo(0, savedScrollPos)
          })
        }
      } else {
        // No cached data, load fresh
        resetEnrichment()
        loadPosts().catch(err => console.error('Failed to load posts:', err))
      }
    } else if (userBecameAvailable && existingPosts && existingPosts.length > 0) {
      // User became available after we already restored posts without user context
      // Re-enrich to get user-specific data (likes, interactions, etc.)
      console.log('Feed: Re-enriching posts now that user is available')
      resetEnrichment()
      const postsToEnrich = existingPosts.flatMap(item =>
        isFeedReplyContext(item) ? [item.originalPost, item.reply] : [item]
      )
      enrichProgressively(postsToEnrich)
      lastEnrichmentUserIdRef.current = user?.identityId
    }
  }, [activeTab, forYouPosts, followingPosts, followingUserId, user?.identityId, loadPosts, resetEnrichment, enrichProgressively, scrollPositions, clearFeedState])

  // Save scroll position before navigating away
  useEffect(() => {
    const handleScroll = () => {
      setScrollPosition(activeTab, window.scrollY)
    }

    // Throttle scroll events
    let ticking = false
    const throttledScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          handleScroll()
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', throttledScroll, { passive: true })
    return () => window.removeEventListener('scroll', throttledScroll)
  }, [activeTab, setScrollPosition])

  // Filter posts to exclude blocked users and replies (on For You tab) using enrichment state
  // This replaces the previous async getBlockedUserIds() calls and avoids duplicate queries
  const filteredPosts = useMemo(() => {
    if (!currentPosts) return null

    return currentPosts.filter(item => {
      // Handle FeedReplyContext items
      if (isFeedReplyContext(item)) {
        // Filter if either the original post author or replier is blocked
        if (enrichmentState.blockStatus.size > 0) {
          if (enrichmentState.blockStatus.get(item.originalPost.author.id)) return false
          if (enrichmentState.blockStatus.get(item.reply.author.id)) return false
        }
        return true
      }

      // Handle regular Post items
      const post = item
      // Filter blocked users
      if (enrichmentState.blockStatus.size > 0 && enrichmentState.blockStatus.get(post.author.id)) {
        return false
      }
      // Filter replies from For You tab (they have replyToId)
      if (activeTab === 'forYou' && post.replyToId) {
        return false
      }
      return true
    })
  }, [currentPosts, enrichmentState.blockStatus, activeTab])

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
                clearFeedState(activeTab)
                loadPosts(true).catch(err => console.error('Failed to load posts:', err))
              }}
              disabled={isLoading}
              className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            >
              <ArrowPathIcon className={`h-5 w-5 text-gray-500 ${isLoading ? 'animate-spin' : ''}`} />
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

        {/* Migration Banner */}
        {migrationStatus === 'needs_migration' && (
          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-full">
                  <ArrowPathIcon className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="font-medium text-blue-800 dark:text-blue-200">Migrate Your Profile</p>
                  <p className="text-sm text-blue-700 dark:text-blue-300">Your profile is not visible to others until you migrate.</p>
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => router.push('/profile/create')}
                className="bg-blue-500 hover:bg-blue-600"
              >
                Migrate
              </Button>
            </div>
          </div>
        )}

        {/* Login prompt for non-authenticated users on Following tab */}
        {activeTab === 'following' && !user ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              See posts from people you follow
            </h3>
            <p className="text-gray-500 dark:text-gray-400 text-center max-w-sm mb-6">
              Log in to view your personalized following feed and see updates from accounts you care about.
            </p>
            <Button
              onClick={() => openLoginPrompt('view_following')}
              className="px-6"
            >
              Log in
            </Button>
          </div>
        ) : (
        <ErrorBoundary level="component">
          {/* New posts notification button */}
          {pendingNewPosts.length > 0 && (
            <button
              onClick={showNewPosts}
              className="w-full py-3 text-center text-yappr-500 hover:bg-yappr-50 dark:hover:bg-yappr-900/20 font-medium transition-colors border-b border-gray-200 dark:border-gray-800"
            >
              Show {pendingNewPosts.length} new {pendingNewPosts.length === 1 ? 'post' : 'posts'}
            </button>
          )}
          <LoadingState
            loading={isLoading || currentPosts === null}
            error={error}
            isEmpty={!isLoading && currentPosts !== null && currentPosts.length === 0}
            onRetry={() => loadPosts(true)}
            loadingText="Connecting to Dash Platform..."
            emptyText={activeTab === 'following' ? "Your following feed is empty" : "No posts yet"}
            emptyDescription={activeTab === 'following' ? "Follow some people to see their posts here!" : "Be the first to share something!"}
          >
            <div>
              {filteredPosts?.map((item) => {
                // Get unique key for the item
                const key = isFeedReplyContext(item) ? `reply-ctx-${item.reply.id}` : item.id

                if (isFeedReplyContext(item)) {
                  return (
                    <ErrorBoundary key={key} level="component">
                      <FeedReplyContext
                        originalPost={item.originalPost}
                        reply={item.reply}
                        replier={item.replier}
                        replyEnrichment={getPostEnrichment(item.reply)}
                        originalPostEnrichment={getPostEnrichment(item.originalPost)}
                        isOwnPost={user?.identityId === item.reply.author.id}
                      />
                    </ErrorBoundary>
                  )
                }

                return (
                  <ErrorBoundary key={key} level="component">
                    <PostCard
                      post={item}
                      isOwnPost={user?.identityId === item.author.id}
                      enrichment={getPostEnrichment(item)}
                    />
                  </ErrorBoundary>
                )
              })}
              {hasMore && filteredPosts && filteredPosts.length > 0 && (
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
        )}
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  )
}

export default withAuth(FeedPage, { optional: true })