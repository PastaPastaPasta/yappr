import { logger } from '@/lib/logger';
import { getDashPlatformClient } from '@/lib/dash-platform-client';
import { Post } from '@/lib/types';
import type { PreloadedEnrichment } from '@/hooks/use-progressive-enrichment';
import { loadCompositeFeedPage } from './composite-feed-page';
import { enrichPostsWithRepostsAndQuotes } from './enrich-posts';
import { sortFeedByTimestamp, transformRawPost } from './transform-raw-post';

const PAGE_SIZE = 20;

/**
 * `$createdAt` of every page cursor the composite path handed out, keyed by
 * the cursor post id. The feed paginates by document id (`startAfter`); the
 * composite surface has no cursor and continues with a range clause on the
 * page's ordering property instead, so an id cursor is translated back to
 * its timestamp here. A cursor this map does not know (a legacy page, a
 * reload) simply takes the legacy path.
 */
const cursorCreatedAtById = new Map<string, number>();

interface FeedPage {
  raw: Record<string, unknown>[];
  posts: Post[];
  cursor: string | null;
  hasMore: boolean;
  preloaded?: PreloadedEnrichment;
}

async function fetchFeedPage(options: {
  startAfter?: string;
  forceRefresh: boolean;
  language?: string;
  currentUserId?: string;
}): Promise<FeedPage> {
  const beforeCreatedAt = options.startAfter ? cursorCreatedAtById.get(options.startAfter) : undefined;
  const compositeEligible = !options.startAfter || beforeCreatedAt !== undefined;

  if (compositeEligible) {
    const page = await loadCompositeFeedPage({
      language: options.language || 'en',
      limit: PAGE_SIZE,
      beforeCreatedAt,
      currentUserId: options.currentUserId,
    });
    if (page) {
      const last = page.rawPosts[page.rawPosts.length - 1];
      const cursor = last ? ((last.$id || last.id) as string) : null;
      const cursorCreatedAt = last ? Number(last.$createdAt ?? last.createdAt) : NaN;
      if (cursor && Number.isFinite(cursorCreatedAt)) {
        cursorCreatedAtById.set(cursor, cursorCreatedAt);
      }
      return { raw: page.rawPosts, posts: page.posts, cursor, hasMore: page.hasMore, preloaded: page.preloaded };
    }
  }

  const raw = await getDashPlatformClient().queryPosts({
    limit: PAGE_SIZE,
    forceRefresh: options.forceRefresh,
    startAfter: options.startAfter,
    language: options.language,
  });
  // Tombstones are dropped here, before the raw batch renders — the async
  // enrichment merge falls back to the ORIGINAL post for ids missing from the
  // enriched result, so filtering only inside enrichPostsWithRepostsAndQuotes
  // would let deleted posts reappear. `deleted` is never set on v2.
  const posts = raw
    .map((doc) => transformRawPost(doc as Record<string, unknown>))
    .filter((post) => !post.deleted);
  const last = raw[raw.length - 1];
  const cursor = last ? ((last.$id || last.id) as string) : null;
  return { raw, posts, cursor, hasMore: raw.length === PAGE_SIZE };
}

