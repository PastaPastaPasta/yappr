import { logger } from '@/lib/logger';
import { useState, useCallback, useRef, useEffect } from 'react'
import { Post } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { blockService } from '@/lib/services/block-service'
import { followService } from '@/lib/services/follow-service'
import { blockStatusCache, followStatusCache } from '@/lib/caches/user-status-cache'
import { targetOf, type KindedTarget } from '@/lib/contract-topology'
import { repostedAuthorIdOf } from '@/lib/feed/quote-reposts'
import { marksFor, type ViewerMarks } from '@/lib/feed/viewer-marks'

export interface PostStats {
  likes: number
  reposts: number
  replies: number
  quotes: number
  views: number
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

/**
 * Enrichment slices that arrived with the posts themselves (a composite
 * feed page proves the counts, profiles, names and the viewer's marks
 * under the same root as the posts). Keys present here are merged into
 * the state at once and excluded from the follow-up queries; keys absent
 * are fetched as before, so partial preloads degrade gracefully.
 */
export interface PreloadedEnrichment {
  usernames?: Map<string, string | null>
  profiles?: Map<string, ProfileData>
  avatars?: Map<string, string>
  stats?: Map<string, PostStats>
  /** The viewer's marks, each naming the viewer it was read for. */
  interactions?: Map<string, ViewerMarks>
}

export interface EnrichmentState {
  // Author data keyed by authorId
  usernames: Map<string, string | null>     // authorId → DPNS username (null = no DPNS)
  profiles: Map<string, ProfileData>        // authorId → profile data
  avatars: Map<string, string>              // authorId → avatar URL
  // The viewer `blockStatus` and `followStatus` were read for (unset: nobody, signed out)
  relationsFor: string | undefined
  blockStatus: Map<string, boolean>         // authorId → isBlocked
  followStatus: Map<string, boolean>        // authorId → isFollowing
  // Post data keyed by postId
  stats: Map<string, PostStats>             // postId → stats
  interactions: Map<string, ViewerMarks>    // postId → the viewer's marks, with that viewer
  marksPending: Set<string>                 // postIds whose marks this hook is still reading
  replyTo: Map<string, ReplyToData>         // postId → parent post data (for replies)
  // Loading phase
  phase: 'idle' | 'loading' | 'complete'
}

function mergeMaps<K, V>(prev: Map<K, V>, next: Map<K, V>): Map<K, V> {
  const merged = new Map(prev)
  next.forEach((value, key) => merged.set(key, value))
  return merged
}

function createEmptyEnrichmentState(relationsFor?: string): EnrichmentState {
  return {
    usernames: new Map(),
    profiles: new Map(),
    avatars: new Map(),
    relationsFor,
    blockStatus: new Map(),
    followStatus: new Map(),
    stats: new Map(),
    interactions: new Map(),
    marksPending: new Set(),
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
  enrichProgressively: (posts: Post[], preloaded?: PreloadedEnrichment) => void
  reset: () => void
  isAuthorBlocked: (authorId: string) => boolean
  getPostEnrichment: (post: Post) => {
    username: string | null | undefined  // undefined = loading, null = no DPNS, string = username
    displayName: string | undefined
    profileLoaded: boolean  // true once the profile query resolved, even for authors with no profile
    avatarUrl: string | undefined
    stats: PostStats | undefined
    interactions: ViewerMarks | undefined
    marksPending: boolean
    isBlocked: boolean | undefined
    isFollowing: boolean | undefined
    relationsFor: string | undefined
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
 * 4. The viewer's marks, when they came with the posts (a card reads its own otherwise)
 * 5. Block/Follow status (action states)
 *
 * Block and follow status belong to the viewer they were read for. When the
 * viewer changes with the list still on screen (a sign-in from the sheet), they
 * are dropped and read again for every author this hook has seen, so the list
 * itself, its counts and its names stay as they are.
 */
export function useProgressiveEnrichment(
  options: UseProgressiveEnrichmentOptions = {}
): UseProgressiveEnrichmentResult {
  const { currentUserId, skipFollowStatus = false } = options

  const [enrichmentState, setEnrichmentState] = useState<EnrichmentState>(() => createEmptyEnrichmentState(currentUserId))

  // Track the current enrichment request to handle cancellation on tab switch
  const enrichmentIdRef = useRef(0)
  // Every author enriched since the last reset, so a new viewer's relations can be read for them.
  const seenRef = useRef({ authorIds: new Set<string>(), blockIds: new Set<string>(), followIds: new Set<string>() })
  // The viewer now, for results that arrive after it changed.
  const viewerRef = useRef(currentUserId)
  viewerRef.current = currentUserId

  const reset = useCallback(() => {
    enrichmentIdRef.current++
    seenRef.current = { authorIds: new Set(), blockIds: new Set(), followIds: new Set() }
    setEnrichmentState(createEmptyEnrichmentState(viewerRef.current))
  }, [])

  /** Merges relations read for `viewer`, unless the viewer has changed since. */
  const mergeRelations = useCallback((viewer: string, slice: 'blockStatus' | 'followStatus', values: Map<string, boolean>) => {
    setEnrichmentState(prev => prev.relationsFor !== viewer || viewerRef.current !== viewer
      ? prev
      : { ...prev, [slice]: mergeMaps(prev[slice], values) })
  }, [])

  /** Reads `viewer`'s block and follow status for the given authors. */
  const loadRelations = useCallback((viewer: string, ids: { authorIds: string[]; blockIds: string[]; followIds: string[] }, isValid: () => boolean) => {
    // Priority 5: Block status (always query for filtering).
    if (ids.blockIds.length > 0) {
      blockService.checkBlockedBatch(viewer, ids.blockIds).then(blockStatus => {
        blockStatusCache.seed(viewer, blockStatus)
        if (isValid()) mergeRelations(viewer, 'blockStatus', blockStatus)
      }).catch(err => logger.error('Progressive enrichment: block status failed', err))
    }

    // Priority 5: Follow status (skip if on Following tab - all authors are followed by definition)
    if (!skipFollowStatus) {
      if (ids.followIds.length === 0) return
      followService.getFollowStatusBatch(ids.followIds, viewer).then(followStatus => {
        followStatusCache.seed(viewer, followStatus)
        if (isValid()) mergeRelations(viewer, 'followStatus', followStatus)
      }).catch(err => logger.error('Progressive enrichment: follow status failed', err))
    } else {
      // On Following tab, mark all authors as followed
      const followStatus = new Map<string, boolean>()
      ids.authorIds.forEach(id => followStatus.set(id, true))
      followStatusCache.seed(viewer, followStatus)
      mergeRelations(viewer, 'followStatus', followStatus)
    }
  }, [mergeRelations, skipFollowStatus])

  // A new viewer with the list still on screen: the old one's relations go, and the new one's are read.
  const relationsViewerRef = useRef(currentUserId)
  useEffect(() => {
    if (relationsViewerRef.current === currentUserId) return
    relationsViewerRef.current = currentUserId
    setEnrichmentState(prev => ({ ...prev, relationsFor: currentUserId, blockStatus: new Map(), followStatus: new Map() }))
    const seen = seenRef.current
    if (!currentUserId || seen.authorIds.size === 0) return
    loadRelations(currentUserId, {
      authorIds: Array.from(seen.authorIds),
      blockIds: Array.from(seen.blockIds),
      followIds: Array.from(seen.followIds),
    }, () => true)
  }, [currentUserId, loadRelations])

  /**
   * Start progressive enrichment for the given posts.
   * Non-blocking - returns immediately and updates state as data loads.
   */
  const enrichProgressively = useCallback((posts: Post[], preloaded?: PreloadedEnrichment) => {
    if (posts.length === 0) return

    // Increment request ID to invalidate any in-flight requests
    const requestId = ++enrichmentIdRef.current
    // Read here, not from the render: the callback stays the same across a viewer change, so the list using it isn't reloaded.
    const viewerId = viewerRef.current

    // Check if this request is still valid
    const isValid = () => enrichmentIdRef.current === requestId

    // Registered before any await: a viewer change while this batch is still
    // loading re-reads relations for every author seen, these included.
    const authorIds = Array.from(new Set(posts.map(p => p.author.id).filter(Boolean)))
    // Quoted authors are gated for media just like top-level ones, but they are
    // NOT enriched as authors (no username/profile/avatar/block lookups) and
    // must never be seeded as followed on the Following tab — following the
    // quoter says nothing about who they quoted. Their follow status rides
    // along on the real batch query only, which seeds the shared cache that
    // useMediaGate reads, so an embedded card of someone you follow renders its
    // media instead of a placeholder.
    const followLookupIds = Array.from(
      new Set([...authorIds, ...posts.map(p => p.quotedPost?.author.id).filter((id): id is string => !!id)])
    )
    // A v10 bare repost is shown as its target's author's post, so that
    // author's block status is read too (none on v2/v9).
    const blockIds = Array.from(new Set([
      ...authorIds,
      ...posts.map(repostedAuthorIdOf).filter((id): id is string => id !== null),
    ]))
    const seen = seenRef.current
    authorIds.forEach(id => seen.authorIds.add(id))
    blockIds.forEach(id => seen.blockIds.add(id))
    followLookupIds.forEach(id => seen.followIds.add(id))

    const run = async () => {
      if (!preloaded) {
        // The composite read carries the viewer's marks: cards wait for it rather than reading their own.
        const pendingIds = viewerId ? posts.map(post => post.id) : []
        const setPending = (pending: boolean) => setEnrichmentState(prev => {
          const marksPending = new Set(prev.marksPending)
          pendingIds.forEach(id => (pending ? marksPending.add(id) : marksPending.delete(id)))
          return { ...prev, marksPending }
        })
        if (pendingIds.length > 0) setPending(true)
        try {
          const { loadPostEnrichment } = await import('@/lib/feed/load-post-enrichment')
          preloaded = await loadPostEnrichment(posts, viewerId)
        } finally {
          if (pendingIds.length > 0) setPending(false)
        }
        if (!isValid()) return
      }
      // Extract IDs (deduplicate to prevent "duplicate values for In query" errors).
      // Each target carries its kind, so the stats/interaction queries are
      // partitioned by interaction surface — one partition (i.e. unchanged) on v2.
      const seenPostIds = new Set<string>()
      const targets: KindedTarget[] = []
      for (const post of posts) {
        if (!post.id || seenPostIds.has(post.id)) continue
        seenPostIds.add(post.id)
        targets.push(targetOf(post))
      }

      // Set loading phase, merging whatever arrived with the posts
      setEnrichmentState(prev => ({
        ...prev,
        phase: 'loading',
        usernames: preloaded?.usernames ? mergeMaps(prev.usernames, preloaded.usernames) : prev.usernames,
        profiles: preloaded?.profiles ? mergeMaps(prev.profiles, preloaded.profiles) : prev.profiles,
        avatars: preloaded?.avatars ? mergeMaps(prev.avatars, preloaded.avatars) : prev.avatars,
        stats: preloaded?.stats ? mergeMaps(prev.stats, preloaded.stats) : prev.stats,
        interactions: preloaded?.interactions ? mergeMaps(prev.interactions, preloaded.interactions) : prev.interactions,
      }))

      // Only what the preload did not cover goes to the network
      const notIn = <V,>(map: Map<string, V> | undefined) => (id: string) => !map?.has(id)
      const usernameAuthorIds = authorIds.filter(notIn(preloaded?.usernames))
      const profileAuthorIds = authorIds.filter(notIn(preloaded?.profiles))
      const avatarAuthorIds = authorIds.filter(notIn(preloaded?.avatars))
      const statsTargets = targets.filter(target => notIn(preloaded?.stats)(target.id))

      // Store promises so we can reuse them for completion tracking
      // This prevents duplicate queries that were happening before

      // Priority 1: DPNS usernames (most visible - author identity)
      const usernamePromise = usernameAuthorIds.length > 0
        ? dpnsService.resolveUsernamesBatch(usernameAuthorIds)
        : Promise.resolve(new Map<string, string | null>())
      usernamePromise.then(usernames => {
        if (!isValid()) return
        setEnrichmentState(prev => ({
          ...prev,
          usernames: mergeMaps(prev.usernames, usernames)
        }))
      }).catch(err => logger.error('Progressive enrichment: usernames failed', err))

      // Priority 1: Profiles (display names)
      const profilePromise = profileAuthorIds.length > 0
        ? unifiedProfileService.getProfilesByIdentityIds(profileAuthorIds)
        : Promise.resolve([] as Awaited<ReturnType<typeof unifiedProfileService.getProfilesByIdentityIds>>)
      // Seed queried authors that have no entry yet, so consumers can
      // distinguish "loaded, no profile" (empty entry) from "still loading"
      // (no entry) without clobbering profiles from earlier batches
      const seedMissingAuthors = (profiles: Map<string, ProfileData>): Map<string, ProfileData> => {
        const seeded = new Map(profiles)
        for (const id of authorIds) {
          if (!seeded.has(id)) {
            seeded.set(id, {})
          }
        }
        return seeded
      }

      profilePromise.then(profiles => {
        if (!isValid()) return
        const profileMap = new Map<string, ProfileData>()
        for (const profile of profiles) {
          if (profile.$ownerId) {
            profileMap.set(profile.$ownerId, {
              displayName: profile.displayName,
              bio: profile.bio
            })
          }
        }
        setEnrichmentState(prev => ({
          ...prev,
          profiles: seedMissingAuthors(mergeMaps(prev.profiles, profileMap))
        }))
      }).catch(err => {
        logger.error('Progressive enrichment: profiles failed', err)
        if (!isValid()) return
        // Mark the authors as loaded so cards fall back to identity display
        // instead of showing a loading skeleton forever
        setEnrichmentState(prev => ({
          ...prev,
          profiles: seedMissingAuthors(prev.profiles)
        }))
      })

      // Priority 2: Avatars
      const avatarPromise = avatarAuthorIds.length > 0
        ? unifiedProfileService.getAvatarUrlsBatch(avatarAuthorIds)
        : Promise.resolve(new Map<string, string>())
      avatarPromise.then(avatars => {
        if (!isValid()) return
        setEnrichmentState(prev => ({
          ...prev,
          avatars: mergeMaps(prev.avatars, avatars)
        }))
      }).catch(err => logger.error('Progressive enrichment: avatars failed', err))

      // Priority 3: Stats
      const statsPromise = statsTargets.length > 0
        ? postService.getBatchPostStats(statsTargets)
        : Promise.resolve(new Map<string, PostStats>())
      statsPromise.then(stats => {
        if (!isValid()) return
        setEnrichmentState(prev => ({
          ...prev,
          stats: mergeMaps(prev.stats, stats)
        }))
      }).catch(err => logger.error('Progressive enrichment: stats failed', err))

      // Read for the viewer now; if it changed while this batch loaded, the
      // viewer-change effect already read these authors for it.
      if (viewerId && viewerRef.current === viewerId) {
        loadRelations(viewerId, { authorIds, blockIds, followIds: followLookupIds }, isValid)
      }

      // Track completion using the SAME promises (no duplicate queries!). Each
      // promise already reports its own failure above; here only settlement matters.
      Promise.allSettled([
        usernamePromise,
        profilePromise,
        avatarPromise,
        statsPromise,
      ]).then(() => {
        if (!isValid()) return
        setEnrichmentState(prev => ({ ...prev, phase: 'complete' }))
      }).catch(err => logger.error('Progressive enrichment: completion tracking failed', err))
    }
    run().catch(error => logger.error('Progressive enrichment failed', error))

  }, [loadRelations])

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

    // Relations read for another viewer (or before a sign-in) are not this viewer's.
    const relationsKnown = enrichmentState.relationsFor === currentUserId
    return {
      username,
      displayName: enrichmentState.profiles.get(authorId)?.displayName,
      profileLoaded: enrichmentState.profiles.has(authorId),
      avatarUrl: enrichmentState.avatars.get(authorId),
      stats: enrichmentState.stats.get(postId),
      interactions: marksFor(enrichmentState.interactions.get(postId), currentUserId),
      marksPending: enrichmentState.marksPending.has(postId),
      isBlocked: relationsKnown ? enrichmentState.blockStatus.get(authorId) : undefined,
      isFollowing: relationsKnown ? enrichmentState.followStatus.get(authorId) : undefined,
      relationsFor: relationsKnown ? currentUserId : undefined,
      replyTo: enrichmentState.replyTo.get(postId)
    }
  }, [enrichmentState, currentUserId])

  /** True when the current viewer blocks `authorId`, as far as has been read for them. */
  const isAuthorBlocked = useCallback((authorId: string) =>
    enrichmentState.relationsFor === currentUserId && enrichmentState.blockStatus.get(authorId) === true,
  [enrichmentState, currentUserId])

  // Cleanup on unmount
  useEffect(() => {
    const idRef = enrichmentIdRef
    return () => {
      idRef.current++
    }
  }, [])

  return {
    enrichProgressively,
    reset,
    isAuthorBlocked,
    getPostEnrichment
  }
}
