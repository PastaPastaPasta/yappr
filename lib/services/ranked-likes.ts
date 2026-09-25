/**
 * Proved top-K like rankings — the v9 `documents.ranked()` surface.
 *
 * The v9 contract's indexOnly `like` doctype declares the full ranked chain
 * (`countable` → `rangeCountable` → `rankedCountable`) on three axes, each
 * grouped by `postId`:
 *
 * - global:          `byPost [postId]`                 — no pins
 * - per-hashtag:     `byHashtagPost [hashtag, postId]` — pin `['hashtag','==',tag]`
 * - per-author:      `byAuthorPost [postAuthor, postId]` — pin `['postAuthor','==',id]`
 *
 * Server-side `SELECT count(*) GROUP BY postId ORDER BY count DESC LIMIT n`,
 * O(log n + k) with a proof — no scan, no client-side sorting.
 *
 * Zero-count groups are filtered here as a guard: a ranked page on a
 * PREALLOCATED index would carry one for every post (the v9 like indexes are
 * not preallocated, so none are expected). `groupValue` arrives base58 for
 * identifier group keys and `value` is a bigint.
 *
 * v9 only: on v2 the like doctype declares no ranked axes and the node refuses
 * the query. Callers gate on `likesAreIndexOnly()`.
 *
 * The same surface serves PREFIX-level rankings (`rankedCountable: {at:…}`
 * at-form): see {@link rankedGroupCounts} and its wrappers below.
 */

import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { YAPPR_CONTRACT_ID } from '../constants';
import type { Post } from '../types';
import { getEvoSdk } from './evo-sdk-service';
import { WINDOWED_DAY_GRID, referencesMayDangle, windowedRankingsAvailable } from '../contract-topology';

/**
 * Which slice of time a ranking covers. `'all'` is the all-time axis;
 * `'today'` pins the current UTC-day bucket of the windowed twin ({@link windowedRankingsAvailable}) — the node resolves the
 * bucket from block time and the proof verifier re-derives it, so nothing
 * client-side chooses the window.
 */
export type RankingWindow = 'all' | 'today';

/**
 * The `timeRange` member for a windowed ranked query, or nothing for
 * all-time. Every v9 windowed index buckets `$createdAt` on the same daily
 * grid; naming it explicitly keeps the query unambiguous on doctypes that
 * carry more than one grid (`beat` also declares the k=4 rolling grid).
 */
function windowClause(window: RankingWindow): { timeRange: { field: string; selector: 'newest'; grid: { range: number; step: number } }[] } | Record<string, never> {
  if (window !== 'today') return {};
  return { timeRange: [{ field: '$createdAt', selector: 'newest', grid: { ...WINDOWED_DAY_GRID } }] };
}

/**
 * A ranked read on a bucket that no document has ever landed in (a cold UTC
 * day) fails proof generation on dev.8 instead of proving an empty ranking:
 * "a single-path axis read must produce exactly one axis descent … the walk
 * produced 0". Until upstream proves absence, that error IS the empty answer.
 * Shared with the blog contract's windowed rankings, which hit the same edge.
 */
export function isColdBucketError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /single-path axis read must produce exactly one axis descent/i.test(message);
}

export interface RankedLikedPost {
  /** The ranked group key — the liked post's id (base58). */
  postId: string;
  /** The proved like count. */
  likes: number;
}

export interface TopLikedPostsOptions {
  /** Pin the per-hashtag axis (`byHashtagPost`). Lowercase, no '#'. */
  hashtag?: string;
  /** Pin the per-author axis (`byAuthorPost`). Base58 identity id. */
  postAuthor?: string;
  /** 1..100, default 10. */
  limit?: number;
  /** `'today'` reads the v9 daily-windowed twin of the pinned axis; default `'all'`. */
  window?: RankingWindow;
  /** Reject failed reads so callers can retain an existing page and retry. */
  throwOnError?: boolean;
}

/**
 * The top posts by like count — global, per-hashtag, or per-author depending on
 * which pin is supplied (at most one; the axes are separate indexes).
 * Zero-count groups (preallocated like trees of never-liked posts) are
 * filtered. Returns `[]` on failure unless `throwOnError` is requested.
 */
