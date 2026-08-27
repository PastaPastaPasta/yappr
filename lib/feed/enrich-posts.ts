import { logger } from '@/lib/logger';
import { Post } from '@/lib/types';
import { unifiedProfileService } from '@/lib/services';
import { repostService } from '@/lib/services/repost-service';
import { attachQuotedPosts } from './resolve-quoted-posts';

export async function enrichPostsWithRepostsAndQuotes(postsToEnrich: Post[]): Promise<Post[]> {
  // Tombstones (v3 "deleted" posts) still exist on chain and still come back from
  // timeline queries — the document is permanent, only its content is gone. They
  // are dropped from feeds here, cheaply, while remaining visible at their
  // permalink so anything linking to one still resolves. `deleted` is never set
  // on v2, so this is a no-op there.
  const enrichedPosts = postsToEnrich.filter((post) => !post.deleted).map((post) => ({ ...post }));

  try {
    const postIds = enrichedPosts.map((post) => post.id);
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

      for (const post of enrichedPosts) {
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

  await attachQuotedPosts(enrichedPosts);

  return enrichedPosts;
}
