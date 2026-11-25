import type { PreloadedEnrichment } from '@/hooks/use-progressive-enrichment';
import { logger } from '@/lib/logger';
import { Post } from '../types';
import { loadIdentityBatch } from './identity-batch';
import { blockService } from './block-service';
import { followService } from './follow-service';
import { unifiedProfileService } from './unified-profile-service';
import { blockStatusCache, followStatusCache } from '../caches/user-status-cache';
import { targetOf, type KindedTarget } from '../contract-topology';
import type { PostStats } from './post-service';
import type { PostInteractionState } from './post-stats-helpers';
import type { ViewerMarks } from '../feed/viewer-marks';
import { sessionGeneration } from '@/lib/auth/session-generation';

/**
 * Owner-keyed profile data from a `getProfilesByIdentityIds` result, with the
 * SDK's optional `data` nesting already unwrapped.
 */
export function profileDataByOwnerId(profiles: readonly unknown[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const profile of profiles) {
    const record = profile as Record<string, unknown> | undefined;
    const ownerId = record?.$ownerId as string | undefined;
    if (record && ownerId) {
      map.set(ownerId, (record.data || record) as Record<string, unknown>);
    }
  }
  return map;
}

export async function enrichPostsBatch(
  posts: Post[],
  getBatchPostStats: (targets: readonly KindedTarget[]) => Promise<Map<string, PostStats>>,
  getBatchUserInteractions: (targets: readonly KindedTarget[], viewerId: string) => Promise<Map<string, PostInteractionState>>,
  currentUserId: string | null,
  supplied?: PreloadedEnrichment
): Promise<Post[]> {
  if (posts.length === 0) return posts;
  // The viewer's marks belong to the session this read started in.
  const session = sessionGeneration();

  try {
    // Tagged with each post's kind so the batch queries hit the right doctypes
    // (a no-op on v2, where both kinds share one surface).
    const { loadPostEnrichment } = await import('@/lib/feed/load-post-enrichment');
    const preloaded = supplied ?? await loadPostEnrichment(posts, currentUserId ?? undefined);
    const targets = posts.map(targetOf);
    const authorIds = Array.from(new Set(posts.map((post) => post.author.id).filter(Boolean)));

    const identities = loadIdentityBatch(authorIds);
    const [
      statsMap,
      interactionsMap,
      { usernames: usernameMap, profiles, avatars: avatarUrlMap },
      blockStatusMap,
      followStatusMap,
    ] = await Promise.all([
      getBatchPostStats(targets.filter(target => !preloaded.stats?.has(target.id))),
      currentUserId
        ? getBatchUserInteractions(targets.filter(target => !preloaded.interactions?.has(target.id)), currentUserId)
        : Promise.resolve(new Map<string, PostInteractionState>()),
      identities,
      currentUserId
        ? blockService.checkBlockedBatch(currentUserId, authorIds)
        : Promise.resolve(new Map<string, boolean>()),
      currentUserId
        ? followService.getFollowStatusBatch(authorIds, currentUserId)
        : Promise.resolve(new Map<string, boolean>()),
    ]);

    preloaded.stats?.forEach((stats, postId) => statsMap.set(postId, { ...stats, postId }));
    // Each mark names the viewer it was read for: the batch read's is this one.
    const marksMap = new Map<string, ViewerMarks>();
    if (currentUserId) interactionsMap.forEach((marks, postId) => marksMap.set(postId, { ...marks, viewerId: currentUserId, session }));
    preloaded.interactions?.forEach((marks, postId) => marksMap.set(postId, marks));

    if (currentUserId) {
      blockStatusCache.seed(currentUserId, blockStatusMap);
      followStatusCache.seed(currentUserId, followStatusMap);
    }

    const profileMap = profileDataByOwnerId(profiles);

    return posts.map((post) => {
      const stats = statsMap.get(post.id);
      const interactions = marksMap.get(post.id);
      const username = usernameMap.get(post.author.id);
      const profileData = profileMap.get(post.author.id);

      const authorIsBlocked = blockStatusMap.get(post.author.id);
      const authorIsFollowing = followStatusMap.get(post.author.id);
      const authorAvatarUrl = avatarUrlMap.get(post.author.id) ?? '';

      return {
        ...post,
        likes: stats?.likes ?? post.likes,
        reposts: stats?.reposts ?? post.reposts,
        replies: stats?.replies ?? post.replies,
        quotes: stats?.quotes ?? post.quotes,
        views: stats?.views ?? post.views,
        ...(interactions
          ? { liked: interactions.liked, reposted: interactions.reposted, bookmarked: interactions.bookmarked, ownQuote: interactions.ownQuote, marksFor: interactions.viewerId, marksSession: interactions.session }
          : {}),
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
          viewerId: currentUserId ?? undefined,
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

/**
 * Resolve authors for many posts with three batch queries (DPNS + profiles +
 * avatars) instead of `resolvePostAuthor`'s two queries PER post. Mutates
 * `post.author` in place.
 *
 * Like the other batch author passes (enrichPostsBatch above, reply-service's
 * resolveAuthors), this only carries the fields feed surfaces render —
 * username, displayName, bio, avatar, hasDpns. The extended profile fields
 * (location, website, bannerUri, paymentUris, pronouns, nsfw, socialLinks)
 * are intentionally NOT populated; anything that needs them must fetch the
 * full profile itself rather than read them off `post.author`.
 */
export async function resolvePostAuthorsBatch(posts: Post[]): Promise<void> {
  const authorIds = Array.from(
    new Set(posts.map((post) => post.author?.id).filter((id): id is string => Boolean(id) && id !== 'unknown'))
  );
  if (authorIds.length === 0) return;

  try {
    const { usernames: usernameMap, profiles, avatars: avatarUrls } = await loadIdentityBatch(authorIds);

    const profileMap = profileDataByOwnerId(profiles);

    for (const post of posts) {
      const authorId = post.author?.id;
      if (!authorId || authorId === 'unknown') continue;

      const username = usernameMap.get(authorId);
      const profileData = profileMap.get(authorId);
      const avatarUrl = avatarUrls.get(authorId);

      post.author = {
        ...post.author,
        username: username || post.author.username,
        displayName: (profileData?.displayName as string) || post.author.displayName,
        bio: (profileData?.bio as string | undefined) ?? post.author.bio,
        avatar: avatarUrl || post.author.avatar,
        hasDpns: Boolean(username),
      };
    }
  } catch (error) {
    logger.error('Error batch resolving post authors:', error);
  }
}
