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
