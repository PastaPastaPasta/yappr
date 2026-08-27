import { logger } from '@/lib/logger';
import {
  bookmarkIndexFor,
  groupByInteractionSurface,
  repostIndexFor,
  type KindedTarget,
} from '@/lib/contract-topology';
import type { PostStats } from './post-service';

export interface PostInteractionState {
  liked: boolean;
  reposted: boolean;
  bookmarked: boolean;
}

const STATS_CACHE_TTL_MS = 60_000;

/**
 * Stats and interactions are cached and deduplicated per (surface, id): a `post`
 * id and a `reply` id are drawn from the same keyspace but, on the v3 topology,
 * are answered by different doctypes.
 */
function statsCacheKey(target: KindedTarget): string {
  return `${target.kind}:${target.id}`;
}

export async function fetchPostStats(
  target: KindedTarget,
  statsCache: Map<string, { data: PostStats; timestamp: number }>
): Promise<PostStats> {
  const { id: postId, kind } = target;
  const cacheKey = statsCacheKey(target);
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < STATS_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const [{ likeService }, { repostService }, { replyService }, { postService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./reply-service'),
      import('./post-service'),
    ]);

    const [likes, reposts, replies, quotes] = await Promise.all([
      likeService.countLikes(postId, kind),
      // A kind the topology forbids reposting has no repost doctype to count.
      repostIndexFor(kind) ? repostService.countReposts(postId) : Promise.resolve(0),
      // Polymorphic on v2 (one `parentId` count tree serves both kinds); on v3 a
      // post counts its whole thread and a reply its direct children.
      replyService.countReplies(postId, kind),
      postService.countQuotes(postId, kind),
    ]);

    const stats: PostStats = {
      postId,
      likes,
      reposts,
      replies,
      quotes,
      views: 0,
    };

    statsCache.set(cacheKey, {
      data: stats,
      timestamp: Date.now(),
    });

    return stats;
  } catch (error) {
    logger.error('Error getting post stats:', error);
    return { postId, likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0 };
  }
}

export async function fetchUserInteractions(
  target: KindedTarget,
  currentUserId: string | null
): Promise<PostInteractionState> {
  if (!currentUserId) {
    return { liked: false, reposted: false, bookmarked: false };
  }

  const { id: postId, kind } = target;

  try {
    const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./bookmark-service'),
    ]);

    // Kinds the topology forbids reposting/bookmarking have no document to look
    // for, so those queries are skipped rather than pointed at the wrong doctype.
    const [liked, reposted, bookmarked] = await Promise.all([
      likeService.isLiked(postId, currentUserId, kind),
      repostIndexFor(kind) ? repostService.isReposted(postId, currentUserId) : Promise.resolve(false),
      bookmarkIndexFor(kind) ? bookmarkService.isBookmarked(postId, currentUserId) : Promise.resolve(false),
    ]);

    return { liked, reposted, bookmarked };
  } catch (error) {
    logger.error('Error getting user interactions:', error);
    return { liked: false, reposted: false, bookmarked: false };
  }
}

export async function fetchBatchUserInteractions(
  targets: readonly KindedTarget[],
  currentUserId: string
): Promise<Map<string, PostInteractionState>> {
  const result = new Map<string, PostInteractionState>();

  targets.forEach(({ id }) => {
    result.set(id, { liked: false, reposted: false, bookmarked: false });
  });

  if (targets.length === 0) {
    return result;
  }

  try {
    const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./bookmark-service'),
    ]);

    // One pass per distinct interaction surface. On v2 both kinds share one
    // surface, so this is a single pass over every id — the same three queries
    // the pre-topology code issued.
    await Promise.all(
      groupByInteractionSurface(targets).map(async ({ kind, ids }) => {
        // Query only the CURRENT user's own likes/reposts (bounded by page size
        // via the composite indexes) instead of fetching all users' likes capped
        // at 100 and filtering client-side — which could miss the user's own on
        // busy pages.
        const [likedPostIds, repostedPostIds, userBookmarks] = await Promise.all([
          likeService.getUserLikedPostIds(currentUserId, ids, kind),
          repostIndexFor(kind)
            ? repostService.getUserRepostedPostIds(currentUserId, ids)
            : Promise.resolve(new Set<string>()),
          bookmarkIndexFor(kind)
            ? bookmarkService.getUserBookmarksForPosts(currentUserId, ids)
            : Promise.resolve([]),
        ]);

        const bookmarkedPostIds = new Set(userBookmarks.map((bookmark) => bookmark.postId));

        ids.forEach((postId) => {
          result.set(postId, {
            liked: likedPostIds.has(postId),
            reposted: repostedPostIds.has(postId),
            bookmarked: bookmarkedPostIds.has(postId),
          });
        });
      })
    );
  } catch (error) {
    logger.error('Error getting batch user interactions:', error);
  }

  return result;
}

export async function fetchBatchPostStats(targets: readonly KindedTarget[]): Promise<Map<string, PostStats>> {
  const result = new Map<string, PostStats>();

  targets.forEach(({ id }) => {
    result.set(id, { postId: id, likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0 });
  });

  if (targets.length === 0) {
    return result;
  }

  try {
    const [{ likeService }, { repostService }, { replyService }, { postService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./reply-service'),
      import('./post-service'),
    ]);

    // One grouped count-tree query per stat type (no 100-cap undercount the old
    // batched `in`-queries had once a page collectively exceeded ~100
    // engagements) instead of 3xN per-post reads; each transparently falls
    // back to per-post reads if the grouped response doesn't decode as expected.
    //
    // Grouped once per interaction surface: on v2 that is a single group holding
    // every id, so the query count is unchanged.
    await Promise.all(
      groupByInteractionSurface(targets).map(async ({ kind, ids }) => {
        const [likeCounts, repostCounts, replyCounts, quoteCounts] = await Promise.all([
          likeService.countLikesForPosts(ids, kind),
          repostIndexFor(kind)
            ? repostService.countRepostsForPosts(ids)
            : Promise.resolve(new Map<string, number>()),
          // Per-kind count tree — see fetchPostStats.
          replyService.countRepliesForPosts(ids, kind),
          postService.countQuotesForPosts(ids, kind),
        ]);

        ids.forEach((id) => {
          const stats = result.get(id);
          if (stats) {
            stats.likes = likeCounts.get(id) ?? 0;
            stats.reposts = repostCounts.get(id) ?? 0;
            stats.replies = replyCounts.get(id) ?? 0;
            stats.quotes = quoteCounts.get(id) ?? 0;
          }
        });
      })
    );
  } catch (error) {
    logger.error('Error getting batch post stats:', error);
  }

  return result;
}
