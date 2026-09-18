/**
 * Proved blog rankings on the v2 blog contract.
 *
 * Each read here is one DAPI request against a ranked count tree
 * (docs/BLOG_V2.md): "most followed blogs" and "trending today" ride
 * `blogFollow.followerCount [blogId]` / `followersByDay [$createdAt, blogId]`,
 * "most discussed posts" rides `blogComment.commentCount [blogPostId]` —
 * replacing the crawl-every-blog discovery the v1 client did.
 *
 * v2-only: on v1 those axes do not exist and the node refuses the query, so
 * every entry point returns an empty page when {@link blogIsV2} is false.
 */

import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { DOCUMENT_TYPES, YAPPR_BLOG_CONTRACT_ID, blogIsV2 } from '../constants';
import { getEvoSdk } from './evo-sdk-service';

const RANKING_TTL_MS = 60 * 1000;

/** The daily grid `followersByDay` buckets on (contract `timeRange` range/step). */
const DAY_GRID = { range: 86400, step: 86400 } as const;

/**
 * A ranked read on a bucket no document ever landed in (a cold UTC day) fails
 * proof generation instead of proving an empty ranking. Until upstream proves
 * absence, that error IS the empty answer — same handling as the social
 * contract's windowed rankings (lib/services/ranked-likes.ts).
 */
function isColdBucketError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /single-path axis read must produce exactly one axis descent/i.test(message);
}

/** One group of a proved ranking. */
export interface RankedBlogEntry {
  /** The group key: a blog id or a blog post id (base58). */
  id: string;
  /** The proved document count for the group (followers, or comments). */
  count: number;
}

class BlogStatsService {
  private readonly rankings = new TtlMap<string, RankedBlogEntry[]>(RANKING_TTL_MS);

  /** Drop every cached ranking (call after a follow or a comment lands). */
  invalidate(): void {
    this.rankings.clear();
  }

  private async rankedPage(
    key: string,
    query: {
      documentTypeName: string;
      groupBy: string;
      limit: number;
      windowed?: boolean;
    }
  ): Promise<RankedBlogEntry[]> {
    if (!blogIsV2()) return [];
    const cached = this.rankings.get(key);
    if (cached) return cached;
    try {
      const sdk = await getEvoSdk();
      const result = await sdk.documents.ranked({
        dataContractId: YAPPR_BLOG_CONTRACT_ID,
        documentTypeName: query.documentTypeName,
        groupBy: query.groupBy,
        aggregate: { type: 'count' },
        direction: 'desc',
        limit: query.limit,
        ...(query.windowed
          ? { timeRange: [{ field: '$createdAt', selector: 'newest', grid: { ...DAY_GRID } }] }
          : {}),
      });
      const entries = result.entries
        .filter((entry) => entry.value > 0n && typeof entry.groupValue === 'string')
        .map((entry) => ({ id: entry.groupValue as string, count: Number(entry.value) }));
      this.rankings.set(key, entries);
      return entries;
    } catch (error) {
      if (query.windowed && isColdBucketError(error)) return [];
      logger.error(`blogStats: ranked ${query.documentTypeName}.${query.groupBy} failed`, error);
      return [];
    }
  }

  /** Blogs ranked by follower count, all time (`followerCount`). */
  mostFollowedBlogs(limit = 20): Promise<RankedBlogEntry[]> {
    return this.rankedPage(`blogs:followers:${limit}`, {
      documentTypeName: DOCUMENT_TYPES.BLOG_FOLLOW, groupBy: 'blogId', limit,
    });
  }

  /** Blogs ranked by followers gained TODAY (`followersByDay`, current bucket). */
  trendingBlogs(limit = 20): Promise<RankedBlogEntry[]> {
    return this.rankedPage(`blogs:today:${limit}`, {
      documentTypeName: DOCUMENT_TYPES.BLOG_FOLLOW, groupBy: 'blogId', limit, windowed: true,
    });
  }

  /** Posts ranked by comment count (`commentCount`). */
  mostDiscussedPosts(limit = 20): Promise<RankedBlogEntry[]> {
    return this.rankedPage(`posts:comments:${limit}`, {
      documentTypeName: DOCUMENT_TYPES.BLOG_COMMENT, groupBy: 'blogPostId', limit,
    });
  }
}

export const blogStatsService = new BlogStatsService();
