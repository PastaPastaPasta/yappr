'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { MagnifyingGlassIcon, XMarkIcon, ArrowPathIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { WasmSdk } from '@dashevo/wasm-sdk'
import { logger } from '@/lib/logger'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useCopy } from '@/hooks/use-copy'
import { LoadingState, useAsyncState } from '@/components/ui/loading-state'
import ErrorBoundary from '@/components/error-boundary'
import { followService, dpnsService, unifiedProfileService } from '@/lib/services'
import type { UnifiedProfileDocument } from '@/lib/services/unified-profile-service'
import { sortUsernames } from '@/lib/utils/username'
import { cacheManager } from '@/lib/cache-manager'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AlsoKnownAs } from '@/components/ui/also-known-as'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { formatNumber } from '@/lib/utils'

export type ConnectionKind = 'following' | 'followers'

interface ConnectionUser {
  id: string
  /** Primary DPNS name, or the tail of the identity id when there is none. */
  username: string
  displayName: string
  bio?: string
  hasProfile: boolean
  hasDpnsName: boolean
  followersCount: number
  followingCount: number
  /** Whether the viewer follows this user. */
  isFollowing: boolean
  allUsernames: string[]
}

const COPY: Record<ConnectionKind, {
  title: string
  noun: [one: string, many: string]
  loadingText: string
  emptyText: string
  emptyDescription: string
  followLabel: string
}> = {
  following: {
    title: 'Following',
    noun: ['user', 'users'],
    loadingText: 'Loading following list...',
    emptyText: 'Not following anyone yet',
    emptyDescription: 'Find interesting people to follow on Yappr',
    followLabel: 'Follow',
  },
  followers: {
    title: 'Followers',
    noun: ['follower', 'followers'],
    loadingText: 'Loading followers...',
    emptyText: 'No followers yet',
    emptyDescription: 'Share interesting content to gain followers',
    followLabel: 'Follow back',
  },
}

/** DPNS search is over homograph-safe names; fall back to the raw input before the SDK is up. */
function toHomographSafe(input: string): string {
  try {
    return WasmSdk.dpnsConvertToHomographSafe(input)
  } catch {
    logger.warn('WASM SDK not initialized for homograph conversion, using original input')
    return input
  }
}

interface Enrichment {
  id: string
  profile: UnifiedProfileDocument | undefined
  followersCount: number
  followingCount: number
}

/**
 * Profile and follower/following counts per identity, in `ids` order. The
 * count queries never reject (the service returns 0 on failure); a profile
 * query failure is the caller's to handle.
 */
async function fetchEnrichment(ids: string[]): Promise<Enrichment[]> {
  const [profiles, followerCounts, followingCounts] = await Promise.all([
    unifiedProfileService.getProfilesByIdentityIds(ids),
    Promise.all(ids.map((id) => followService.countFollowers(id))),
    Promise.all(ids.map((id) => followService.countFollowing(id))),
  ])
  const byOwner = new Map(profiles.map((p) => [p.$ownerId, p]))
  return ids.map((id, i) => ({ id, profile: byOwner.get(id), followersCount: followerCounts[i], followingCount: followingCounts[i] }))
}

