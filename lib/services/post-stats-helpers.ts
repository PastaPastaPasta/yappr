import { logger } from '@/lib/logger';
import {
  bookmarkIndexFor,
  groupByInteractionSurface,
  ownQuoteIndexFor,
  repostIndexFor,
  type KindedTarget,
  type TargetKind,
} from '@/lib/contract-topology';
import type { OwnQuote } from '@/lib/feed/quote-reposts';
import type { PostStats } from './post-service';

export interface PostInteractionState {
  liked: boolean;
  /** v10: true when the viewer has quoted OR reposted it (one slot per target). */
  reposted: boolean;
  bookmarked: boolean;
  /** v10: the viewer's quote or bare repost of it, when `reposted`. */
  ownQuote?: OwnQuote;
}

/**
 * The viewer's reposts among `ids`: `repost` documents (v2, v9 posts) or, on
 * v10, their own quote posts via `ownerAndQuotedPost`/`ownerAndQuotedReply`.
 * Empty where the kind has neither (v9 replies).
 */
async function viewerReposts(currentUserId: string, ids: string[], kind: TargetKind): Promise<Map<string, OwnQuote | null>> {
  if (ownQuoteIndexFor(kind)) {
    const { postService } = await import('./post-service');
    return postService.getOwnQuotes(currentUserId, ids, kind);
  }
  if (!repostIndexFor(kind)) return new Map();
  const { repostService } = await import('./repost-service');
  const reposted = await repostService.getUserRepostedPostIds(currentUserId, ids);
  return new Map(Array.from(reposted, (id) => [id, null]));
}

/** Reply-count roots of the reply targets that carry one (v10 pins them). */
function rootsOf(targets: readonly KindedTarget[]): Map<string, string> {
  return new Map(targets.flatMap((target) => (target.rootPostId ? [[target.id, target.rootPostId] as const] : [])));
}

/**
 * The viewer's marks on each target. A target whose read failed is left out
 * rather than given defaults, so callers can tell "not marked" from "not read".
 */
export async function fetchBatchUserInteractions(
  targets: readonly KindedTarget[],
  currentUserId: string
): Promise<Map<string, PostInteractionState>> {
  const result = new Map<string, PostInteractionState>();
  if (targets.length === 0) {
    return result;
  }

  const [{ likeService }, { bookmarkService }] = await Promise.all([
    import('./like-service'),
    import('./bookmark-service'),
  ]);

  // One pass per distinct interaction surface. On v2 both kinds share one
  // surface, so this is a single pass over every id — the same three queries
  // the pre-topology code issued.
  await Promise.all(
    groupByInteractionSurface(targets).map(async ({ kind, ids }) => {
      try {
        // Query only the CURRENT user's own likes/reposts (bounded by page size
        // via the composite indexes) instead of fetching all users' likes capped
        // at 100 and filtering client-side — which could miss the user's own on
        // busy pages.
        const [likedPostIds, reposts, userBookmarks] = await Promise.all([
          likeService.getUserLikedPostIds(currentUserId, ids, kind),
          viewerReposts(currentUserId, ids, kind),
          bookmarkIndexFor(kind)
            ? bookmarkService.getUserBookmarksForPosts(currentUserId, ids)
            : Promise.resolve([]),
        ]);

        const bookmarkedPostIds = new Set(userBookmarks.map((bookmark) => bookmark.postId));

        ids.forEach((postId) => {
          const ownQuote = reposts.get(postId);
          result.set(postId, {
            liked: likedPostIds.has(postId),
            reposted: reposts.has(postId),
            bookmarked: bookmarkedPostIds.has(postId),
            ...(ownQuote ? { ownQuote } : {}),
          });
        });
      } catch (error) {
        logger.error('Error getting batch user interactions:', error);
      }
    })
  );

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
          // Per-kind count tree: on v9 a post counts its whole thread and a reply its direct children.
          replyService.countRepliesForPosts(ids, kind, rootsOf(targets)),
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
