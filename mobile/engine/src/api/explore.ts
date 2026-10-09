import { followRankingsAvailable, likesAreIndexOnly, prefixRankingsAvailable } from '@/lib/contract-topology'
import { cashtagStorageToDisplay, isCashtagStorage } from '@/lib/post-helpers'
import { hashtagService } from '@/lib/services/hashtag-service'
import { postService } from '@/lib/services/post-service'
import { mostFollowedUsers, topCreatorsByLikes, topLikedPostsHydrated, type RankedGroupCount } from '@/lib/services/ranked-likes'
import { listToDTOs, loadUserSummaries, notSupported, searchUserSummaries, visibleDTOs, withLoadingAuthor } from '../dto/hydrate'
import type { PostDTO, RankedUserDTO, RankingWindow, TagDTO, UserSummaryDTO } from './dto'

/**
 * Explore and search (`app/explore/page.tsx`, `app/search/page.tsx`,
 * `components/explore/top-creators.tsx`). Blog results are not part of 1.0.
 */

/** `app/search/page.tsx`: every search waits for 3 characters, like DashPay. */
const SEARCH_MIN_LENGTH = 3
/** A plain hashtag in storage form (the search page's exact-match test). */
const STORAGE_TAG = /^[a-z0-9_]{1,63}$/

function toTagDTO(tag: string, count: number, countKind: TagDTO['countKind']): TagDTO {
  const cashtag = isCashtagStorage(tag)
  return { tag, kind: cashtag ? 'cashtag' : 'hashtag', display: cashtag ? `$${cashtagStorageToDisplay(tag)}` : `#${tag}`, count, countKind }
}

/** On v9/v10 trending is the proved ranking of likes on tagged posts; v2 counts recent posts. */
const trendingCountKind = (): TagDTO['countKind'] => (prefixRankingsAvailable() ? 'likes' : 'posts')

const trendingTags = (limit: number, window: RankingWindow = 'all') =>
  hashtagService.getTrendingHashtags({ timeWindowHours: 168, minPosts: 1, limit, window })

export const explore = {
  /** Trending hashtags and cashtags, 12, over the last week (v2) or the ranking window (v9/v10). */
  async trending(query: { window?: RankingWindow } = {}): Promise<TagDTO[]> {
    const countKind = trendingCountKind()
    return (await trendingTags(12, query.window)).map(trend => toTagDTO(trend.hashtag, trend.postCount, countKind))
  },

  /**
   * The 20 most-liked posts (one proved ranking), blocked authors and hidden
   * NSFW left out; `rankings` capability. `refresh` (a pull to refresh) reads
   * the page afresh instead of from lib's minute-long ranked cache, as web's Top
   * feed refresh does (`use-top-feed.ts`); other reads keep the cache.
   */
  async topPosts(query: { window?: RankingWindow; refresh?: boolean } = {}): Promise<PostDTO[]> {
    if (!likesAreIndexOnly()) throw notSupported('Top posts')
    // The ranked path resolves quotes through its own composite proof, never
    // through resolve-quoted-posts' cache, so rereadQuotedPosts here would do
    // nothing. ranked-likes' cache drops a page whose quote target this engine
    // forgot (its own delete); a delete on another device bumps nothing here,
    // so only a refresh's fresh read shows it before the cache expires (RC16-I-04).
    return visibleDTOs(await topLikedPostsHydrated({ limit: 20, window: query.window ?? 'all', force: query.refresh === true }))
  },

  /**
   * The creator leaderboards: top 10 by likes received, then (where the
   * follow ranking exists) the 10 most followed, which has no window.
   * Each fails soft to empty, as on web.
   */
  async topCreators(query: { window?: RankingWindow } = {}): Promise<RankedUserDTO[]> {
    if (!prefixRankingsAvailable()) throw notSupported('Top creators')
    const [byLikes, byFollowers] = await Promise.all([
      topCreatorsByLikes(10, query.window ?? 'all'),
      followRankingsAvailable() ? mostFollowedUsers(10) : Promise.resolve<RankedGroupCount[]>([]),
    ])
    const users = await loadUserSummaries([...byLikes, ...byFollowers].map(entry => entry.key), { viewerFollows: false })
    const rows = (ranking: RankedGroupCount[], by: RankedUserDTO['by']) =>
      ranking.flatMap((entry): RankedUserDTO[] => {
        const user = users.get(entry.key)
        return user ? [{ user, count: entry.count, by }] : []
      })
    return [...rows(byLikes, 'likes'), ...rows(byFollowers, 'followers')]
  },

  /** Users by DPNS name prefix (exact resolution when the prefix finds nothing), one row per identity. */
  async searchUsers(query: string, limit = 10): Promise<UserSummaryDTO[]> {
    const text = query.trim()
    return text.length < SEARCH_MIN_LENGTH ? [] : searchUserSummaries(text, limit, true)
  },

  /** Trending tags containing the query, with the exact tag first when it has posts but is not trending. */
  async searchHashtags(query: string): Promise<TagDTO[]> {
    const text = query.trim()
    if (text.length < SEARCH_MIN_LENGTH) return []
    const needle = text.replace(/^#/, '').toLowerCase()
    const countKind = trendingCountKind()
    const results = (await trendingTags(50))
      .filter(trend => trend.hashtag.includes(needle))
      .map(trend => toTagDTO(trend.hashtag, trend.postCount, countKind))
    if (STORAGE_TAG.test(needle) && !results.some(result => result.tag === needle)) {
      const postCount = await hashtagService.getPostCountByHashtag(needle)
      if (postCount > 0) results.unshift(toTagDTO(needle, postCount, 'posts'))
    }
    return results
  },

  /**
   * Web's post search: a substring match over the newest 100 timeline posts
   * (there is no server-side post search), tombstones and blocked authors
   * left out.
   */
  async searchPosts(query: string): Promise<PostDTO[]> {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const { documents } = await postService.getTimeline({ limit: 100 })
    const matches = documents.filter(post => !post.deleted && post.content.toLowerCase().includes(needle))
    return listToDTOs(matches.map(withLoadingAuthor))
  },
}
