'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { PostCard } from '@/components/post/post-card'
import { Post } from '@/lib/types'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { ComposeModal } from '@/components/compose/compose-modal'
import { useAppStore, useSettingsStore } from '@/lib/store'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import { LoadingState, useAsyncState } from '@/components/ui/loading-state'
import ErrorBoundary from '@/components/error-boundary'
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal'
import { getDashPlatformClient } from '@/lib/dash-platform-client'
import { cacheManager } from '@/lib/cache-manager'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { identifierToBase58 } from '@/lib/services/sdk-helpers'
import { Button } from '@/components/ui/button'
import type { MigrationStatus } from '@/lib/services/profile-migration-service'

/**
 * Helper to normalize byte arrays from SDK (may be base64 string, hex string, Uint8Array, or regular array)
 * Used for converting encryptedContent, nonce, and other byte fields to Uint8Array
 */
function normalizeBytes(value: unknown): Uint8Array | undefined {
  if (!value) return undefined
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return new Uint8Array(value)
  if (typeof value === 'string') {
    // Try base64 decode first
    try {
      const binary = atob(value)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes
    } catch {
      // Might be hex - validate even length for proper decoding
      if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
        const bytes = new Uint8Array(value.length / 2)
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(value.substr(i * 2, 2), 16)
        }
        return bytes
      }
      return undefined
    }
  }
  return undefined
}

