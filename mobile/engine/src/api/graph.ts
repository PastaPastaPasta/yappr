import { TtlMap } from '@/lib/caches/ttl-map'
import { dpnsService } from '@/lib/services/dpns-service'
import { followService } from '@/lib/services/follow-service'
import { assertAtMost, loadUserSummaries, requireViewer } from '../dto/hydrate'
import { pageOfList } from '../dto/paging'
import type { Page, UserSummaryDTO } from './dto'

/** Lists are read whole on web (up to 1000); the engine pages them. */
const CONNECTIONS_PAGE = 30

const connectionIds = new TtlMap<string, string[]>(60_000)

/**
 * One page of a followers or following list, as
 * `components/profile/connection-list-page.tsx` builds it: each user's
 * primary name, profile and follower/following counts, and, signed in,
 * whether the viewer follows them. A failed list read rejects.
 */
function connections(kind: 'followers' | 'following', id: string, cursor: string | null | undefined): Promise<Page<UserSummaryDTO>> {
  return pageOfList({
    kind,
    // Per list: both tabs of one profile stay mounted and page independently.
    key: `${kind}:${id}`,
    cursor,
    size: CONNECTIONS_PAGE,
    cache: connectionIds,
    load: async () => kind === 'following'
      ? (await followService.getFollowing(id, { throwOnError: true })).map(follow => follow.followingId).filter(Boolean)
      : (await followService.getFollowers(id, { throwOnError: true })).map(follow => follow.$ownerId).filter(Boolean),
    hydrate: async (ids) => {
      const names = await dpnsService.getAllUsernamesSortedBatch(ids)
      const usernames = new Map(ids.map(userId => [userId, names.get(userId)?.[0] ?? null]))
      const users = await loadUserSummaries(ids, { counts: true, usernames })
      return ids.flatMap(userId => users.get(userId) ?? [])
    },
  })
}

export const graph = {
  async followers(id: string, cursor?: string | null): Promise<Page<UserSummaryDTO>> {
    return connections('followers', id, cursor)
  },

  async following(id: string, cursor?: string | null): Promise<Page<UserSummaryDTO>> {
    return connections('following', id, cursor)
  },

  /** Whether the signed-in viewer follows each of up to 100 identities (`getFollowStatusBatch`). */
  async status(ids: string[]): Promise<Record<string, boolean>> {
    assertAtMost(ids, 100, 'ids')
    const status = await followService.getFollowStatusBatch(ids, requireViewer('Follow status'))
    return Object.fromEntries(ids.map(id => [id, status.get(id) === true]))
  },
}
