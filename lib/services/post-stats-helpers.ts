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

    const [likes, reposts, replies] = await Promise.all([
      countLikes(),
      countReposts(),
      countReplies(),
    ]);

    const stats: PostStats = {
      postId,
      likes,
      reposts,
      replies,
      views: 0,
    };

    statsCache.set(postId, {
      data: stats,
      timestamp: Date.now(),
    });

    return stats;
  } catch (error) {
    logger.error('Error getting post stats:', error);
    return { postId, likes: 0, reposts: 0, replies: 0, views: 0 };
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

  try {
    const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./bookmark-service'),
    ]);

    const [allLikesForPosts, allRepostsForPosts, userBookmarks] = await Promise.all([
      likeService.getLikesByPostIds(postIds),
      repostService.getRepostsByPostIds(postIds),
      bookmarkService.getUserBookmarksForPosts(currentUserId, postIds),
    ]);

    const likedPostIds = new Set(
      allLikesForPosts.filter((like) => like.$ownerId === currentUserId).map((like) => like.postId)
    );
    const repostedPostIds = new Set(
      allRepostsForPosts.filter((repost) => repost.$ownerId === currentUserId).map((repost) => repost.postId)
    );
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
    result.set(id, { postId: id, likes: 0, reposts: 0, replies: 0, views: 0 });
  });

  try {
    const [{ likeService }, { repostService }, { replyService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./reply-service'),
    ]);

    const [likes, reposts, replyCounts] = await Promise.all([
      likeService.getLikesByPostIds(postIds),
      repostService.getRepostsByPostIds(postIds),
      replyService.countRepliesByParentIds(postIds),
    ]);

    for (const like of likes) {
      const stats = result.get(like.postId);
      if (stats) stats.likes++;
    }

    for (const repost of reposts) {
      const stats = result.get(repost.postId);
      if (stats) stats.reposts++;
    }

    replyCounts.forEach((count, postId) => {
      const stats = result.get(postId);
      if (stats) stats.replies = count;
    });
  } catch (error) {
    logger.error('Error getting batch post stats:', error);
  }

  return result;
}
