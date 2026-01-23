import { useState, useCallback, useRef, useEffect } from 'react'
import { Post, User } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { blockService } from '@/lib/services/block-service'
import { followService } from '@/lib/services/follow-service'
import { seedBlockStatusCache, seedFollowStatusCache } from '@/lib/caches/user-status-cache'

export interface PostStats {
  likes: number
  reposts: number
  replies: number
  views: number
}

export interface UserInteractions {
  liked: boolean
  reposted: boolean
  bookmarked: boolean
}

export interface ProfileData {
  displayName?: string
  bio?: string
}

export interface ReplyToData {
  id: string
  authorId: string
  authorUsername: string | null  // null = no DPNS
}

export interface EnrichmentState {
  // Author data keyed by authorId
  usernames: Map<string, string | null>     // authorId → DPNS username (null = no DPNS)
  profiles: Map<string, ProfileData>        // authorId → profile data
  avatars: Map<string, string>              // authorId → avatar URL
  blockStatus: Map<string, boolean>         // authorId → isBlocked
  followStatus: Map<string, boolean>        // authorId → isFollowing
  // Post data keyed by postId
  stats: Map<string, PostStats>             // postId → stats
  interactions: Map<string, UserInteractions> // postId → user interactions
  replyTo: Map<string, ReplyToData>         // postId → parent post data (for replies)
  // Loading phase
  phase: 'idle' | 'loading' | 'complete'
}

function createEmptyEnrichmentState(): EnrichmentState {
  return {
    usernames: new Map(),
    profiles: new Map(),
    avatars: new Map(),
    blockStatus: new Map(),
    followStatus: new Map(),
    stats: new Map(),
    interactions: new Map(),
    replyTo: new Map(),
    phase: 'idle'
  }
}

interface UseProgressiveEnrichmentOptions {
  currentUserId?: string
  /** Skip follow status query (e.g., on Following tab where all authors are followed) */
  skipFollowStatus?: boolean
}

interface UseProgressiveEnrichmentResult {
  enrichProgressively: (posts: Post[]) => void
  enrichmentState: EnrichmentState
  reset: () => void
  getPostEnrichment: (post: Post) => {
    username: string | null | undefined  // undefined = loading, null = no DPNS, string = username
    displayName: string | undefined
    avatarUrl: string | undefined
    stats: PostStats | undefined
    interactions: UserInteractions | undefined
    isBlocked: boolean | undefined
    isFollowing: boolean | undefined
    replyTo: ReplyToData | undefined
  }
}

/**
 * Progressive enrichment hook for feed posts.
 *
 * Instead of waiting for all enrichment data before rendering,
 * this hook allows posts to be rendered immediately and fills in
 * enrichment data progressively as it loads.
 *
 * Priority order (by visual importance):
 * 1. DPNS usernames + Profiles (author identity)
 * 2. Avatars (visual)
 * 3. Stats (engagement counts)
 * 4. Interactions (user's like/repost state)
 * 5. Block/Follow status (action states)
 */
