import { logger } from '@/lib/logger';
import type { TtlMap } from '@/lib/caches/ttl-map';
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
 * Stats and interactions are cached and deduplicated per (surface, id): a `post`
 * id and a `reply` id are drawn from the same keyspace but, on the v9 topology,
 * are answered by different doctypes.
 */
function statsCacheKey(target: KindedTarget): string {
  return `${target.kind}:${target.id}`;
}

export async function fetchPostStats(
  target: KindedTarget,
  statsCache: TtlMap<string, PostStats>
): Promise<PostStats> {
  const { id: postId, kind } = target;
  const cacheKey = statsCacheKey(target);
  const cached = statsCache.get(cacheKey);
  if (cached) return cached;

  try {
    const [{ likeService }, { repostService }, { replyService }, { postService }] = await Promise.all([
      import('./like-service'),
      import('./repost-service'),
      import('./reply-service'),
      import('./post-service'),
    ]);

    const [likes, reposts, replies, quotes] = await Promise.all([
      likeService.countLikes(postId, kind),
      // No repost doctype to count: a v9 reply, and everything on v10, where a
      // repost is a quote and the quote count below already holds it.
      repostIndexFor(kind) ? repostService.countReposts(postId) : Promise.resolve(0),
      // Polymorphic on v2 (one `parentId` count tree serves both kinds); on v9 a
      // post counts its whole thread and a reply its direct children (v10 pins
      // the reply's root).
      replyService.countReplies(postId, kind, target.rootPostId),
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

    statsCache.set(cacheKey, stats);

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
    const [{ likeService }, { bookmarkService }] = await Promise.all([
      import('./like-service'),
      import('./bookmark-service'),
    ]);

    // Kinds the topology forbids reposting/bookmarking have no document to look
    // for, so those queries are skipped rather than pointed at the wrong doctype.
    const [liked, reposts, bookmarked] = await Promise.all([
      likeService.isLiked(postId, currentUserId, kind),
      viewerReposts(currentUserId, [postId], kind),
      bookmarkIndexFor(kind) ? bookmarkService.isBookmarked(postId, currentUserId) : Promise.resolve(false),
    ]);

    const ownQuote = reposts.get(postId);
    return { liked, reposted: reposts.has(postId), bookmarked, ...(ownQuote ? { ownQuote } : {}) };
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
    const [{ likeService }, { bookmarkService }] = await Promise.all([
      import('./like-service'),
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
