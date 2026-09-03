/**
 * Proved top-K like rankings — the v4 `documents.ranked()` surface.
 *
 * The v4 contract's indexOnly `like` doctype declares the full ranked chain
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
 * Gotcha carried from the Phase 1/2 batteries: ranked pages on PREALLOCATED
 * indexes include zero-count groups (the post insert creates the like trees, so
 * every post exists in the ranking at count 0) — callers get them filtered here.
 * `groupValue` arrives base58 for identifier group keys and `value` is a bigint.
 *
 * v4-only: on v2/v3 the like doctypes declare no ranked axes and the node
 * refuses the query. Callers gate on `likesAreIndexOnly()`.
 *
 * v5 adds PREFIX-level rankings on the same surface (`rankedCountable: {at:…}`
 * at-form): see {@link rankedGroupCounts} and its wrappers below.
 */

import { logger } from '@/lib/logger';
import { YAPPR_CONTRACT_ID } from '../constants';
import type { Post } from '../types';
import { getEvoSdk } from './evo-sdk-service';
import { WINDOWED_DAY_GRID, windowedRankingsAvailable } from '../contract-topology';

/**
 * Which slice of time a ranking covers. `'all'` is the all-time axis every
 * topology from v4 up serves; `'today'` pins the current UTC-day bucket of the
 * v6 windowed twin ({@link windowedRankingsAvailable}) — the node resolves the
 * bucket from block time and the proof verifier re-derives it, so nothing
 * client-side chooses the window.
 */
export type RankingWindow = 'all' | 'today';

/**
 * The `timeRange` member for a windowed ranked query, or nothing for
 * all-time. Every v6 windowed index buckets `$createdAt` on the same daily
 * grid; naming it explicitly keeps the query unambiguous on doctypes that
 * carry more than one grid (`beat` also declares the k=4 rolling grid).
 */
function windowClause(window: RankingWindow): { timeRange: { field: string; selector: 'newest'; grid: { range: number; step: number } }[] } | Record<string, never> {
  if (window !== 'today') return {};
  return { timeRange: [{ field: '$createdAt', selector: 'newest', grid: { ...WINDOWED_DAY_GRID } }] };
}

/**
 * A ranked read on a v6 bucket that no document has ever landed in (a cold
 * UTC day) fails proof generation on dev.8 instead of proving an empty
 * ranking: "a single-path axis read must produce exactly one axis descent …
 * the walk produced 0". Until upstream proves absence, that error IS the
 * empty answer.
 */
function isColdBucketError(error: unknown): boolean {
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
  /** `'today'` reads the v6 daily-windowed twin of the pinned axis; default `'all'`. */
  window?: RankingWindow;
}

/**
 * The top posts by like count — global, per-hashtag, or per-author depending on
 * which pin is supplied (at most one; the axes are separate indexes).
 * Zero-count groups (preallocated like trees of never-liked posts) are
 * filtered. Returns `[]` on failure — ranking surfaces degrade to empty.
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
    return [];
  }
}

/** One group of a proved PREFIX-level ranking (v5 at-form axes). */
export interface RankedGroupCount {
  /** The group key: a hashtag (storage form) or a base58 identity id. */
  key: string;
  /** The proved count for the group. */
  count: number;
}

/**
 * A proved prefix-level ranked page: `documents.ranked()` with the groupBy at
 * a NON-terminal index level and no pins — the v5 at-form
 * (`rankedCountable: {at: …}`) surface, same request grammar as the terminal
 * rankings above minus the pin.
 *
 * v5-only, and additionally requires a dev.7+ node (and a dev.7 wasm for
 * proof verification of these shapes) — the calls are written to the known
 * grammar and guarded fail-soft, so on anything older the surfaces simply
 * come back empty. Callers gate on `prefixRankingsAvailable()` /
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
 * The top hashtags by LIKE count — the proved v5 trending axis: prefix groupBy
 * at `hashtag` on `like.byHashtagPost {at: hashtag}`. The index is
 * `skipIfAbsent`, so untagged likes are structurally invisible here and no
 * "untagged bucket" group can appear.
 */
export async function topHashtagsByLikes(limit: number = 12, window: RankingWindow = 'all'): Promise<RankedGroupCount[]> {
  // Today's trending rides the tagged-only `beat` doctype (see topLikedPosts).
  return rankedGroupCounts(window === 'today' ? 'beat' : 'like', 'hashtag', limit, window);
}

/**
 * The top authors by likes RECEIVED — the v5 creator leaderboard: prefix
 * groupBy at `postAuthor` on `like.byAuthorPost {at: [postAuthor, postId]}`
 * (the same index whose terminal level serves the profile Top tab). Keys are
 * base58 identity ids.
 */
export async function topCreatorsByLikes(limit: number = 10, window: RankingWindow = 'all'): Promise<RankedGroupCount[]> {
  return rankedGroupCounts('like', 'postAuthor', limit, window);
}

