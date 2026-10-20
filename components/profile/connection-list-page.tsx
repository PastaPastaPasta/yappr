'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { MagnifyingGlassIcon, XMarkIcon, ArrowPathIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { WasmSdk } from '@dashevo/evo-sdk'
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
import { cn } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AlsoKnownAs } from '@/components/ui/also-known-as'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { useHydratedPages } from '@/hooks/use-hydrated-pages'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel'
import type { HydratedPages } from '@/lib/hydrated-pages'

export type ConnectionKind = 'following' | 'followers'

/** Users hydrated (profile and names) per page of a connection list. */
const PAGE_SIZE = 50

/**
 * Followers read before the list shows. A followers list is written by other
 * people and can be long; past this the page says it shows only the first.
 * (A following list is the user's own writes, and is read whole.)
 */
const FOLLOWERS_CAP = 5000

/** What the connection list caches: the hydrated pages and whether the id list is complete. */
interface CachedConnections {
  pages: HydratedPages<string, ConnectionUser>
  complete: boolean
}

interface ConnectionUser {
  id: string
  /** Primary DPNS name, or the tail of the identity id when there is none. */
  username: string
  displayName: string
  bio?: string
  hasDpnsName: boolean
  /** Whether the viewer follows this user. */
  isFollowing: boolean
  allUsernames: string[]
}

const COPY: Record<ConnectionKind, {
  title: string
  noun: [one: string, many: string]
  emptyText: string
  /** The empty-state line on your own list; someone else's list has none. */
  ownEmptyDescription: string
  followLabel: string
}> = {
  following: {
    title: 'Following',
    noun: ['following', 'following'],
    emptyText: 'Not following anyone yet',
    ownEmptyDescription: "When you follow people, they'll show up here.",
    followLabel: 'Follow',
  },
  followers: {
    title: 'Followers',
    noun: ['follower', 'followers'],
    emptyText: 'No followers yet',
    ownEmptyDescription: "When someone follows you, they'll show up here.",
    followLabel: 'Follow back',
  },
}

const KINDS: ConnectionKind[] = ['followers', 'following']

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
}

/**
 * The profile per identity, in `ids` order. `strict` rejects when a profile
 * read failed, so a cached page never shows people without the profiles they
 * have; otherwise those people are left unprofiled.
 */
async function fetchEnrichment(ids: string[], { strict = true } = {}): Promise<Enrichment[]> {
  const profiles = await unifiedProfileService.getProfilesByIdentityIds(ids, { throwOnError: strict })
  const byOwner = new Map(profiles.map((p) => [p.$ownerId, p]))
  return ids.map((id) => ({ id, profile: byOwner.get(id) }))
}

