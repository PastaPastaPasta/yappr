import { logger } from '@/lib/logger';
import { Post } from '@/lib/types';
import { followService, postService } from '@/lib/services';
import { loadIdentityBatch } from '@/lib/services/identity-batch';
import { repostService } from '@/lib/services/repost-service';
import { attachQuotedPosts } from './resolve-quoted-posts';
import { sortFeedByTimestamp } from './transform-raw-post';

export interface FollowingFeedWindow {
  start: Date;
  end: Date;
  windowHours: number;
}

export async function loadFollowingFeed(options: {
  userId: string;
  timeWindow?: FollowingFeedWindow;
  forceRefresh: boolean;
  onBatchReady: (posts: Post[], nextWindow: FollowingFeedWindow | null, hasMore: boolean) => void;
  enrichProgressively: (posts: Post[]) => void;
}): Promise<void> {
  const MIN_DATE = new Date('2025-01-01T00:00:00Z');

  try {
    const followedUsers = await followService.getFollowing(options.userId);
    const followedIds = Array.from(new Set(followedUsers.map(follow => follow.followingId).filter(Boolean)));
    let currentWindow = options.timeWindow;
    let result: Awaited<ReturnType<typeof postService.getFollowingFeed>> = {
      documents: [],
      nextCursor: undefined,
      prevCursor: undefined,
    };

    let followingCursor: FollowingFeedWindow | null = null;

    do {
      result = await postService.getFollowingFeed(options.userId, {
        followingIds: followedIds,
        timeWindowStart: currentWindow?.start,
        timeWindowEnd: currentWindow?.end,
        windowHours: currentWindow?.windowHours,
      });

      followingCursor = null;
      if (result.nextCursor) {
        try {
          const cursor = JSON.parse(result.nextCursor) as { start: string; end: string; windowHours?: number };
          followingCursor = {
            start: new Date(cursor.start),
            end: new Date(cursor.end),
            windowHours: cursor.windowHours || 24,
          };
        } catch (error) {
          logger.warn('Failed to parse following feed cursor:', error);
        }
      }

      if (result.documents.length === 0 && followingCursor) {
        if (followingCursor.end < MIN_DATE) {
          logger.debug('Feed: Reached Jan 1 2025 limit, stopping search');
          followingCursor = null;
          break;
        }

        logger.debug(`Feed: Empty window, auto-retrying from ${followingCursor.end.toISOString()}`);
        currentWindow = followingCursor;
      }
    } while (result.documents.length === 0 && followingCursor);

    // Tombstoned posts are dropped from the feed but still resolve at their
    // permalink (see enrich-posts). Never set on v2.
    const posts = result.documents.filter((post) => !post.deleted);

    await attachQuotedPosts(posts);

    try {
      if (followedIds.length > 0) {
        const allReposts = (await repostService.getUserRepostsBatch(followedIds))
          .map(repost => ({ ...repost, reposterId: repost.$ownerId }));

        if (allReposts.length > 0) {
          const latestRepostByPostId = new Map<string, { postId: string; reposterId: string; $createdAt: number }>();
          for (const repost of allReposts) {
            const existing = latestRepostByPostId.get(repost.postId);
            if (!existing || repost.$createdAt > existing.$createdAt) {
              latestRepostByPostId.set(repost.postId, repost);
            }
          }

          const canonicalReposts = Array.from(latestRepostByPostId.values()).sort(
            (a, b) => b.$createdAt - a.$createdAt || a.postId.localeCompare(b.postId)
          );
          const existingPostIds = new Set(posts.map((post) => post.id));
          const repostPostIds = Array.from(new Set(canonicalReposts.map((repost) => repost.postId))).filter(
            (postId) => !existingPostIds.has(postId)
          );

          if (repostPostIds.length > 0) {
            const repostedPosts = await postService.fetchPostsOrReplies(repostPostIds);
            const repostedPostMap = new Map(repostedPosts.map((post) => [post.id, post]));

            const reposterIds = Array.from(new Set(canonicalReposts.map((repost) => repost.reposterId)));
            const { profiles, usernames } = await loadIdentityBatch(reposterIds);
            const reposterProfiles = new Map(profiles.map(profile => [profile.$ownerId, {
              displayName: profile.displayName, username: usernames.get(profile.$ownerId),
            }]));

            for (const repost of canonicalReposts) {
              const originalPost = repostedPostMap.get(repost.postId);
              // Repost documents outlive a tombstoned target (reposts are
              // deletable, targets are not) — skip deleted targets here just
              // like the direct-timeline filter above does.
              if (originalPost && !originalPost.deleted && !existingPostIds.has(repost.postId)) {
                existingPostIds.add(repost.postId);
                const reposterProfile = reposterProfiles.get(repost.reposterId);

                posts.push({
                  ...originalPost,
                  repostedBy: {
                    id: repost.reposterId,
                    displayName: reposterProfile?.displayName || '',
                    username: reposterProfile?.username || usernames.get(repost.reposterId) || undefined,
                  },
                  repostTimestamp: new Date(repost.$createdAt),
                });
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error('Feed: Error fetching reposts for following feed:', error);
    }

    const sortedPosts = sortFeedByTimestamp(posts);
    options.onBatchReady(sortedPosts, followingCursor, followingCursor !== null);
    options.enrichProgressively(sortedPosts);
  } catch (error) {
    logger.error('Feed: Failed to load Following feed:', error);
    options.onBatchReady([], null, false);
  }
}