function toUser({ id, profile, followersCount, followingCount }: Enrichment, usernames: string[], isFollowing: boolean): ConnectionUser {
  const username = usernames[0] ?? null
  return {
    id,
    username: username ?? id.slice(-8),
    displayName: profile?.displayName || username || `User ${id.slice(-8)}`,
    bio: profile?.bio || undefined,
    hasProfile: !!profile,
    hasDpnsName: !!username,
    followersCount,
    followingCount,
    isFollowing,
    allUsernames: usernames,
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The /following and /followers pages: one list of enriched users for the
 * viewer or for `?id=`, with follow/unfollow on your own lists and, on your
 * own following list, a DPNS search for people to follow.
 */
export function ConnectionListPage({ kind }: { kind: ConnectionKind }) {
  const copy = COPY[kind]
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user: viewer } = useAuth()
  const viewerId = viewer?.identityId
  const { requireAuth } = useRequireAuth()
  const { data, loading, error, setLoading, setError, setData } = useAsyncState<ConnectionUser[]>(null)
  const [actionInProgress, setActionInProgress] = useState<Set<string>>(new Set())
  const [targetUserName, setTargetUserName] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ConnectionUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const targetUserId = searchParams.get('id')
  const isOwnProfile = !!viewerId && (!targetUserId || targetUserId === viewerId)
  const canSearch = kind === 'following' && isOwnProfile

  // The header names whoever's list this is, when it is not the viewer's own.
  useEffect(() => {
    if (!targetUserId || targetUserId === viewerId) return
    let cancelled = false
    const fallback = `User ${targetUserId.slice(-6)}`
    dpnsService
      .resolveUsername(targetUserId)
      .then((username) => { if (!cancelled) setTargetUserName(username || fallback) })
      .catch((error) => {
        logger.error('Failed to resolve target user name:', error)
        if (!cancelled) setTargetUserName(fallback)
      })
    return () => { cancelled = true }
  }, [targetUserId, viewerId])

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const userIdToLoad = targetUserId || viewerId
      if (!userIdToLoad) {
        setData([])
        return
      }

      const cacheKey = `${kind}_${userIdToLoad}`
      if (!forceRefresh) {
        const cached = cacheManager.get<ConnectionUser[]>(kind, cacheKey)
        if (cached) {
          setData(cached)
          return
        }
      }

      const follows = kind === 'following'
        ? await followService.getFollowing(userIdToLoad)
        : await followService.getFollowers(userIdToLoad)
      const ids = follows.map((f) => (kind === 'following' ? f.followingId : f.$ownerId)).filter(Boolean)
      if (ids.length === 0) {
        setData([])
        return
      }

      const [usernames, enrichment, followStatus] = await Promise.all([
        Promise.all(ids.map(async (id) => {
          try {
            return await dpnsService.getAllUsernamesSorted(id)
          } catch (error) {
            logger.error(`Failed to get all usernames for ${id}:`, error)
            return []
          }
        })),
        fetchEnrichment(ids),
        // Everyone on a following list is followed by definition. On your own
        // followers list the button depends on whether you follow them back.
        kind === 'followers' && isOwnProfile && viewerId
          ? followService.getFollowStatusBatch(ids, viewerId)
          : Promise.resolve(new Map<string, boolean>()),
      ])

      const users = enrichment.map((entry, i) =>
        toUser(entry, usernames[i], kind === 'following' || (followStatus.get(entry.id) ?? false))
      )
      cacheManager.set(kind, cacheKey, users)
      setData(users)
    } catch (error) {
      logger.error(`${kind}: failed to load list:`, error)
      setError(error instanceof Error ? error.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [kind, isOwnProfile, setLoading, setError, setData, viewerId, targetUserId])

  useEffect(() => {
    load().catch((error) => logger.error(`Failed to load ${kind}:`, error))
  }, [load, kind])

  const withProgress = async (userId: string, run: () => Promise<void>) => {
    setActionInProgress((prev) => new Set(prev).add(userId))
    try {
      await run()
    } finally {
      setActionInProgress((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    }
  }

  const applyFollowChange = (userId: string, isFollowing: boolean) => {
    setSearchResults((prev) => prev.map((u) => (u.id === userId ? { ...u, isFollowing } : u)))
    if (kind === 'followers') {
      setData((prev) => (prev ?? []).map((u) => (u.id === userId ? { ...u, isFollowing } : u)))
    } else if (!isFollowing) {
      setData((prev) => (prev ?? []).filter((u) => u.id !== userId))
    }
  }

  const handleFollow = (userId: string) => {
    const authedUser = requireAuth()
    if (!authedUser) return
    return withProgress(userId, async () => {
      try {
        const result = await followService.followUser(authedUser.identityId, userId)
        if (!result.success) throw new Error(result.error || 'Follow failed')
        applyFollowChange(userId, true)
        cacheManager.delete('following', `following_${authedUser.identityId}`)
        toast.success('Following')
        // A new follow belongs on your own following list; refetch to place it.
        if (kind === 'following') await load(true)
      } catch (error) {
        logger.error('Error following user:', error)
        toast.error('Failed to follow user')
      }
    })
  }

  const handleUnfollow = (userId: string) => {
    const authedUser = requireAuth()
    if (!authedUser) return
    return withProgress(userId, async () => {
      try {
        const result = await followService.unfollowUser(authedUser.identityId, userId)
        if (!result.success) throw new Error(result.error || 'Unfollow failed')
        applyFollowChange(userId, false)
        cacheManager.delete('following', `following_${authedUser.identityId}`)
        toast.success('Unfollowed')
      } catch (error) {
        logger.error('Error unfollowing user:', error)
        toast.error('Failed to unfollow user')
      }
    })
  }

  const searchUsers = useCallback(async () => {
    const query = searchQuery.trim()
    // DashPay's rule: at least three characters before we hit the network.
    if (query.length < 3) {
      setSearchResults([])
      setSearchError(null)
      return
    }
    setIsSearching(true)
    setSearchError(null)
    try {
      const results = await dpnsService.searchUsernamesWithDetails(toHomographSafe(query), 20)
      if (results.length === 0) {
        setSearchResults([])
        setSearchError('No users found with that name')
        return
      }
      const namesByOwner = new Map<string, string[]>()
      for (const { ownerId, username } of results) {
        if (!ownerId) continue
        namesByOwner.set(ownerId, [...(namesByOwner.get(ownerId) ?? []), username])
      }
      const ids = Array.from(namesByOwner.keys())
      // A DPNS hit is still worth showing when the profile lookup fails.
      const enrichment = await fetchEnrichment(ids).catch((error): Enrichment[] => {
        logger.error('Search: profile enrichment failed:', error)
        return ids.map((id) => ({ id, profile: undefined, followersCount: 0, followingCount: 0 }))
      })
      const followed = new Set(data?.map((u) => u.id))
      setSearchResults(enrichment.map((entry) => toUser(entry, sortUsernames(namesByOwner.get(entry.id) ?? []), followed.has(entry.id))))
    } catch (error) {
      logger.error('Search error:', error)
      setSearchError('Failed to search for user')
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }, [searchQuery, data])

  useEffect(() => {
    if (!searchQuery) return
    const timer = setTimeout(() => {
      searchUsers().catch((error) => logger.error('Failed to search users:', error))
    }, 500)
    return () => clearTimeout(timer)
  }, [searchQuery, searchUsers])

  const clearSearch = () => {
    setSearchQuery('')
    setSearchResults([])
    setSearchError(null)
  }

  const subtitle = searchQuery
    ? plural(searchResults.length, 'search result', 'search results')
    : loading
      ? 'Loading...'
      : plural(data?.length ?? 0, ...copy.noun)

  const renderRow = (u: ConnectionUser) => (
    <ConnectionRow
      key={u.id}
      user={u}
      showActions={isOwnProfile}
      followLabel={copy.followLabel}
      busy={actionInProgress.has(u.id)}
      onToggleFollow={() => (u.isFollowing ? handleUnfollow(u.id) : handleFollow(u.id))}
    />
  )

  return (
    <PageShell>
          <PageHeader>
            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {!isOwnProfile && (
                    <button
                      onClick={() => router.back()}
                      className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                      <ArrowLeftIcon className="h-5 w-5" />
                    </button>
                  )}
                  <div>
                    <h1 className="text-xl font-bold">
                      {isOwnProfile ? copy.title : `@${targetUserName || 'User'}'s ${copy.title}`}
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
                  </div>
                </div>
                {!searchQuery && (
                  <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading}>
                    <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </Button>
                )}
              </div>
            </div>

            {canSearch && (
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                <div className="relative">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                  <Input
                    type="text"
                    placeholder="Search for people to follow"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 pr-10"
                  />
                  {searchQuery && (
                    <button
                      onClick={clearSearch}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                    >
                      <XMarkIcon className="h-4 w-4 text-gray-500" />
                    </button>
                  )}
                </div>
                {searchError && <p className="text-sm text-red-500 mt-2">{searchError}</p>}
              </div>
            )}
          </PageHeader>

          <ErrorBoundary level="component">
            {searchQuery ? (
              isSearching ? (
                <div className="p-8 text-center">
                  <Spinner size="md" className="mx-auto mb-4" />
                  <p className="text-gray-500">Searching for DPNS users...</p>
                </div>
              ) : searchResults.length > 0 ? (
                <div>
                  <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 text-sm text-gray-500">Search Results</div>
                  {searchResults.map(renderRow)}
                </div>
              ) : searchError ? (
                <div className="p-8 text-center">
                  <p className="text-gray-500">{searchError}</p>
                </div>
              ) : null
            ) : (
              <LoadingState
                loading={loading || data === null}
                error={error}
                isEmpty={!loading && data !== null && data.length === 0}
                onRetry={load}
                loadingText={copy.loadingText}
                emptyText={copy.emptyText}
                emptyDescription={copy.emptyDescription}
              >
                <div>{data?.map(renderRow)}</div>
              </LoadingState>
            )}
          </ErrorBoundary>
    </PageShell>
  )
}

function ConnectionRow({
  user,
  showActions,
  followLabel,
  busy,
  onToggleFollow,
}: {
  user: ConnectionUser
  showActions: boolean
  followLabel: string
  busy: boolean
  onToggleFollow: () => void
}) {
  const router = useRouter()
  const copy = useCopy()
  const goToProfile = () => router.push(`/user?id=${user.id}`)
  const hoverUsername = user.hasDpnsName ? user.username : null

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors"
    >
      <div className="flex items-start gap-3">
        <ProfileHoverCard userId={user.id} username={hoverUsername} displayName={user.displayName}>
          <button
            onClick={goToProfile}
            className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 cursor-pointer hover:opacity-80 transition-opacity"
          >
            <UserAvatar userId={user.id} size="lg" alt={user.displayName} />
          </button>
        </ProfileHoverCard>

        <div className="flex-1">
          <div className="flex items-start justify-between">
            <div>
              <ProfileHoverCard userId={user.id} username={hoverUsername} displayName={user.displayName}>
                <h3 onClick={goToProfile} className="font-semibold hover:underline cursor-pointer">
                  {user.displayName}
                </h3>
              </ProfileHoverCard>
              {user.hasDpnsName ? (
                <ProfileHoverCard userId={user.id} username={user.username} displayName={user.displayName}>
                  <p onClick={goToProfile} className="text-sm text-gray-500 hover:underline cursor-pointer">
                    @{user.username}
                  </p>
                </ProfileHoverCard>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          copy(user.id, 'Identity ID copied')
                        }}
                        className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono"
                      >
                        {user.id.slice(0, 8)}...{user.id.slice(-6)}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={5}>Click to copy full identity ID</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {user.allUsernames.length > 1 && (
                <AlsoKnownAs primaryUsername={user.username} allUsernames={user.allUsernames} identityId={user.id} />
              )}
              {user.bio && <p className="text-sm mt-1">{user.bio}</p>}
              <div className="flex gap-4 mt-2 text-sm text-gray-500">
                <button onClick={() => router.push(`/followers?id=${user.id}`)} className="hover:underline">
                  <strong className="text-gray-900 dark:text-gray-100">{formatNumber(user.followersCount)}</strong> followers
                </button>
                <button onClick={() => router.push(`/following?id=${user.id}`)} className="hover:underline">
                  <strong className="text-gray-900 dark:text-gray-100">{formatNumber(user.followingCount)}</strong> following
                </button>
              </div>
            </div>

            {showActions && (
              <div className="flex flex-col items-end gap-1 ml-4">
                {user.isFollowing ? (
                  <Button variant="outline" size="sm" onClick={onToggleFollow} disabled={busy}>
                    {busy ? <Spinner size="sm" className="border-gray-600" /> : 'Following'}
                  </Button>
                ) : (
                  <Button size="sm" onClick={onToggleFollow} disabled={busy}>
                    {busy ? <Spinner size="sm" className="border-white" /> : followLabel}
                  </Button>
                )}
                {!user.hasProfile && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-gray-400 cursor-help">Not on Yappr yet</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        <p>This user hasn&apos;t created a Yappr profile yet. They&apos;ll see your follow when they join!</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
