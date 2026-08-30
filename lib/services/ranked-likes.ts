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
 */

import { logger } from '@/lib/logger';
import { YAPPR_CONTRACT_ID } from '../constants';
import type { Post } from '../types';
import { getEvoSdk } from './evo-sdk-service';

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
}

/**
 * The top posts by like count — global, per-hashtag, or per-author depending on
 * which pin is supplied (at most one; the axes are separate indexes).
 * Zero-count groups (preallocated like trees of never-liked posts) are
 * filtered. Returns `[]` on failure — ranking surfaces degrade to empty.
 */
export async function topLikedPosts(options: TopLikedPostsOptions = {}): Promise<RankedLikedPost[]> {
  const { hashtag, postAuthor, limit = 10 } = options;
  if (hashtag !== undefined && postAuthor !== undefined) {
    throw new Error('topLikedPosts: hashtag and postAuthor pin different indexes — pass at most one');
  }

  try {
    const sdk = await getEvoSdk();
    const where =
      hashtag !== undefined
        ? [['hashtag', '==', hashtag] as [string, '==', unknown]]
        : postAuthor !== undefined
          ? [['postAuthor', '==', postAuthor] as [string, '==', unknown]]
          : undefined;

    const result = await sdk.documents.ranked({
      dataContractId: YAPPR_CONTRACT_ID,
      documentTypeName: 'like',
      groupBy: 'postId',
      aggregate: { type: 'count' },
      direction: 'desc',
      limit,
      ...(where ? { where } : {}),
    });

    return result.entries
      .filter((entry) => entry.value !== BigInt(0))
      .map((entry) => ({
        postId: typeof entry.groupValue === 'string' ? entry.groupValue : '',
        likes: Number(entry.value),
      }))
      .filter((entry) => entry.postId !== '');
  } catch (error) {
    logger.error('topLikedPosts: ranked query failed:', error);
    return [];
  }
}

export interface HydratedTopPostsOptions {
  /** Pin the per-hashtag axis. Storage form (lowercase, no '#'), never `''`. */
  hashtag?: string;
  /** 1..100, default 20. */
  limit?: number;
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
  const { hashtag, limit = 20 } = options;
  if (hashtag === '') {
    // The '' group is the untagged bucket, not a tag — nothing should ask for it.
    logger.warn('topLikedPostsHydrated: refusing the empty hashtag group');
    return [];
  }

  const cacheKey = hashtag === undefined ? 'global' : `tag:${hashtag}`;
  const cached = hydratedCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < HYDRATED_CACHE_TTL_MS) {
    return cached.posts;
  }

  try {
    const ranked = await topLikedPosts(hashtag === undefined ? { limit } : { hashtag, limit });

    let posts: Post[] = [];
    if (ranked.length > 0) {
      const { postService } = await import('./post-service');
      const fetched = await postService.getPostsByIds(ranked.map((entry) => entry.postId));
      const byId = new Map(fetched.map((post) => [post.id, post]));

      // Preserve the proved ranking order; carry the proved count onto the
      // card; drop ids that failed to load and tombstones.
      const ordered = ranked
        .map((entry) => {
          const post = byId.get(entry.postId);
          return post ? { ...post, likes: entry.likes } : undefined;
        })
        .filter((post): post is Post => post !== undefined && post.deleted !== true);

      posts = await postService.enrichPostsBatch(ordered);
    }

    hydratedCache.set(cacheKey, { posts, timestamp: Date.now() });
    return posts;
  } catch (error) {
    logger.error('topLikedPostsHydrated: hydration failed:', error);
    return [];
  }
}