export function useProgressiveEnrichment(
  options: UseProgressiveEnrichmentOptions = {}
): UseProgressiveEnrichmentResult {
  const { currentUserId, skipFollowStatus = false } = options

  const [enrichmentState, setEnrichmentState] = useState<EnrichmentState>(createEmptyEnrichmentState)

  // Track the current enrichment request to handle cancellation on tab switch
  const enrichmentIdRef = useRef(0)

  const reset = useCallback(() => {
    enrichmentIdRef.current++
    setEnrichmentState(createEmptyEnrichmentState())
  }, [])

  /**
   * Start progressive enrichment for the given posts.
   * Non-blocking - returns immediately and updates state as data loads.
   */
  const enrichProgressively = useCallback((posts: Post[]) => {
    if (posts.length === 0) return

    // Increment request ID to invalidate any in-flight requests
    const requestId = ++enrichmentIdRef.current

    // Check if this request is still valid
    const isValid = () => enrichmentIdRef.current === requestId

    // Extract IDs (deduplicate to prevent "duplicate values for In query" errors)
    const postIds = Array.from(new Set(posts.map(p => p.id).filter(Boolean)))
    const authorIds = Array.from(new Set(posts.map(p => p.author.id).filter(Boolean)))

    // Collect parent post IDs for replies
    const postsWithReplyTo = posts.filter(p => p.replyToId)
    const parentPostIds = Array.from(new Set(postsWithReplyTo.map(p => p.replyToId).filter((id): id is string => !!id)))

    // Set loading phase
    setEnrichmentState(prev => ({ ...prev, phase: 'loading' }))

    // Helper to merge Maps (TypeScript-compatible without downlevelIteration)
    const mergeMaps = <K, V>(prev: Map<K, V>, next: Map<K, V>): Map<K, V> => {
      const merged = new Map(prev)
      next.forEach((value, key) => merged.set(key, value))
      return merged
    }

    // Store promises so we can reuse them for completion tracking
    // This prevents duplicate queries that were happening before

    // Priority 1: DPNS usernames (most visible - author identity)
    const usernamePromise = dpnsService.resolveUsernamesBatch(authorIds)
    usernamePromise.then(usernames => {
      if (!isValid()) return
      setEnrichmentState(prev => ({
        ...prev,
        usernames: mergeMaps(prev.usernames, usernames)
      }))
    }).catch(err => console.error('Progressive enrichment: usernames failed', err))

    // Priority 1: Profiles (display names)
    const profilePromise = unifiedProfileService.getProfilesByIdentityIds(authorIds)
    profilePromise.then(profiles => {
      if (!isValid()) return
      const profileMap = new Map<string, ProfileData>()
      for (const profile of profiles) {
        const ownerId = profile.$ownerId
        // Profile data may be nested under 'data' property or at root level
        const profileAny = profile as any
        const data = profileAny.data || profile
        if (ownerId) {
          profileMap.set(ownerId, {
            displayName: data.displayName,
            bio: data.bio
          })
        }
      }
      setEnrichmentState(prev => ({
        ...prev,
        profiles: mergeMaps(prev.profiles, profileMap)
      }))
    }).catch(err => console.error('Progressive enrichment: profiles failed', err))

    // Priority 2: Avatars
    const avatarPromise = unifiedProfileService.getAvatarUrlsBatch(authorIds)
    avatarPromise.then(avatars => {
      if (!isValid()) return
      setEnrichmentState(prev => ({
        ...prev,
        avatars: mergeMaps(prev.avatars, avatars)
      }))
    }).catch(err => console.error('Progressive enrichment: avatars failed', err))

    // Priority 3: Stats
    const statsPromise = postService.getBatchPostStats(postIds)
    statsPromise.then(stats => {
      if (!isValid()) return
      setEnrichmentState(prev => ({
        ...prev,
        stats: mergeMaps(prev.stats, stats)
      }))
    }).catch(err => console.error('Progressive enrichment: stats failed', err))

    // Priority 4: User interactions (only if logged in)
    const interactionsPromise = currentUserId
      ? postService.getBatchUserInteractions(postIds)
      : Promise.resolve(new Map<string, UserInteractions>())

    if (currentUserId) {
      interactionsPromise.then(interactions => {
        if (!isValid()) return
        setEnrichmentState(prev => ({
          ...prev,
          interactions: mergeMaps(prev.interactions, interactions)
        }))
      }).catch(err => console.error('Progressive enrichment: interactions failed', err))

      // Priority 5: Block status (always query for filtering)
      const blockPromise = blockService.checkBlockedBatch(currentUserId, authorIds)
      blockPromise.then(blockStatus => {
        if (!isValid()) return
        seedBlockStatusCache(currentUserId, blockStatus)
        setEnrichmentState(prev => ({
          ...prev,
          blockStatus: mergeMaps(prev.blockStatus, blockStatus)
        }))
      }).catch(err => console.error('Progressive enrichment: block status failed', err))

      // Priority 5: Follow status (skip if on Following tab - all authors are followed by definition)
      if (!skipFollowStatus) {
        const followPromise = followService.getFollowStatusBatch(authorIds, currentUserId)
        followPromise.then(followStatus => {
          if (!isValid()) return
          seedFollowStatusCache(currentUserId, followStatus)
          setEnrichmentState(prev => ({
            ...prev,
            followStatus: mergeMaps(prev.followStatus, followStatus)
          }))
        }).catch(err => console.error('Progressive enrichment: follow status failed', err))
      } else {
        // On Following tab, mark all authors as followed
        const followStatus = new Map<string, boolean>()
        authorIds.forEach(id => followStatus.set(id, true))
        seedFollowStatusCache(currentUserId, followStatus)
        setEnrichmentState(prev => ({
          ...prev,
          followStatus: mergeMaps(prev.followStatus, followStatus)
        }))
      }
    }

    // Priority 6: ReplyTo data (for replies and tips)
    if (parentPostIds.length > 0) {
      postService.getParentPostOwners(parentPostIds).then(async (parentOwnerMap) => {
        if (!isValid()) return

        // Get unique parent owner IDs and resolve their usernames
        const parentOwnerIds = Array.from(new Set(parentOwnerMap.values()))
        const parentUsernameMap = parentOwnerIds.length > 0
          ? await dpnsService.resolveUsernamesBatch(parentOwnerIds)
          : new Map<string, string | null>()

        // Build replyTo map for each post
        const replyToMap = new Map<string, ReplyToData>()
        for (const post of postsWithReplyTo) {
          if (post.replyToId) {
            const parentOwnerId = parentOwnerMap.get(post.replyToId)
            if (parentOwnerId) {
              const parentUsername = parentUsernameMap.get(parentOwnerId) ?? null
              replyToMap.set(post.id, {
                id: post.replyToId,
                authorId: parentOwnerId,
                authorUsername: parentUsername
              })
            }
          }
        }

        setEnrichmentState(prev => ({
          ...prev,
          replyTo: mergeMaps(prev.replyTo, replyToMap)
        }))
      }).catch(err => console.error('Progressive enrichment: replyTo failed', err))
    }

    // Track completion using the SAME promises (no duplicate queries!)
    Promise.all([
      usernamePromise,
      profilePromise,
      avatarPromise,
      statsPromise,
      interactionsPromise
    ]).finally(() => {
      if (!isValid()) return
      setEnrichmentState(prev => ({ ...prev, phase: 'complete' }))
    })

  }, [currentUserId, skipFollowStatus])

  /**
   * Helper to get enrichment data for a specific post.
   * Returns undefined for fields that haven't loaded yet.
   */
  const getPostEnrichment = useCallback((post: Post) => {
    const authorId = post.author.id
    const postId = post.id

    // Username: undefined = still loading, null = no DPNS, string = has DPNS
    const hasUsernameLoaded = enrichmentState.usernames.has(authorId)
    const username = hasUsernameLoaded
      ? enrichmentState.usernames.get(authorId)
      : undefined

    return {
      username,
      displayName: enrichmentState.profiles.get(authorId)?.displayName,
      avatarUrl: enrichmentState.avatars.get(authorId),
      stats: enrichmentState.stats.get(postId),
      interactions: enrichmentState.interactions.get(postId),
      isBlocked: enrichmentState.blockStatus.get(authorId),
      isFollowing: enrichmentState.followStatus.get(authorId),
      replyTo: enrichmentState.replyTo.get(postId)
    }
  }, [enrichmentState])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      enrichmentIdRef.current++
    }
  }, [])

  return {
    enrichProgressively,
    enrichmentState,
    reset,
    getPostEnrichment
  }
}
