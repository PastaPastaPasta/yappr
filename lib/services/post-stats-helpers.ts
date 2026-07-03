import { logger } from '@/lib/logger';
import type { PostStats } from './post-service';

export interface PostInteractionState {
  liked: boolean;
  reposted: boolean;
  bookmarked: boolean;
}

const STATS_CACHE_TTL_MS = 60_000;

export async function fetchPostStats(
  postId: string,
  statsCache: Map<string, { data: PostStats; timestamp: number }>
): Promise<PostStats> {
  const cached = statsCache.get(postId);
  if (cached && Date.now() - cached.timestamp < STATS_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const countLikes = async (): Promise<number> => {
      const { likeService } = await import('./like-service');
      return likeService.countLikes(postId);
    };

    const countReposts = async (): Promise<number> => {
      const { repostService } = await import('./repost-service');
      return repostService.countReposts(postId);
    };

    const countReplies = async (): Promise<number> => {
      const { replyService } = await import('./reply-service');
      return replyService.countReplies(postId);
    };

    const countQuotes = async (): Promise<number> => {
      const { postService } = await import('./post-service');
      return postService.countQuotes(postId);
    };

    const [likes, reposts, replies, quotes] = await Promise.all([
      countLikes(),
      countReposts(),
      countReplies(),
      countQuotes(),
    ]);

    const stats: PostStats = {
      postId,
      likes,
      reposts,
      replies,
      quotes,
      views: 0,
    };

    statsCache.set(postId, {
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
  postId: string,
  currentUserId: string | null
): Promise<PostInteractionState> {
  if (!currentUserId) {
    return { liked: false, reposted: false, bookmarked: false };
  }

  try {
    const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./bookmark-service'),
    ]);

    const [liked, reposted, bookmarked] = await Promise.all([
      likeService.isLiked(postId, currentUserId),
      repostService.isReposted(postId, currentUserId),
      bookmarkService.isBookmarked(postId, currentUserId),
    ]);

    return { liked, reposted, bookmarked };
  } catch (error) {
    logger.error('Error getting user interactions:', error);
    return { liked: false, reposted: false, bookmarked: false };
  }
}

export async function fetchBatchUserInteractions(
  postIds: string[],
  currentUserId: string
): Promise<Map<string, PostInteractionState>> {
  const result = new Map<string, PostInteractionState>();

  postIds.forEach((id) => {
    result.set(id, { liked: false, reposted: false, bookmarked: false });
  });

  if (postIds.length === 0) {
    return result;
  }

  try {
    const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./bookmark-service'),
    ]);

    // Query only the CURRENT user's own likes/reposts (bounded by page size via
    // the composite indexes) instead of fetching all users' likes capped at 100
    // and filtering client-side — which could miss the user's own on busy pages.
    const [likedPostIds, repostedPostIds, userBookmarks] = await Promise.all([
      likeService.getUserLikedPostIds(currentUserId, postIds),
      repostService.getUserRepostedPostIds(currentUserId, postIds),
      bookmarkService.getUserBookmarksForPosts(currentUserId, postIds),
    ]);

    const bookmarkedPostIds = new Set(userBookmarks.map((bookmark) => bookmark.postId));

    postIds.forEach((postId) => {
      result.set(postId, {
        liked: likedPostIds.has(postId),
        reposted: repostedPostIds.has(postId),
        bookmarked: bookmarkedPostIds.has(postId),
      });
    });
  } catch (error) {
    logger.error('Error getting batch user interactions:', error);
  }

  return result;
}

export async function fetchBatchPostStats(postIds: string[]): Promise<Map<string, PostStats>> {
  const result = new Map<string, PostStats>();

  postIds.forEach((id) => {
    result.set(id, { postId: id, likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0 });
  });

  if (postIds.length === 0) {
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
    const [likeCounts, repostCounts, replyCounts, quoteCounts] = await Promise.all([
      likeService.countLikesForPosts(postIds),
      repostService.countRepostsForPosts(postIds),
      replyService.countRepliesForPosts(postIds),
      postService.countQuotesForPosts(postIds),
    ]);

    postIds.forEach((id) => {
      const stats = result.get(id);
      if (stats) {
        stats.likes = likeCounts.get(id) ?? 0;
        stats.reposts = repostCounts.get(id) ?? 0;
        stats.replies = replyCounts.get(id) ?? 0;
        stats.quotes = quoteCounts.get(id) ?? 0;
      }
    });
  } catch (error) {
    logger.error('Error getting batch post stats:', error);
  }

  return result;
}