/**
 * The most-followed identities — the v5 ranked chain on
 * `follow.followerCount [followingId]`. Keys are base58 identity ids.
 */
export async function mostFollowedUsers(limit: number = 10): Promise<RankedGroupCount[]> {
  return rankedGroupCounts('follow', 'followingId', limit);
}

export interface HydratedTopPostsOptions {
  /** Pin the per-hashtag axis. Storage form (lowercase, no '#'), never `''`. */
  hashtag?: string;
  /** 1..100, default 20. */
  limit?: number;
  /** `'today'` reads the v6 daily-windowed twin; default `'all'`. */
  window?: RankingWindow;
  /** Skip the 60-second hydrated cache (an explicit user refresh). */
  force?: boolean;
}

/**
 * Rankings move slowly and every ranked page is a proved read, so hydrated
 * results are held for a minute per pin. Session-scoped: module state lives
 * exactly as long as the page load.
 */
const HYDRATED_CACHE_TTL_MS = 60_000;
const hydratedCache = new Map<string, { posts: Post[]; timestamp: number }>();

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
 * v4-only, same as the underlying ranked query — callers gate on
 * `likesAreIndexOnly()`. Returns `[]` on failure.
 */
export async function topLikedPostsHydrated(options: HydratedTopPostsOptions = {}): Promise<Post[]> {
  const { hashtag, limit = 20, window = 'all', force = false } = options;
  if (hashtag === '') {
    // The '' group is the untagged bucket, not a tag — nothing should ask for it.
    logger.warn('topLikedPostsHydrated: refusing the empty hashtag group');
    return [];
  }

  const cacheKey = `${window}:${hashtag === undefined ? 'global' : `tag:${hashtag}`}`;
  return hydrateRankedCached(cacheKey, force, () =>
    topLikedPosts(hashtag === undefined ? { limit, window } : { hashtag, limit, window })
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
  const { limit = 20, window = 'all', force = false } = options;
  const authorIds = Array.from(new Set(options.authorIds)).sort().slice(0, TOP_BY_AUTHORS_MAX_AUTHORS);
  if (authorIds.length === 0) return [];

  const cacheKey = `${window}:authors:${authorIds.join(',')}`;
  return hydrateRankedCached(cacheKey, force, async () => {
    const { mapLimit } = await import('./pagination-utils');
    const perAuthor = await mapLimit(authorIds, TOP_BY_AUTHORS_CONCURRENCY, (postAuthor) =>
      topLikedPosts({ postAuthor, limit, window })
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
 */
async function hydrateRankedCached(
  cacheKey: string,
  force: boolean,
  rank: () => Promise<RankedLikedPost[]>
): Promise<Post[]> {
  const cached = hydratedCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.timestamp < HYDRATED_CACHE_TTL_MS) {
    return cached.posts;
  }

  try {
    const ranked = await rank();
    const posts = await hydrateRankedPosts(ranked);
    hydratedCache.set(cacheKey, { posts, timestamp: Date.now() });
    return posts;
  } catch (error) {
    logger.error('topLikedPostsHydrated: hydration failed:', error);
    return [];
  }
}

/**
 * Turn a proved ranking into renderable posts: fetch by id, re-order to the
 * proved order with each post's `likes` set to the proved count, drop absent
 * ids and tombstones, then batch-enrich (authors, stats, viewer interactions).
 */
async function hydrateRankedPosts(ranked: RankedLikedPost[]): Promise<Post[]> {
  if (ranked.length === 0) return [];

  const { postService } = await import('./post-service');
  // skipEnrichment: enrichPostsBatch below resolves authors in batch —
  // per-post DPNS/profile lookups here would be thrown-away duplicates.
  const fetched = await postService.getPostsByIds(
    ranked.map((entry) => entry.postId),
    { skipEnrichment: true }
  );
  const byId = new Map(fetched.map((post) => [post.id, post]));

  // getPostsByIds hydrates via one proved $id-in query, so an id missing
  // from the batch is authoritatively absent, not a suspected transient
  // failure (query errors degrade to per-id fetches inside getPostsByIds
  // rather than silently shrinking the page). Posts are tombstoned by
  // edit, never removed, so a genuinely missing ranked id is an anomaly
  // worth noting — but not a reason to withhold the page from the
  // 60-second cache.
  const missing = ranked.filter((entry) => !byId.has(entry.postId));
  if (missing.length > 0) {
    logger.warn(
      'topLikedPostsHydrated: ranked ids proved absent (posts should be tombstoned, never removed):',
      missing.map((entry) => entry.postId)
    );
  }

  // Preserve the proved ranking order; carry the proved count onto the
  // card; drop absent ids and tombstones.
  const ordered = ranked
    .map((entry) => {
      const post = byId.get(entry.postId);
      return post ? { ...post, likes: entry.likes } : undefined;
    })
    .filter((post): post is Post => post !== undefined && post.deleted !== true);

  return postService.enrichPostsBatch(ordered);
}
