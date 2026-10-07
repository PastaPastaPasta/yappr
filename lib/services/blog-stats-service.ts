/**
 * Proved blog rankings on the v2+ blog contract.
 *
 * Each read here is one DAPI request against a ranked count tree
 * (docs/NON_SOCIAL_CONTRACTS.md):
 *
 * - "most followed blogs": `blogFollow.followerCount [blogId]` up to v6, the
 *   merged `followers [blogId, $createdAt]` ranked at `blogId` on v7 (the
 *   same `groupBy: 'blogId'` query);
 * - "trending blogs": `followersByDay [$createdAt, blogId]` on a daily grid up
 *   to v6 ("today"), v7's `followersTrend` on a 72h window that rolls every
 *   24h ("3 days");
 * - "most discussed posts": the all-time `blogComment.commentCount
 *   [blogPostId]` up to v6, v7's `discussedRecent [$createdAt, blogPostId]`
 *   on the same 72h window (v7 has no all-time comment ranking).
 *
 * The v7 grids are read off the committed contract (lib/blog/blog-contract.ts).
 * v2-only: on v1 those axes do not exist and the node refuses the query, so
 * every entry point returns an empty page when {@link blogIsV2} is false.
 */

import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { DOCUMENT_TYPES, YAPPR_BLOG_CONTRACT_ID, blogIsV2, blogIsV7 } from '../constants';
import { blogTrendWindow, type BlogTrendWindow } from '../blog/blog-contract';
import { getEvoSdk } from './evo-sdk-service';
import { isColdBucketError, windowClause } from './ranked-likes';

const RANKING_TTL_MS = 60 * 1000;

/** The daily grid v2–v6's `followersByDay` buckets on (contract `timeRange` range/step). */
const DAY_WINDOW: BlogTrendWindow = { grid: { range: 86400, step: 86400 }, selector: 'newest' };

/** One group of a proved ranking. */
export interface RankedBlogEntry {
  /** The group key: a blog id or a blog post id (base58). */
  id: string;
  /** The proved document count for the group (followers, or comments). */
  count: number;
}

/** How the trending-blogs ranking is named on the configured cut, and what it says when empty. */
export function trendingBlogsCopy(): { label: string; empty: string } {
  return blogIsV7()
    ? { label: 'Trending (3 days)', empty: 'No blog gained a follower in the last 3 days.' }
    : { label: 'Trending today', empty: 'No blog gained a follower today.' };
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
      window?: BlogTrendWindow;
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
        ...windowClause(query.window ?? null),
      });
      const entries = result.entries
        .filter((entry) => entry.value > 0n && typeof entry.groupValue === 'string')
        .map((entry) => ({ id: entry.groupValue as string, count: Number(entry.value) }));
      this.rankings.set(key, entries);
      return entries;
    } catch (error) {
      if (query.window && isColdBucketError(error)) return [];
      logger.error(`blogStats: ranked ${query.documentTypeName}.${query.groupBy} failed`, error);
      return [];
    }
  }

  /** Blogs ranked by follower count, all time (`followerCount`; v7 `followers`). */
  mostFollowedBlogs(limit = 20): Promise<RankedBlogEntry[]> {
    return this.rankedPage(`blogs:followers:${limit}`, {
      documentTypeName: DOCUMENT_TYPES.BLOG_FOLLOW, groupBy: 'blogId', limit,
    });
  }

  /** Blogs ranked by followers gained recently: today up to v6, the last ~3 days on v7 ({@link trendingBlogsCopy}). */
  trendingBlogs(limit = 20): Promise<RankedBlogEntry[]> {
    return this.rankedPage(`blogs:trending:${limit}`, {
      documentTypeName: DOCUMENT_TYPES.BLOG_FOLLOW, groupBy: 'blogId', limit,
      window: blogIsV7() ? blogTrendWindow('followers') : DAY_WINDOW,
    });
  }

  /** Posts ranked by comment count: all time up to v6 (`commentCount`), the last ~3 days on v7 (`discussedRecent`). */
  mostDiscussedPosts(limit = 20): Promise<RankedBlogEntry[]> {
    return this.rankedPage(`posts:comments:${limit}`, {
      documentTypeName: DOCUMENT_TYPES.BLOG_COMMENT, groupBy: 'blogPostId', limit,
      ...(blogIsV7() ? { window: blogTrendWindow('comments') } : {}),
    });
  }
}

export const blogStatsService = new BlogStatsService();