function toUser({ id, profile }: Enrichment, usernames: string[], isFollowing: boolean): ConnectionUser {
  const username = usernames[0] ?? null
  return {
    id,
    username: username ?? id.slice(-8),
    // Without a profile the DPNS label is the name, as on the profile page.
    displayName: profile?.displayName || username?.replace(/\.dash$/, '') || `User ${id.slice(-8)}`,
    bio: profile?.bio || undefined,
    hasDpnsName: !!username,
    isFollowing,
    allUsernames: usernames,
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The /following and /followers pages: the whole list of ids for the viewer
 * or for `?id=`, enriched a page at a time as it scrolls, with
 * follow/unfollow on your own lists and, on your own following list, a DPNS
 * search for people to follow.
 */
export function ConnectionListPage({ kind }: { kind: ConnectionKind }) {
  const copy = COPY[kind]
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user: viewer } = useAuth()
  const viewerId = viewer?.identityId
  const { requireAuth, openLoginPrompt } = useRequireAuth()
  const { loading, error, setLoading, setError } = useAsyncState<ConnectionUser[]>(null)
  const [actionInProgress, setActionInProgress] = useState<Set<string>>(new Set())
  const [targetUserName, setTargetUserName] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const invalidateLoad = useCallback(() => { loadGeneration.current++ }, [])

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ConnectionUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const targetUserId = searchParams.get('id')
  const userIdToLoad = targetUserId || viewerId
  const isOwnProfile = !!viewerId && (!targetUserId || targetUserId === viewerId)
  const canSearch = kind === 'following' && isOwnProfile

  const hydrateUsers = useCallback(async (ids: string[]): Promise<ConnectionUser[]> => {
    const [usernamesById, enrichment, followStatus] = await Promise.all([
      dpnsService.getAllUsernamesSortedBatch(ids),
      fetchEnrichment(ids),
      // Everyone on a following list is followed by definition. On your own
      // followers list the button depends on whether you follow them back.
      kind === 'followers' && isOwnProfile && viewerId
        ? followService.getFollowStatusBatch(ids, viewerId)
        : Promise.resolve(new Map<string, boolean>()),
    ])
    return enrichment.map((entry) =>
      toUser(entry, usernamesById.get(entry.id) ?? [], kind === 'following' || (followStatus.get(entry.id) ?? false))
    )
  }, [kind, isOwnProfile, viewerId])
  const list = useHydratedPages(hydrateUsers, PAGE_SIZE)
  const { reset: resetList, clear: clearList, setPages, drop: dropFromList } = list
  const data = list.pages?.items ?? null
  const total = list.pages?.keys.length ?? 0
  // False when the followers list stopped at FOLLOWERS_CAP.
  const [complete, setComplete] = useState(true)
  const scroll = useInfiniteScroll({
    hasMore: list.hasMore,
    isLoading: list.loadingMore,
    onLoadMore: list.loadMore,
    disabled: !!searchQuery,
    resetKey: `${kind}:${userIdToLoad}`,
  })

  // The header names whoever's list this is.
  useEffect(() => {
    if (!userIdToLoad) return
    let cancelled = false
    const fallback = `User ${userIdToLoad.slice(-6)}`
    // The profile name, as on the profile page; usually cached from that visit.
    Promise.all([
      unifiedProfileService.getProfile(userIdToLoad).catch(() => null),
      dpnsService.resolveUsername(userIdToLoad),
    ])
      .then(([profile, username]) => {
        if (!cancelled) setTargetUserName(profile?.displayName || username?.replace(/\.dash$/, '') || fallback)
      })
      .catch((error) => {
        logger.error('Failed to resolve target user name:', error)
        if (!cancelled) setTargetUserName(fallback)
      })
    return () => { cancelled = true }
  }, [userIdToLoad])

  const load = useCallback(async (forceRefresh = false) => {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(null)
    try {
      if (!userIdToLoad) {
        clearList()
        return
      }

      const cacheKey = `${kind}_${userIdToLoad}`
      if (!forceRefresh) {
        const cached = cacheManager.get<CachedConnections>(kind, cacheKey)
        if (cached) {
          setPages(cached.pages)
          setComplete(cached.complete)
          return
        }
      }

      // The list of ids (following whole, followers up to the cap); only the
      // first page is enriched now.
      const { follows, complete: readAll } = kind === 'following'
        ? { follows: await followService.getFollowing(userIdToLoad, { throwOnError: true }), complete: true }
        : await followService.listFollowers(userIdToLoad, FOLLOWERS_CAP)
      if (generation !== loadGeneration.current) return
      const ids = Array.from(new Set(follows.map((f) => (kind === 'following' ? f.followingId : f.$ownerId)).filter(Boolean)))
      const pages = await resetList(ids)
      if (pages && generation === loadGeneration.current) {
        setComplete(readAll)
        cacheManager.set<CachedConnections>(kind, cacheKey, { pages, complete: readAll })
      }
    } catch (error) {
      logger.error(`${kind}: failed to load list:`, error)
      if (generation === loadGeneration.current) {
        setError(`Could not load ${kind}. Check your connection and try again.`)
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [kind, setLoading, setError, userIdToLoad, resetList, clearList, setPages])

  // hydrateUsers changes when the viewer resolves: reload so follow-back state is theirs.
  useEffect(() => {
    clearList()
    setComplete(true)
    load().catch((error) => logger.error(`Failed to load ${kind}:`, error))
    return invalidateLoad
  }, [load, kind, clearList, invalidateLoad, hydrateUsers])

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
      setPages((prev) => prev && { ...prev, items: prev.items.map((u) => (u.id === userId ? { ...u, isFollowing } : u)) })
    } else if (!isFollowing) {
      dropFromList((id) => id !== userId, (u) => u.id !== userId)
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
      // Search results are not cached, so a failed profile read degrades to the DPNS name.
      const enrichment = await fetchEnrichment(ids, { strict: false }).catch((error): Enrichment[] => {
        logger.error('Search: profile enrichment failed:', error)
        return ids.map((id) => ({ id, profile: undefined }))
      })
      // The whole following list, not just the enriched pages.
      const followed = new Set(list.pages?.keys)
      setSearchResults(enrichment.map((entry) => toUser(entry, sortUsernames(namesByOwner.get(entry.id) ?? []), followed.has(entry.id))))
    } catch (error) {
      logger.error('Search error:', error)
      setSearchError('Failed to search for user')
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }, [searchQuery, list.pages])

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
    ? plural(searchResults.length, 'result', 'results')
    : loading && data === null
      ? '\u00a0'
      : data === null ? '\u00a0' : `${plural(total, ...copy.noun)}${complete ? '' : '+'}`
  const listHref = (other: ConnectionKind) => `/${other}${targetUserId ? `?id=${targetUserId}` : ''}`

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

  // Both routes wait for session restoration in withAuth before rendering.
  // Without either a viewer or an explicit target, there is no list to count.
  if (!targetUserId && !viewerId) {
    return (
      <PageShell>
        <PageHeader>
          <h1 className="px-4 py-3 text-xl font-bold">{copy.title}</h1>
        </PageHeader>
        <section className="p-8 text-center" aria-labelledby="connection-sign-in-title">
          <h2 id="connection-sign-in-title" className="text-xl font-semibold mb-2">
            Sign in to view your {kind}
          </h2>
          <p className="text-gray-500 mb-6">
            To see someone else&apos;s {kind}, open their profile and select {copy.title}.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={openLoginPrompt}>Sign In</Button>
            <Button variant="outline" onClick={() => router.push('/explore')}>Explore Yappr</Button>
          </div>
        </section>
      </PageShell>
    )
  }

  return (
    <PageShell>
          <PageHeader>
            <div className="px-4 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  {!isOwnProfile && (
                    <button
                      aria-label="Back"
                      onClick={() => router.back()}
                      className="p-2 -ml-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                      <ArrowLeftIcon className="h-5 w-5" />
                    </button>
                  )}
                  <div className="min-w-0">
                    <h1 className="truncate text-xl font-bold">
                      {targetUserName ?? <span className="inline-block h-6 w-32 rounded bg-gray-200 align-middle animate-pulse dark:bg-gray-800" />}
                    </h1>
                    <p className="text-sm text-gray-500">{subtitle}</p>
                  </div>
                </div>
                {!searchQuery && (
                  <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading} aria-label={`Refresh ${kind}`}>
                    <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </Button>
                )}
              </div>
            </div>
            <nav aria-label="Connections" className="flex border-b border-gray-200 dark:border-gray-800">
              {KINDS.map((other) => (
                <Link
                  key={other}
                  href={listHref(other)}
                  replace
                  aria-current={other === kind ? 'page' : undefined}
                  className={cn(
                    'flex-1 py-3 text-center text-[15px] font-medium transition-colors hover:bg-gray-50 dark:hover:bg-gray-950',
                    other === kind ? 'text-gray-900 dark:text-white' : 'text-gray-500'
                  )}
                >
                  <span className={cn('relative inline-block pb-3 -mb-3', other === kind && 'font-bold after:absolute after:inset-x-0 after:bottom-0 after:h-1 after:rounded-full after:bg-yappr-500')}>
                    {COPY[other].title}
                  </span>
                </Link>
              ))}
            </nav>

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
                  <p className="text-gray-500">Searching…</p>
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
              <>
              {error && data !== null && (
                <div role="alert" className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 text-sm">
                  <p>{error} Showing the last loaded list.</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => load(true)} disabled={loading}>
                    Try Again
                  </Button>
                </div>
              )}
              {loading && data === null ? (
                <ConnectionSkeleton />
              ) : !loading && data !== null && total === 0 ? (
                <div className="px-8 py-12 text-center">
                  <h2 className="text-xl font-bold">{copy.emptyText}</h2>
                  {isOwnProfile && <p className="mt-1 text-gray-500">{copy.ownEmptyDescription}</p>}
                </div>
              ) : (
              <LoadingState
                loading={false}
                error={data === null ? error : null}
                onRetry={() => load(true)}
              >
                {!complete && (
                  <p className="px-4 py-2 text-center text-xs text-gray-500">
                    Showing the first {FOLLOWERS_CAP.toLocaleString()} followers.
                  </p>
                )}
                <div>{data?.map(renderRow)}</div>
                {list.hasMore && (
                  <InfiniteScrollSentinel
                    sentinelRef={scroll.sentinelRef}
                    isLoading={list.loadingMore}
                    isSuspended={scroll.isSuspended}
                    onLoadMore={scroll.loadMore}
                  />
                )}
              </LoadingState>
              )}
              </>
            )}
          </ErrorBoundary>
    </PageShell>
  )
}

