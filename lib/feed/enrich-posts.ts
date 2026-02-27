import { logger } from '@/lib/logger';
import { Post } from '@/lib/types';
import { postService, unifiedProfileService } from '@/lib/services';
import { repostService } from '@/lib/services/repost-service';

export async function enrichPostsWithRepostsAndQuotes(postsToEnrich: Post[]): Promise<Post[]> {
  try {
    const postIds = postsToEnrich.map((post) => post.id);
    if (postIds.length > 0) {
      const reposts = await repostService.getRepostsByPostIds(postIds);

      const repostMap = new Map<string, { postId: string; $ownerId: string; $createdAt: number }>();
      for (const repost of reposts) {
        const existing = repostMap.get(repost.postId);
        if (!existing || repost.$createdAt > existing.$createdAt) {
          repostMap.set(repost.postId, repost as { postId: string; $ownerId: string; $createdAt: number });
        }
      }

      const reposterIds = Array.from(new Set(Array.from(repostMap.values()).map((repost) => repost.$ownerId)));
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
            // Ignore profile fetch errors to keep feed loading resilient.
          }
        })
      );

      for (const post of postsToEnrich) {
        const repost = repostMap.get(post.id);
        if (repost && repost.$ownerId !== post.author.id) {
          const repostTimestamp = new Date(repost.$createdAt);
          if (repostTimestamp > post.createdAt) {
            const reposterProfile = reposterProfiles.get(repost.$ownerId);
            post.repostedBy = {
              id: repost.$ownerId,
              displayName: reposterProfile?.displayName || '',
              username: reposterProfile?.username,
            };
            post.repostTimestamp = repostTimestamp;
          }
        }
      }
    }
  } catch (error) {
    logger.error('Feed: Error fetching reposts:', error);
  }

  try {
    const quotedPostIds = postsToEnrich
      .filter((post) => post.quotedPostId)
      .map((post) => post.quotedPostId as string);

    if (quotedPostIds.length > 0) {
      const quotedPosts = await postService.fetchPostsOrReplies(quotedPostIds);
      const quotedPostMap = new Map(quotedPosts.map((post) => [post.id, post]));

      for (const post of postsToEnrich) {
        if (post.quotedPostId && quotedPostMap.has(post.quotedPostId)) {
          post.quotedPost = quotedPostMap.get(post.quotedPostId);
        }
      }
    }
  } catch (error) {
    logger.error('Feed: Error fetching quoted posts:', error);
  }

  return postsToEnrich;
}