export async function topLikedPosts(options: TopLikedPostsOptions = {}): Promise<RankedLikedPost[]> {
  const { hashtag, postAuthor, limit = 10, window = 'all' } = options;
  if (hashtag !== undefined && postAuthor !== undefined) {
    throw new Error('topLikedPosts: hashtag and postAuthor pin different indexes — pass at most one');
  }
  if (window === 'today' && !windowedRankingsAvailable()) return [];

  try {
    const sdk = await getEvoSdk();
    const where =
      hashtag !== undefined
        ? [['hashtag', '==', hashtag] as [string, '==', unknown]]
        : postAuthor !== undefined
          ? [['postAuthor', '==', postAuthor] as [string, '==', unknown]]
          : undefined;

    // Today's per-tag top lives on `beat.byDayHashtagPost` (like.hashtag is
    // optional and cannot sit below a bucket); every other axis has its
    // windowed twin on `like` itself.
    const documentTypeName = window === 'today' && hashtag !== undefined ? 'beat' : 'like';

    const result = await sdk.documents.ranked({
      dataContractId: YAPPR_CONTRACT_ID,
      documentTypeName,
      groupBy: 'postId',
      aggregate: { type: 'count' },
      direction: 'desc',
      limit,
      ...(where ? { where } : {}),
      ...windowClause(window),
    });

    return result.entries
      .filter((entry) => entry.value !== BigInt(0))
      .map((entry) => ({
        postId: typeof entry.groupValue === 'string' ? entry.groupValue : '',
        likes: Number(entry.value),
      }))
      .filter((entry) => entry.postId !== '');
  } catch (error) {
    if (window === 'today' && isColdBucketError(error)) return [];
    logger.error('topLikedPosts: ranked query failed:', error);
    if (options.throwOnError) throw error;
    return [];
  }
}

/** One group of a proved PREFIX-level ranking (v9 at-form axes). */
export interface RankedGroupCount {
  /** The group key: a hashtag (storage form) or a base58 identity id. */
  key: string;
  /** The proved count for the group. */
  count: number;
}

/**
 * A proved prefix-level ranked page: `documents.ranked()` with the groupBy at
 * a NON-terminal index level and no pins — the v9 at-form
 * (`rankedCountable: {at: …}`) surface, same request grammar as the terminal
 * rankings above minus the pin.
 *
 * v9 only. The calls are guarded fail-soft, so a node that cannot serve a
 * shape leaves the surface empty rather than failing the page. Callers gate on `prefixRankingsAvailable()` /
 * `followRankingsAvailable()`.
 *
 * Zero-count groups are filtered (preallocated group trees and fully drained
 * groups both report 0), as are group keys that failed to decode to the
 * expected type.
 */
async function rankedGroupCounts(
  documentTypeName: string,
  groupBy: string,
  limit: number,
  window: RankingWindow = 'all'
): Promise<RankedGroupCount[]> {
  if (window === 'today' && !windowedRankingsAvailable()) return [];
  try {
    const sdk = await getEvoSdk();
    const result = await sdk.documents.ranked({
      dataContractId: YAPPR_CONTRACT_ID,
      documentTypeName,
      groupBy,
      aggregate: { type: 'count' },
      direction: 'desc',
      limit,
      ...windowClause(window),
    });

    return result.entries
      .filter((entry) => entry.value !== BigInt(0))
      .map((entry) => ({
        key: typeof entry.groupValue === 'string' ? entry.groupValue : '',
        count: Number(entry.value),
      }))
      .filter((entry) => entry.key !== '');
  } catch (error) {
    if (window === 'today' && isColdBucketError(error)) return [];
    logger.error(`rankedGroupCounts(${documentTypeName}.${groupBy}): ranked query failed:`, error);
    return [];
  }
}

/**
 * The top hashtags by LIKE count — the proved v9 trending axis: prefix groupBy
 * at `hashtag` on `like.byHashtagPost {at: hashtag}`. The index is
 * `skipIfAbsent`, so untagged likes are structurally invisible here and no
 * "untagged bucket" group can appear.
 */
export async function topHashtagsByLikes(limit: number = 12, window: RankingWindow = 'all'): Promise<RankedGroupCount[]> {
  // Today's trending rides the tagged-only `beat` doctype (see topLikedPosts).
  return rankedGroupCounts(window === 'today' ? 'beat' : 'like', 'hashtag', limit, window);
}

/**
 * The top authors by likes RECEIVED — the v9 creator leaderboard: prefix
 * groupBy at `postAuthor` on `like.byAuthorPost {at: [postAuthor, postId]}`
 * (the same index whose terminal level serves the profile Top tab). Keys are
 * base58 identity ids.
 */
export async function topCreatorsByLikes(limit: number = 10, window: RankingWindow = 'all'): Promise<RankedGroupCount[]> {
  return rankedGroupCounts('like', 'postAuthor', limit, window);
}

/**
 * The most-followed identities — the v9 ranked chain on
 * `follow.followerCount [followingId]`. Keys are base58 identity ids.
 */
export async function mostFollowedUsers(limit: number = 10): Promise<RankedGroupCount[]> {
  return rankedGroupCounts('follow', 'followingId', limit);
}