export async function loadForYouFeed(options: {
  startAfter?: string;
  forceRefresh: boolean;
  feedLanguage?: string;
  currentUserId?: string;
  setData: (updater: (prev: Post[] | null) => Post[] | null) => void;
  setHasMore: (value: boolean) => void;
  setLastPostId: (id: string) => void;
  enrichProgressively: (posts: Post[], preloaded?: PreloadedEnrichment) => void;
}): Promise<{ posts: Post[]; cursor: string | null; hasMore: boolean; preloaded?: PreloadedEnrichment }> {
  const MIN_NON_REPLY_POSTS = 20;
  const MAX_FETCH_ITERATIONS = 5;

  const currentStartAfter = options.startAfter;

  logger.info(
    'Feed: Loading posts',
    currentStartAfter ? `starting after ${currentStartAfter}` : '',
    '(iteration 1)'
  );

  const firstPage = await fetchFeedPage({
    startAfter: currentStartAfter,
    forceRefresh: options.forceRefresh,
    language: options.feedLanguage,
    currentUserId: options.currentUserId,
  });

  if (firstPage.raw.length === 0) {
    logger.info('Feed: No posts available');
    options.setHasMore(false);
    return { posts: [], cursor: null, hasMore: false };
  }

  const firstBatchPosts = firstPage.posts;
  const firstBatchCursor = firstPage.cursor;

  logger.info(`Feed: First batch has ${firstBatchPosts.length} posts`);

  const forYouNextCursor: string | null = firstBatchCursor;
  const forYouHasMore = firstPage.hasMore;

  // Repost attribution ("X reposted") and whatever quotes the composite page
  // did not already attach (quoted replies, blog quotes).
  enrichPostsWithRepostsAndQuotes(firstBatchPosts)
    .then((enrichedPosts) => {
      options.setData((current) => {
        if (!current) return current;
        const enrichedById = new Map(enrichedPosts.map((post) => [post.id, post]));
        return current.map((post) => enrichedById.get(post.id) || post);
      });
    })
    .catch((error) => {
      logger.error('Feed: Error enriching first batch:', error);
    });

  if (firstBatchPosts.length < MIN_NON_REPLY_POSTS && forYouHasMore) {
    logger.info(
      `Feed: Only ${firstBatchPosts.length} posts, will fetch more in background... (need ${MIN_NON_REPLY_POSTS})`
    );

    const fetchMoreInBackground = async () => {
      let bgCurrentStartAfter = firstBatchCursor;
      let bgFetchIteration = 1;
      let allPostCount = firstBatchPosts.length;
      let bgHasMore: boolean = forYouHasMore;

      while (
        allPostCount < MIN_NON_REPLY_POSTS &&
        bgFetchIteration < MAX_FETCH_ITERATIONS &&
        bgHasMore &&
        bgCurrentStartAfter
      ) {
        bgFetchIteration++;
        logger.info(`Feed: Loading posts starting after ${bgCurrentStartAfter} (iteration ${bgFetchIteration})`);

        const bgPage = await fetchFeedPage({
          startAfter: bgCurrentStartAfter,
          forceRefresh: false,
          language: options.feedLanguage,
          currentUserId: options.currentUserId,
        });

        bgHasMore = bgPage.hasMore;

        if (bgPage.raw.length === 0) {
          logger.info('Feed: No more posts available (background)');
          options.setHasMore(false);
          break;
        }

        const bgPosts = bgPage.posts;

        enrichPostsWithRepostsAndQuotes(bgPosts)
          .then((enrichedPosts) => {
            options.setData((current) => {
              if (!current) return current;
              const enrichedById = new Map(enrichedPosts.map((post) => [post.id, post]));
              return current.map((post) => enrichedById.get(post.id) || post);
            });
          })
          .catch((error) => {
            logger.error('Feed: Error enriching background batch:', error);
          });

        allPostCount += bgPosts.length;

        bgCurrentStartAfter = bgPage.cursor;

        options.setData((currentItems) => {
          if (!currentItems) return bgPosts;

          const existingIds = new Set(currentItems.map((item) => item.id));
          const newItems = bgPosts.filter((post) => !existingIds.has(post.id));
          const allItems = sortFeedByTimestamp([...currentItems, ...newItems]);

          logger.info(`Feed: Background added ${newItems.length} posts (total: ${allItems.length})`);
          return allItems;
        });

        options.enrichProgressively(bgPosts, bgPage.preloaded);
        if (bgCurrentStartAfter) {
          options.setLastPostId(bgCurrentStartAfter);
        }

        if (allPostCount < MIN_NON_REPLY_POSTS && bgFetchIteration < MAX_FETCH_ITERATIONS) {
          logger.info(`Feed: Only ${allPostCount} posts, fetching more... (need ${MIN_NON_REPLY_POSTS})`);
        }
      }

      options.setHasMore(bgHasMore);
      logger.info(`Feed: Background fetch complete. Total posts: ${allPostCount}`);
    };

    fetchMoreInBackground().catch((error) => {
      logger.error('Feed: Background fetch error:', error);
    });
  }

  const sortedPosts = sortFeedByTimestamp(firstBatchPosts);

  if (forYouNextCursor) {
    options.setLastPostId(forYouNextCursor);
  }
  options.setHasMore(forYouHasMore);

  return {
    posts: sortedPosts,
    cursor: forYouNextCursor,
    hasMore: forYouHasMore,
    preloaded: firstPage.preloaded,
  };
}