function FeedPage() {
  const router = useRouter()
  const [isHydrated, setIsHydrated] = useState(false)
  const { setComposeOpen } = useAppStore()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const feedLanguage = useSettingsStore((s) => s.feedLanguage)
  const { user } = useAuth()
  const { open: openLoginPrompt } = useLoginPromptModal()
  const postsState = useAsyncState<any[]>(null)
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>('no_profile')
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [lastPostId, setLastPostId] = useState<string | null>(null)
  const [followingNextWindow, setFollowingNextWindow] = useState<{ start: Date; end: Date; windowHours: number } | null>(null)
  // State for auto-refresh: pending new posts and the timestamp of the newest displayed post
  const [pendingNewPosts, setPendingNewPosts] = useState<Post[]>([])
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
      // Don't load posts on Following tab if user is not logged in
      // (the login prompt is shown instead, and posts won't be displayed)
      if (activeTab === 'following' && !user?.identityId) {
        console.log('Feed: Skipping Following feed load - user not logged in')
        setLoading(false)
        return
      }

      console.log(`Feed: Loading ${activeTab} posts from Dash Platform...`, isPaginating ? '(paginating)' : '')

      const cacheKey = activeTab === 'following'
        ? `feed_following_${user?.identityId}`
        : `feed_for_you_${feedLanguage || 'all'}`

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
        posts = result.documents.map((post: any) => {
          const hasResolvedUsername = !!(post.author?.username && !post.author.username.startsWith('user_'))
          return {
            id: post.id,
            content: post.content || '',  // Empty for pure reposts - UI handles display
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
          quotedPostId: post.quotedPostId || undefined,
          // Private feed fields
          encryptedContent: post.encryptedContent ? normalizeBytes(post.encryptedContent) : undefined,
          epoch: post.epoch as number | undefined,
          nonce: post.nonce ? normalizeBytes(post.nonce) : undefined
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
        // NON-BLOCKING: Show first batch immediately, fetch more in background
        const MIN_NON_REPLY_POSTS = 20 // Target posts to show before requiring "Load More"
        const MAX_FETCH_ITERATIONS = 5 // Safety limit to prevent infinite loops
        const dashClient = getDashPlatformClient()

        const currentStartAfter = pagination?.startAfter

        // Helper to transform a raw document to our post format
        const transformRawPost = (doc: any) => {
          const data = doc.data || doc
          const authorIdStr = doc.$ownerId || doc.ownerId || 'unknown'

          // quotedPostId comes as base64 from SDK v3 toJSON()
          // Convert to base58 for consistent handling
          const rawQuotedPostId = data.quotedPostId || doc.quotedPostId
          const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) : undefined

          // Extract private feed fields if present
          const rawEncryptedContent = data.encryptedContent || doc.encryptedContent
          const epoch = (data.epoch ?? doc.epoch) as number | undefined
          const rawNonce = data.nonce || doc.nonce
          const encryptedContent = normalizeBytes(rawEncryptedContent)
          const nonce = normalizeBytes(rawNonce)

          return {
            id: doc.$id || doc.id || Math.random().toString(36).substr(2, 9),
            content: data.content || '',  // Empty for pure reposts - UI handles display
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
            quotedPostId: quotedPostId || undefined,
            // Private feed fields
            encryptedContent,
            epoch,
            nonce
          }
        }

        // Helper to enrich posts with reposts and quoted posts data
        const enrichPostsWithRepostsAndQuotes = async (postsToEnrich: any[]) => {
          // Fetch reposts for these posts
          try {
            const { repostService } = await import('@/lib/services/repost-service')
            const { unifiedProfileService } = await import('@/lib/services')

            const postIds = postsToEnrich.map((p: any) => p.id)
            if (postIds.length > 0) {
              const reposts = await repostService.getRepostsByPostIds(postIds)

              const repostMap = new Map<string, any>()
              for (const repost of reposts) {
                const existing = repostMap.get(repost.postId)
                if (!existing || repost.$createdAt > existing.$createdAt) {
                  repostMap.set(repost.postId, repost)
                }
              }

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

              for (const post of postsToEnrich) {
                const repost = repostMap.get(post.id)
                if (repost && repost.$ownerId !== post.author.id) {
                  const repostTimestamp = new Date(repost.$createdAt)
                  if (repostTimestamp > post.createdAt) {
                    const reposterProfile = reposterProfiles.get(repost.$ownerId)
                    post.repostedBy = {
                      id: repost.$ownerId,
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
          }

          // Fetch quoted posts
          try {
            const { postService } = await import('@/lib/services')
            const quotedPostIds = postsToEnrich
              .filter((p: any) => p.quotedPostId)
              .map((p: any) => p.quotedPostId)

            if (quotedPostIds.length > 0) {
              const quotedPosts = await postService.getPostsByIds(quotedPostIds)
              const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

              for (const post of postsToEnrich) {
                if (post.quotedPostId && quotedPostMap.has(post.quotedPostId)) {
                  post.quotedPost = quotedPostMap.get(post.quotedPostId)
                }
              }
            }
          } catch (quoteError) {
            console.error('Feed: Error fetching quoted posts:', quoteError)
          }

          return postsToEnrich
        }

        // FIRST FETCH: Get initial batch and display immediately
        console.log('Feed: Loading posts', currentStartAfter ? `starting after ${currentStartAfter}` : '', '(iteration 1)')
        const firstBatchRaw = await dashClient.queryPosts({
          limit: 20,
          forceRefresh,
          startAfter: currentStartAfter,
          language: feedLanguage
        })

        if (firstBatchRaw.length === 0) {
          console.log('Feed: No posts available')
          posts = []
          forYouNextCursor = null
          forYouHasMore = false
        } else {
          // Transform first batch
          const firstBatchPosts = firstBatchRaw.map(transformRawPost)
          const firstBatchCursor = firstBatchRaw[firstBatchRaw.length - 1].$id || firstBatchRaw[firstBatchRaw.length - 1].id

          console.log(`Feed: First batch has ${firstBatchPosts.length} posts`)

          // Set initial posts IMMEDIATELY (before any enrichment)
          posts = firstBatchPosts
          forYouNextCursor = firstBatchCursor
          forYouHasMore = firstBatchRaw.length === 20

          // Enrich first batch with reposts and quotes in background (non-blocking)
          enrichPostsWithRepostsAndQuotes(firstBatchPosts).then(() => {
            // Force a re-render to show repost/quote data
            setData((current: Post[] | null) => current ? [...current] : null)
          }).catch(err => {
            console.error('Feed: Error enriching first batch:', err)
          })

          // If we need more posts, fetch them in background (non-blocking)
          if (firstBatchPosts.length < MIN_NON_REPLY_POSTS && forYouHasMore) {
            console.log(`Feed: Only ${firstBatchPosts.length} posts, will fetch more in background... (need ${MIN_NON_REPLY_POSTS})`)

            // Start background fetch (don't await - let it run async)
            const fetchMoreInBackground = async () => {
              let bgCurrentStartAfter = firstBatchCursor
              let bgFetchIteration = 1 // Already did iteration 1
              let allPostCount = firstBatchPosts.length
              let bgLastBatchSize = firstBatchRaw.length

              while (allPostCount < MIN_NON_REPLY_POSTS && bgFetchIteration < MAX_FETCH_ITERATIONS && bgLastBatchSize === 20) {
                bgFetchIteration++
                console.log(`Feed: Loading posts starting after ${bgCurrentStartAfter} (iteration ${bgFetchIteration})`)

                const bgRawPosts = await dashClient.queryPosts({
                  limit: 20,
                  forceRefresh: false,
                  startAfter: bgCurrentStartAfter,
                  language: feedLanguage
                })

                bgLastBatchSize = bgRawPosts.length

                if (bgRawPosts.length === 0) {
                  console.log('Feed: No more posts available (background)')
                  setHasMore(false)
                  break
                }

                // Transform background batch (enrich in background, don't block)
                const bgPosts = bgRawPosts.map(transformRawPost)

                // Enrich in background (non-blocking)
                enrichPostsWithRepostsAndQuotes(bgPosts).then(() => {
                  // Force re-render to show repost/quote data
                  setData((current: Post[] | null) => current ? [...current] : null)
                }).catch(err => {
                  console.error('Feed: Error enriching background batch:', err)
                })
                allPostCount += bgPosts.length

                // Update cursor
                const lastPost = bgRawPosts[bgRawPosts.length - 1]
                bgCurrentStartAfter = lastPost.$id || lastPost.id

                // Append to existing posts (progressive update)
                setData((currentItems: Post[] | null) => {
                  if (!currentItems) return bgPosts
                  const existingIds = new Set(currentItems.map((item: Post) => item.id))
                  const newItems = bgPosts.filter((p: any) => !existingIds.has(p.id))

                  // Sort merged items by timestamp
                  const allItems = [...currentItems, ...newItems].sort((a: Post, b: Post) => {
                    const getTime = (item: Post): number => {
                      const post = item as any
                      if (post.repostTimestamp instanceof Date) return post.repostTimestamp.getTime()
                      if (post.createdAt instanceof Date) return post.createdAt.getTime()
                      return new Date(post.createdAt).getTime()
                    }
                    return getTime(b) - getTime(a)
                  })

                  console.log(`Feed: Background added ${newItems.length} posts (total: ${allItems.length})`)
                  return allItems
                })

                // Enrich new posts progressively
                enrichProgressively(bgPosts)

                // Update pagination cursor
                setLastPostId(bgCurrentStartAfter)

                if (allPostCount < MIN_NON_REPLY_POSTS && bgFetchIteration < MAX_FETCH_ITERATIONS) {
                  console.log(`Feed: Only ${allPostCount} posts, fetching more... (need ${MIN_NON_REPLY_POSTS})`)
                }
              }

              // Update has more based on final state
              setHasMore(bgLastBatchSize === 20)
              console.log(`Feed: Background fetch complete. Total posts: ${allPostCount}`)
            }

            // Fire and forget - don't block initial render
            fetchMoreInBackground().catch(err => {
              console.error('Feed: Background fetch error:', err)
            })
          }
        }

        // Note: Reposts and quoted posts are now enriched via enrichPostsWithRepostsAndQuotes helper
      }

      // Sort posts by timestamp
      // For posts with repostTimestamp, use that for sorting, otherwise use createdAt
      const sortedPosts = posts.sort((a: Post, b: Post) => {
        const getTime = (item: Post): number => {
          const post = item as any
          if (post.repostTimestamp instanceof Date) return post.repostTimestamp.getTime()
          if (post.createdAt instanceof Date) return post.createdAt.getTime()
          return new Date(post.createdAt).getTime()
        }
        return getTime(b) - getTime(a)
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
        // For pagination, use the cursor from the fetch loop (not the last sorted item)
        // This ensures we continue from the correct chronological position
        if (forYouNextCursor) {
          setLastPostId(forYouNextCursor)
        }
        // Has more based on whether the fetch loop found more data
        setHasMore(forYouHasMore)
      }

      // PROGRESSIVE LOADING: Show posts IMMEDIATELY with skeleton placeholders
      // Enrichment data (usernames, avatars, stats) will fill in progressively
      if (isPaginating) {
        setData((currentItems: Post[] | null) => {
          // Deduplicate - filter out items that already exist
          const existingIds = new Set((currentItems || []).map(item => item.id))
          const newItems = sortedPosts.filter(item => !existingIds.has(item.id))
          const allItems = [...(currentItems || []), ...newItems]
          console.log(`Feed: Appended ${newItems.length} new items (${sortedPosts.length - newItems.length} duplicates filtered)`)
          return allItems
        })
      } else {
        setData(sortedPosts)
        // Track the newest post timestamp for auto-refresh feature
        if (sortedPosts.length > 0) {
          const getItemTimestamp = (item: Post): number => {
            return item.createdAt instanceof Date
              ? item.createdAt.getTime()
              : new Date(item.createdAt).getTime()
          }
          const newestTimestamp = Math.max(...sortedPosts.map(getItemTimestamp))
          setNewestPostTimestamp(newestTimestamp)
          // Clear any pending new posts when doing a fresh load
          setPendingNewPosts([])
        }
      }

      // Start progressive enrichment (non-blocking)
      // This will update enrichmentState as data loads, triggering re-renders
      // Blocked users will be filtered via enrichmentState.blockStatus in render
      enrichProgressively(sortedPosts)

      // Cache the raw feed items (enrichment is progressive, not cached)
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
  }, [enrichProgressively, activeTab, user?.identityId, feedLanguage])

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
    if (!newestPostTimestamp || postsState.loading) return

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
          const rawQuotedPostId = data.quotedPostId || doc.quotedPostId
          const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) : undefined

          // Extract private feed fields if present
          const rawEncryptedContent = data.encryptedContent || doc.encryptedContent
          const epoch = (data.epoch ?? doc.epoch) as number | undefined
          const rawNonce = data.nonce || doc.nonce

          return {
            id: doc.$id || doc.id || Math.random().toString(36).substr(2, 9),
            content: data.content || '',  // Empty for pure reposts - UI handles display
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
            quotedPostId: quotedPostId || undefined,
            // Private feed fields
            encryptedContent: rawEncryptedContent ? normalizeBytes(rawEncryptedContent) : undefined,
            epoch,
            nonce: rawNonce ? normalizeBytes(rawNonce) : undefined
          }
        })

        // Sort by createdAt descending (newest first)
        transformedPosts.sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())

        // Deduplicate against existing posts and already pending posts
        const existingIds = new Set([
          ...(postsState.data || []).map((item: Post) => item.id),
          ...pendingNewPosts.map((item: Post) => item.id)
        ])

        const uniqueNewPosts = transformedPosts.filter((p: any) => !existingIds.has(p.id))

        if (uniqueNewPosts.length > 0) {
          console.log(`Feed: ${uniqueNewPosts.length} unique new posts to show`)
          setPendingNewPosts(prev => [...uniqueNewPosts, ...prev])
        }
      }
    } catch (error) {
      console.error('Feed: Error checking for new posts:', error)
    }
  }, [newestPostTimestamp, activeTab, user?.identityId, postsState.loading, postsState.data, pendingNewPosts])

  // Show pending new posts when user clicks the button
  const showNewPosts = useCallback(() => {
    if (pendingNewPosts.length === 0) return

    // Get the newest timestamp from pending posts
    const getItemTimestamp = (item: Post): number => {
      return item.createdAt instanceof Date
        ? item.createdAt.getTime()
        : new Date(item.createdAt).getTime()
    }

    const newestPendingTimestamp = Math.max(...pendingNewPosts.map(getItemTimestamp))

    // Prepend pending posts to current feed
    postsState.setData((currentItems: Post[] | null) => {
      const existing = currentItems || []
      return [...pendingNewPosts, ...existing]
    })

    // Start enrichment for the new posts
    enrichProgressively(pendingNewPosts)

    // Update the newest timestamp
    setNewestPostTimestamp(newestPendingTimestamp)

    // Clear pending posts
    setPendingNewPosts([])
  }, [pendingNewPosts, postsState, enrichProgressively])

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

  // Load posts on mount and when tab changes
  // This single effect handles both initial load and tab switches to avoid race conditions
  useEffect(() => {
    resetEnrichment()
    postsState.setData(null) // Clear current posts to show loading state
    setLastPostId(null)
    setFollowingNextWindow(null)
    setHasMore(true)
    // Clear auto-refresh state on tab switch
    setPendingNewPosts([])
    setNewestPostTimestamp(null)
    loadPosts().catch(err => console.error('Failed to load posts:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // Handle post deletion - removes post from local state
  const handlePostDelete = useCallback((postId: string) => {
    postsState.setData((prevData: Post[] | null) => {
      if (!prevData) return prevData
      return prevData.filter(item => item.id !== postId)
    })
  }, [postsState])

  // Filter posts to exclude blocked users using enrichment state
  // This replaces the previous async getBlockedUserIds() calls and avoids duplicate queries
  const filteredPosts = useMemo(() => {
    if (!postsState.data) return null

    return postsState.data.filter(post => {
      // Filter blocked users
      if (enrichmentState.blockStatus.size > 0 && enrichmentState.blockStatus.get(post.author.id)) {
        return false
      }
      return true
    })
  }, [postsState.data, enrichmentState.blockStatus, activeTab])

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
          <div className="px-4 py-3 flex items-center justify-between">
            <h1 className="text-xl font-bold">Home</h1>
            <button
              onClick={() => {
                resetEnrichment()
                loadPosts(true).catch(err => console.error('Failed to load posts:', err))
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
            loading={postsState.loading || postsState.data === null}
            error={postsState.error}
            isEmpty={!postsState.loading && postsState.data !== null && postsState.data.length === 0}
            onRetry={loadPosts}
            loadingText="Connecting to Dash Platform..."
            emptyText={activeTab === 'following' ? "Your following feed is empty" : "No posts yet"}
            emptyDescription={activeTab === 'following' ? "Follow some people to see their posts here!" : "Be the first to share something!"}
          >
            <div>
              {filteredPosts?.map((post) => (
                <ErrorBoundary key={post.id} level="component">
                  <PostCard
                    post={post}
                    isOwnPost={user?.identityId === post.author.id}
                    enrichment={getPostEnrichment(post)}
                    onDelete={handlePostDelete}
                  />
                </ErrorBoundary>
              ))}
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