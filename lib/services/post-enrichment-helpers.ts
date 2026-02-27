import { logger } from '@/lib/logger';
import { Post, User } from '../types';
import { dpnsService } from './dpns-service';
import { blockService } from './block-service';
import { followService } from './follow-service';
import { unifiedProfileService } from './unified-profile-service';
import { seedBlockStatusCache, seedFollowStatusCache } from '../caches/user-status-cache';
import type { PostStats } from './post-service';
import type { PostInteractionState } from './post-stats-helpers';

export async function enrichPostFull(
  post: Post,
  getPostStats: (postId: string) => Promise<PostStats>,
  getUserInteractions: (postId: string) => Promise<PostInteractionState>
): Promise<Post> {
  try {
    const [stats, interactions, author] = await Promise.all([
      getPostStats(post.id),
      getUserInteractions(post.id),
      unifiedProfileService.getProfileWithUsername(post.author.id),
    ]);

    const authorToUse = author || post.author;
    const hasDpns = Boolean(authorToUse.username && !authorToUse.username.includes('...'));

    return {
      ...post,
      likes: stats.likes,
      reposts: stats.reposts,
      replies: stats.replies,
      views: stats.views,
      liked: interactions.liked,
      reposted: interactions.reposted,
      bookmarked: interactions.bookmarked,
      author: {
        ...authorToUse,
        hasDpns,
      } as User & { hasDpns: boolean },
    };
  } catch (error) {
    logger.error('Error enriching post:', error);
    return post;
  }
}

export async function enrichPostsBatch(
  posts: Post[],
  getBatchPostStats: (postIds: string[]) => Promise<Map<string, PostStats>>,
  getBatchUserInteractions: (postIds: string[]) => Promise<Map<string, PostInteractionState>>,
  currentUserId: string | null
): Promise<Post[]> {
  if (posts.length === 0) return posts;

  try {
    const postIds = posts.map((post) => post.id);
    const authorIds = Array.from(new Set(posts.map((post) => post.author.id).filter(Boolean)));

    const [
      statsMap,
      interactionsMap,
      usernameMap,
      profiles,
      blockStatusMap,
      followStatusMap,
      avatarUrlMap,
    ] = await Promise.all([
      getBatchPostStats(postIds),
      getBatchUserInteractions(postIds),
      dpnsService.resolveUsernamesBatch(authorIds),
      unifiedProfileService.getProfilesByIdentityIds(authorIds),
      currentUserId
        ? blockService.checkBlockedBatch(currentUserId, authorIds)
        : Promise.resolve(new Map<string, boolean>()),
      currentUserId
        ? followService.getFollowStatusBatch(authorIds, currentUserId)
        : Promise.resolve(new Map<string, boolean>()),
      unifiedProfileService.getAvatarUrlsBatch(authorIds),
    ]);

    if (currentUserId) {
      seedBlockStatusCache(currentUserId, blockStatusMap);
      seedFollowStatusCache(currentUserId, followStatusMap);
    }

    const profileMap = new Map<string, Record<string, unknown>>();
    profiles.forEach((profile) => {
      const profileRecord = profile as unknown as Record<string, unknown>;
      if (profileRecord.$ownerId) {
        profileMap.set(profileRecord.$ownerId as string, profileRecord);
      }
    });

    return posts.map((post) => {
      const stats = statsMap.get(post.id);
      const interactions = interactionsMap.get(post.id);
      const username = usernameMap.get(post.author.id);
      const profile = profileMap.get(post.author.id);
      const profileData = (profile?.data || profile) as Record<string, unknown> | undefined;

      const authorIsBlocked = blockStatusMap.get(post.author.id) ?? false;
      const authorIsFollowing = followStatusMap.get(post.author.id) ?? false;
      const authorAvatarUrl = avatarUrlMap.get(post.author.id) ?? '';

      return {
        ...post,
        likes: stats?.likes ?? post.likes,
        reposts: stats?.reposts ?? post.reposts,
        replies: stats?.replies ?? post.replies,
        views: stats?.views ?? post.views,
        liked: interactions?.liked ?? post.liked,
        reposted: interactions?.reposted ?? post.reposted,
        bookmarked: interactions?.bookmarked ?? post.bookmarked,
        author: {
          ...post.author,
          username: username || post.author.username,
          displayName: (profileData?.displayName as string) || post.author.displayName,
          avatar: authorAvatarUrl || post.author.avatar,
          hasDpns: Boolean(username),
        },
        _enrichment: {
          authorIsBlocked,
          authorIsFollowing,
          authorAvatarUrl,
        },
      };
    });
  } catch (error) {
    logger.error('Error batch enriching posts:', error);
    return posts;
  }
}

export async function resolvePostAuthor(post: Post): Promise<void> {
  if (!post.author?.id || post.author.id === 'unknown') return;

  try {
    const author = await unifiedProfileService.getProfileWithUsername(post.author.id);
    if (author) {
      post.author = author;
    }
  } catch (error) {
    logger.error('Error resolving post author:', error);
  }
}