export interface HydratedTopPostsOptions {
  postAuthor?: string;
  /** Pin the per-hashtag axis. Storage form (lowercase, no '#'), never `''`. */
  hashtag?: string;
  /** 1..100, default 20. */
  limit?: number;
  /** `'today'` reads the v9 daily-windowed twin; default `'all'`. */
  window?: RankingWindow;
  /** Skip the 60-second hydrated cache (an explicit user refresh). */
  force?: boolean;
  /** Reject failed ranking or hydration reads instead of returning an empty page. */
  throwOnError?: boolean;
}

/**
 * Rankings move slowly and every ranked page is a proved read, so hydrated
 * results are held for a minute per pin. Session-scoped: module state lives
 * exactly as long as the page load.
 */
const hydratedCache = new TtlMap<string, Post[]>(60_000);

/**
 * A ranked top-liked page hydrated into renderable posts: the proved ranking
 * from {@link topLikedPosts} (global `byPost`, or `byHashtagPost` when a tag is
 * pinned), fetched by id, re-ordered to the proved order with each post's
 * `likes` set to the proved count, then batch-enriched (authors, stats,
 * viewer interactions).
 *
 * Tombstoned posts are dropped after hydration: likes outlive tombstones (the
 * ranked axes keep counting a blanked post), but a deleted card has no place in
 * a "top posts" surface.
 *
 * v9 only, same as the underlying ranked query — callers gate on
 * `likesAreIndexOnly()`. Returns `[]` on failure unless `throwOnError` is requested.
 */
export async function topLikedPostsHydrated(options: HydratedTopPostsOptions = {}): Promise<Post[]> {
  const { hashtag, postAuthor, limit = 20, window = 'all', force = false, throwOnError = false } = options;
  if (hashtag === '') {
    // The '' group is the untagged bucket, not a tag — nothing should ask for it.
    logger.warn('topLikedPostsHydrated: refusing the empty hashtag group');
    return [];
  }

  const cacheKey = `${window}:${limit}:${postAuthor ? `author:${postAuthor}` : hashtag === undefined ? 'global' : `tag:${hashtag}`}`;
  return hydrateRankedCached(cacheKey, force, throwOnError, () =>
    topLikedPosts({ ...(postAuthor ? { postAuthor } : hashtag === undefined ? {} : { hashtag }), limit, window, throwOnError: true })
  );
}

export interface HydratedTopPostsByAuthorsOptions extends Omit<HydratedTopPostsOptions, 'hashtag'> {
  /** Base58 identity ids whose per-author rankings are merged; `limit` sizes the merged page. */
  authorIds: string[];
}

/**
 * At most this many authors are ranked for one merged page. No contract axis
 * ranks "posts by any of these authors" in one read, so the merge costs one
 * proved ranked read per author; the cap bounds that fan-out for accounts
 * that follow hundreds of people.
 */
export const TOP_BY_AUTHORS_MAX_AUTHORS = 100;
const TOP_BY_AUTHORS_CONCURRENCY = 8;

/**
 * The most-liked posts across a set of authors (the Following feed's Top
 * view): one proved `byAuthorPost` ranked read per author, merged and sorted
 * by proved like count, then hydrated like {@link topLikedPostsHydrated}.
 * Each author contributes at most `limit` candidates, so the merged page is
 * exact for the authors that were read. Authors beyond
 * {@link TOP_BY_AUTHORS_MAX_AUTHORS} are skipped.
 */
export async function topLikedPostsByAuthorsHydrated(options: HydratedTopPostsByAuthorsOptions): Promise<Post[]> {
  const { limit = 20, window = 'all', force = false, throwOnError = false } = options;
  // Sorted so the cache key is order-independent; above the cap this keeps a
  // fixed (alphabetical by id) subset rather than a different one per call.
  const authorIds = Array.from(new Set(options.authorIds)).sort().slice(0, TOP_BY_AUTHORS_MAX_AUTHORS);
  if (authorIds.length === 0) return [];

  const cacheKey = `${window}:${limit}:authors:${authorIds.join(',')}`;
  return hydrateRankedCached(cacheKey, force, throwOnError, async () => {
    const { mapLimit } = await import('./pagination-utils');
    const perAuthor = await mapLimit(authorIds, TOP_BY_AUTHORS_CONCURRENCY, (postAuthor) =>
      topLikedPosts({ postAuthor, limit, window, throwOnError: true })
    );
    return perAuthor
      .flat()
      .sort((a, b) => b.likes - a.likes)
      .slice(0, limit);
  });
}

