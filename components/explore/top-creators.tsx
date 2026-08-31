'use client'

import { logger } from '@/lib/logger'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { TrophyIcon, UsersIcon } from '@heroicons/react/24/outline'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@/lib/utils'
import { followRankingsAvailable } from '@/lib/contract-topology'
import type { RankedGroupCount } from '@/lib/services/ranked-likes'

/** A ranked identity hydrated into something renderable. */
interface RankedUser {
  id: string
  count: number
  displayName: string
  username: string | null
}

/**
 * Hydrate ranked identity groups into renderable rows: one batched profile
 * query + one batched DPNS reverse lookup across BOTH lists, mirroring the
 * enrichment pattern the likes modal / followers page use. Ranking order is
 * the proved order and is preserved as-is.
 */
async function hydrateRankedUsers(rankings: RankedGroupCount[][]): Promise<RankedUser[][]> {
  const ids = Array.from(new Set(rankings.flat().map((entry) => entry.key)))
  if (ids.length === 0) return rankings.map(() => [])

  const [{ dpnsService }, { unifiedProfileService }] = await Promise.all([
    import('@/lib/services/dpns-service'),
    import('@/lib/services/unified-profile-service'),
  ])
  const [usernameMap, profiles] = await Promise.all([
    dpnsService.resolveUsernamesBatch(ids),
    unifiedProfileService.getProfilesByIdentityIds(ids),
  ])
  const profileMap = new Map(profiles.map((profile) => [profile.$ownerId, profile]))

  return rankings.map((ranking) =>
    ranking.map((entry) => {
      const username = usernameMap.get(entry.key) ?? null
      const displayName = profileMap.get(entry.key)?.displayName
      return {
        id: entry.key,
        count: entry.count,
        displayName: displayName || username || `User ${entry.key.slice(-6)}`,
        username,
      }
    })
  )
}

function RankedUserList({
  users,
  countLabel,
  testId,
}: {
  users: RankedUser[]
  /** Singular unit for the count, e.g. 'like' / 'follower'. */
  countLabel: string
  testId: string
}) {
  return (
    <div className="divide-y divide-gray-200 dark:divide-gray-800" data-testid={testId}>
      {users.map((user, index) => (
        <Link
          key={user.id}
          href={`/user?id=${user.id}`}
          data-testid={`${testId}-${user.id}`}
          className="flex items-center gap-3 p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors"
        >
          <span className="text-sm text-gray-400 w-6">#{index + 1}</span>
          <UserAvatar userId={user.id} size="md" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold truncate">{user.displayName}</p>
            {user.username ? (
              <p className="text-sm text-gray-500 truncate">@{user.username}</p>
            ) : (
              <p className="text-sm text-gray-500 font-mono truncate">
                {user.id.slice(0, 8)}...{user.id.slice(-6)}
              </p>
            )}
          </div>
          <span className="text-sm text-gray-500 shrink-0">
            {formatNumber(user.count)} {user.count === 1 ? countLabel : `${countLabel}s`}
          </span>
        </Link>
      ))}
    </div>
  )
}

/**
 * The v5 creator leaderboard: top authors by likes received, from the proved
 * prefix ranked page on `like.byAuthorPost {at: [postAuthor, postId]}`, plus —
 * when the follow ranked chain exists — most-followed users off
 * `follow.followerCount`. Both fail soft: a ranking that errors comes back
 * empty and its section hides, so a node that cannot serve the prefix form
 * yet degrades to an empty state instead of an error.
 *
 * Render-gated by the caller on `prefixRankingsAvailable()`.
 */
export function TopCreators() {
  const [creators, setCreators] = useState<RankedUser[]>([])
  const [mostFollowed, setMostFollowed] = useState<RankedUser[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const { topCreatorsByLikes, mostFollowedUsers } = await import('@/lib/services/ranked-likes')
        const [creatorRanking, followRanking] = await Promise.all([
          topCreatorsByLikes(10),
          followRankingsAvailable() ? mostFollowedUsers(10) : Promise.resolve([]),
        ])
        const [hydratedCreators, hydratedFollowed] = await hydrateRankedUsers([
          creatorRanking,
          followRanking,
        ])
        setCreators(hydratedCreators)
        setMostFollowed(hydratedFollowed)
      } catch (error) {
        logger.error('Failed to load creator leaderboard:', error)
        setCreators([])
        setMostFollowed([])
      } finally {
        setIsLoading(false)
      }
    }

    load().catch((err) => logger.error('Failed to load creator leaderboard:', err))
  }, [])

  if (isLoading) {
    return (
      <div className="p-8 text-center">
        <Spinner size="md" className="mx-auto mb-4" />
        <p className="text-gray-500">Loading top creators...</p>
      </div>
    )
  }

  if (creators.length === 0 && mostFollowed.length === 0) {
    return (
      <div className="p-8 text-center" data-testid="explore-top-creators-empty">
        <TrophyIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500">No ranked creators yet</p>
        <p className="text-sm text-gray-400 mt-1">Creators show up here once their posts get likes</p>
      </div>
    )
  }

  return (
    <div>
      {creators.length > 0 && (
        <>
          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
              <TrophyIcon className="h-4 w-4" />
              Top creators by likes received
            </h3>
          </div>
          <RankedUserList users={creators} countLabel="like" testId="explore-top-creators" />
        </>
      )}
      {mostFollowed.length > 0 && (
        <>
          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
              <UsersIcon className="h-4 w-4" />
              Most followed
            </h3>
          </div>
          <RankedUserList users={mostFollowed} countLabel="follower" testId="explore-most-followed" />
        </>
      )}
    </div>
  )
}