/** Placeholder rows shaped like loaded ones, so the list does not jump when it arrives. */
function ConnectionSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-start gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <div className="h-12 w-12 shrink-0 rounded-full bg-gray-200 animate-pulse dark:bg-gray-800" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse dark:bg-gray-800" />
            <div className="h-3.5 w-24 rounded bg-gray-200 animate-pulse dark:bg-gray-800" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ConnectionRow({
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
  // Controls inside the row act on their own; a click anywhere else opens the profile.
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={goToProfile}
      className="cursor-pointer border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors"
    >
      <div className="flex items-start gap-3">
        <ProfileHoverCard userId={user.id} username={hoverUsername} displayName={user.displayName}>
          <button
            onClick={(e) => { stop(e); goToProfile() }}
            aria-label={user.displayName}
            tabIndex={-1}
            className="h-12 w-12 shrink-0 rounded-full overflow-hidden bg-white dark:bg-neutral-900 cursor-pointer hover:opacity-80 transition-opacity"
          >
            <UserAvatar userId={user.id} size="lg" alt={user.displayName} />
          </button>
        </ProfileHoverCard>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <ProfileHoverCard userId={user.id} username={hoverUsername} displayName={user.displayName}>
                <Link href={`/user?id=${user.id}`} onClick={stop} className="block truncate font-semibold hover:underline">
                  {user.displayName}
                </Link>
              </ProfileHoverCard>
              {user.hasDpnsName ? (
                <ProfileHoverCard userId={user.id} username={user.username} displayName={user.displayName}>
                  <Link href={`/user?id=${user.id}`} onClick={stop} className="block truncate text-sm text-gray-500 hover:underline">
                    @{user.username}
                  </Link>
                </ProfileHoverCard>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={(e) => {
                          stop(e)
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
                <div onClick={stop}>
                  <AlsoKnownAs primaryUsername={user.username} allUsernames={user.allUsernames} identityId={user.id} />
                </div>
              )}
            </div>

            {showActions && (
              <div className="shrink-0" onClick={stop}>
                {user.isFollowing ? (
                  <Button variant="outline" size="sm" onClick={onToggleFollow} disabled={busy} className="min-w-[5.5rem] font-bold">
                    {busy ? <Spinner size="sm" className="border-gray-600" /> : 'Following'}
                  </Button>
                ) : (
                  <Button size="sm" onClick={onToggleFollow} disabled={busy} className="min-w-[5.5rem] font-bold">
                    {busy ? <Spinner size="sm" className="border-white" /> : followLabel}
                  </Button>
                )}
              </div>
            )}
          </div>
          {user.bio && <p className="mt-1 break-words text-[15px]">{user.bio}</p>}
        </div>
      </div>
    </motion.div>
  )
}