/**
 * Serve a hydrated ranking from the 60-second cache, or run `rank` and
 * hydrate its result. `force` bypasses the cache read but still refills it.
 * Keys carry the page size, so callers asking for different limits never
 * share (and truncate) each other's page. `rank` must reject failed reads so
 * fail-soft callers cannot cache an empty or partial page for strict callers.
 */
async function hydrateRankedCached(
  cacheKey: string,
  force: boolean,
  throwOnError: boolean,
  rank: () => Promise<RankedLikedPost[]>
): Promise<Post[]> {
  const { getCurrentUserId } = await import('./sdk-helpers');
  const currentUserId = getCurrentUserId() ?? undefined;
  const viewerKey = `${currentUserId ?? 'anonymous'}:${cacheKey}`;
  const cached = force ? undefined : hydratedCache.get(viewerKey);
  if (cached) return cached;

  try {
    const ranked = await rank();
    const posts = await hydrateRankedPosts(ranked, currentUserId);
    hydratedCache.set(viewerKey, posts);
    return posts;
  } catch (error) {
    logger.error('topLikedPostsHydrated: hydration failed:', error);
    if (throwOnError) throw error;
    return [];
  }
}

/**
 * Turn a proved ranking into renderable posts through ONE composite by-id
 * page: the posts, their engagement counts, quoted posts, author profiles and
 * names (and, logged in, the viewer's marks) arrive under a single merged
 * proof. Re-ordered to the proved ranking with each post's `likes` set to the
 * proved count; absent ids and tombstones are dropped.
 *
 * Logged in, the viewer's block and follow status for the page's authors is
 * still two batch lookups: neither is a document of the page, and the cards'
 * relation hooks would otherwise fan out one query per author.
 */
async function hydrateRankedPosts(ranked: RankedLikedPost[], currentUserId?: string): Promise<Post[]> {
  if (ranked.length === 0) return [];

  // Dynamic: composite-feed-page imports the enrichment helpers, which import
  // the post service, which imports this module.
  const { loadCompositeFeedPage } = await import('@/lib/feed/composite-feed-page');
  const ids = ranked.map((entry) => entry.postId);

  const page = await loadCompositeFeedPage({
    language: 'en',
    limit: ids.length,
    documentIds: ids,
    currentUserId,
  });

  // A by-ids page proves the set exactly, so an id missing from it is
  // authoritatively absent. The contract's moderators may remove a post
  // while its like entries stay, so a hole in a ranked page is expected and
  // just drops out of the list.
  const provenIds = new Set(page.rawPosts.map((doc) => doc.$id));
  const missing = ranked.filter((entry) => !provenIds.has(entry.postId));
  if (missing.length > 0 && !referencesMayDangle()) {
    logger.warn(
      'topLikedPostsHydrated: ranked ids proved absent (posts should be tombstoned, never removed):',
      missing.map((entry) => entry.postId)
    );
  }

  // Preserve the proved ranking order; carry the proved count onto the card;
  // author identity comes off the page's proven profile and name lookups.
  const byId = new Map(page.posts.map((post) => [post.id, post]));
  const { usernames, profiles, avatars } = page.preloaded;
  const ordered = ranked.flatMap((entry) => {
    const post = byId.get(entry.postId);
    if (!post) return [];
    const authorId = post.author.id;
    const username = usernames?.get(authorId) ?? undefined;
    const avatar = avatars?.get(authorId) ?? '';
    return [{
      ...post,
      likes: entry.likes,
      author: {
        ...post.author,
        username: username || post.author.username,
        displayName: profiles?.get(authorId)?.displayName || post.author.displayName,
        avatar: avatar || post.author.avatar,
        hasDpns: Boolean(username),
      },
      _enrichment: {
        ...post._enrichment,
        authorIsBlocked: false,
        authorIsFollowing: false,
        authorAvatarUrl: avatar,
      },
    }];
  });

  if (!currentUserId || ordered.length === 0) return ordered;

  const [{ blockService }, { followService }, { blockStatusCache, followStatusCache }] = await Promise.all([
    import('./block-service'),
    import('./follow-service'),
    import('../caches/user-status-cache'),
  ]);
  const authorIds = Array.from(new Set(ordered.map((post) => post.author.id)));
  const [blocked, following] = await Promise.all([
    blockService.checkBlockedBatch(currentUserId, authorIds),
    followService.getFollowStatusBatch(authorIds, currentUserId),
  ]);
  blockStatusCache.seed(currentUserId, blocked);
  followStatusCache.seed(currentUserId, following);
  return ordered.map((post) => ({
    ...post,
    _enrichment: {
      ...post._enrichment,
      authorIsBlocked: blocked.get(post.author.id) ?? false,
      authorIsFollowing: following.get(post.author.id) ?? false,
    },
  }));
}
