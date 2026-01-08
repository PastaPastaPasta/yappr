import { useState, useCallback, useRef, useEffect } from 'react'
import { Post } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { profileService } from '@/lib/services/profile-service'
import { avatarService } from '@/lib/services/avatar-service'
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
    phase: 'idle'
  }
}

interface UseProgressiveEnrichmentOptions {
  currentUserId?: string
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
  const { currentUserId } = options

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

    // Extract IDs
    const postIds = posts.map(p => p.id)
    const authorIds = Array.from(new Set(posts.map(p => p.author.id).filter(Boolean)))

    // Set loading phase
    setEnrichmentState(prev => ({ ...prev, phase: 'loading' }))

    // Helper to merge Maps (TypeScript-compatible without downlevelIteration)
    const mergeMaps = <K, V>(prev: Map<K, V>, next: Map<K, V>): Map<K, V> => {
      const merged = new Map(prev)
      next.forEach((value, key) => merged.set(key, value))
      return merged
    }

    // Fire all requests in parallel, handle results as they complete
    // Priority 1: DPNS usernames (most visible - author identity)
    dpnsService.resolveUsernamesBatch(authorIds).then(usernames => {
      if (!isValid()) return
      setEnrichmentState(prev => ({
        ...prev,
        usernames: mergeMaps(prev.usernames, usernames)
      }))
    }).catch(err => console.error('Progressive enrichment: usernames failed', err))

    // Priority 1: Profiles (display names)
    profileService.getProfilesByIdentityIds(authorIds).then(profiles => {
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
    avatarService.getAvatarUrlsBatch(authorIds).then(avatars => {
      if (!isValid()) return
      setEnrichmentState(prev => ({
        ...prev,
        avatars: mergeMaps(prev.avatars, avatars)
      }))
    }).catch(err => console.error('Progressive enrichment: avatars failed', err))

    // Priority 3: Stats
    postService.getBatchPostStats(postIds).then(stats => {
      if (!isValid()) return
      setEnrichmentState(prev => ({
        ...prev,
        stats: mergeMaps(prev.stats, stats)
      }))
    }).catch(err => console.error('Progressive enrichment: stats failed', err))

    // Priority 4: User interactions (only if logged in)
    if (currentUserId) {
      postService.getBatchUserInteractions(postIds).then(interactions => {
        if (!isValid()) return
        setEnrichmentState(prev => ({
          ...prev,
          interactions: mergeMaps(prev.interactions, interactions)
        }))
      }).catch(err => console.error('Progressive enrichment: interactions failed', err))

      // Priority 5: Block/Follow status
      Promise.all([
        blockService.getBlockStatusBatch(authorIds, currentUserId),
        followService.getFollowStatusBatch(authorIds, currentUserId)
      ]).then(([blockStatus, followStatus]) => {
        if (!isValid()) return
        // Seed shared caches for PostCard hooks
        seedBlockStatusCache(currentUserId, blockStatus)
        seedFollowStatusCache(currentUserId, followStatus)
        setEnrichmentState(prev => ({
          ...prev,
          blockStatus: mergeMaps(prev.blockStatus, blockStatus),
          followStatus: mergeMaps(prev.followStatus, followStatus)
        }))
      }).catch(err => console.error('Progressive enrichment: block/follow failed', err))
    }

    // Set complete phase after a reasonable time
    // This is a heuristic - in practice, all requests should complete within 2-3 seconds
    Promise.all([
      dpnsService.resolveUsernamesBatch(authorIds),
      profileService.getProfilesByIdentityIds(authorIds),
      avatarService.getAvatarUrlsBatch(authorIds),
      postService.getBatchPostStats(postIds),
      ...(currentUserId ? [postService.getBatchUserInteractions(postIds)] : [])
    ]).finally(() => {
      if (!isValid()) return
      setEnrichmentState(prev => ({ ...prev, phase: 'complete' }))
    })

  }, [currentUserId])

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
      isFollowing: enrichmentState.followStatus.get(authorId)
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
