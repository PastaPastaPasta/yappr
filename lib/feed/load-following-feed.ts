import { logger } from '@/lib/logger';
import { Post } from '@/lib/types';
import { followService, postService, unifiedProfileService } from '@/lib/services';
import { repostService } from '@/lib/services/repost-service';
import { sortFeedByTimestamp, transformRawPost } from './transform-raw-post';

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
    let currentWindow = options.timeWindow;
    let result: Awaited<ReturnType<typeof postService.getFollowingFeed>> = {
      documents: [],
      nextCursor: undefined,
      prevCursor: undefined,
    };

    let followingCursor: FollowingFeedWindow | null = null;

    do {
      result = await postService.getFollowingFeed(options.userId, {
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
          logger.info('Feed: Reached Jan 1 2025 limit, stopping search');
          followingCursor = null;
          break;
        }

        logger.info(`Feed: Empty window, auto-retrying from ${followingCursor.end.toISOString()}`);
        currentWindow = followingCursor;
      }
    } while (result.documents.length === 0 && followingCursor);

    const posts = result.documents.map((post) => transformRawPost(post as unknown as Record<string, unknown>));

    try {
      const quotedPostIds = posts
        .filter((post) => post.quotedPostId)
        .map((post) => post.quotedPostId as string);

      if (quotedPostIds.length > 0) {
        const quotedPosts = await postService.fetchPostsOrReplies(quotedPostIds);
        const quotedPostMap = new Map(quotedPosts.map((post) => [post.id, post]));

        for (const post of posts) {
          if (post.quotedPostId && quotedPostMap.has(post.quotedPostId)) {
            post.quotedPost = quotedPostMap.get(post.quotedPostId);
          }
        }
      }
    } catch (error) {
      logger.error('Feed: Error fetching quoted posts for following feed:', error);
    }

    try {
      const followedUsers = await followService.getFollowing(options.userId);
      const followedIds = followedUsers
        .map((followed) => followed.followingId || (followed as unknown as { followedId?: string }).followedId || followed.$id)
        .filter(Boolean);

      if (followedIds.length > 0) {
        const allReposts: Array<{ postId: string; reposterId: string; $createdAt: number }> = [];
        const REPOST_BATCH_SIZE = 20;

        for (let index = 0; index < followedIds.length; index += REPOST_BATCH_SIZE) {
          const batch = followedIds.slice(index, index + REPOST_BATCH_SIZE);
          await Promise.all(
            batch.map(async (followedId) => {
              try {
                const userReposts = await repostService.getUserReposts(followedId);
                allReposts.push(
                  ...userReposts.map((repost) => ({
                    ...(repost as { postId: string; $createdAt: number }),
                    reposterId: followedId,
                  }))
                );
              } catch {
                // Ignore individual failures to keep feed rendering resilient.
              }
            })
          );
        }

        if (allReposts.length > 0) {
          const existingPostIds = new Set(posts.map((post) => post.id));
          const repostPostIds = Array.from(new Set(allReposts.map((repost) => repost.postId))).filter(
            (postId) => !existingPostIds.has(postId)
          );

          if (repostPostIds.length > 0) {
            const repostedPosts = await postService.fetchPostsOrReplies(repostPostIds);
            const repostedPostMap = new Map(repostedPosts.map((post) => [post.id, post]));

            const reposterIds = Array.from(new Set(allReposts.map((repost) => repost.reposterId)));
            const reposterProfiles = new Map<string, { displayName?: string; username?: string }>();

            await Promise.all(
              reposterIds.map(async (id) => {
                try {
                  const profile = await unifiedProfileService.getProfileWithUsername(id);
                  if (profile) {
                    reposterProfiles.set(id, {
                      displayName: profile.displayName,
                      username: profile.username,
                    });
                  }
                } catch {
                  // Ignore profile fetch failures.
                }
              })
            );

            for (const repost of allReposts) {
              const originalPost = repostedPostMap.get(repost.postId);
              if (originalPost && !existingPostIds.has(repost.postId)) {
                existingPostIds.add(repost.postId);
                const reposterProfile = reposterProfiles.get(repost.reposterId);

                posts.push({
                  ...originalPost,
                  repostedBy: {
                    id: repost.reposterId,
                    displayName: reposterProfile?.displayName || '',
                    username: reposterProfile?.username,
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
