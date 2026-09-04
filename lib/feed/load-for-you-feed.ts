import { logger } from '@/lib/logger';
import { postService } from '@/lib/services/post-service';
import { Post } from '@/lib/types';
import type { PreloadedEnrichment } from '@/hooks/use-progressive-enrichment';
import { loadCompositeFeedPage } from './composite-feed-page';
import { enrichPostsWithRepostsAndQuotes } from './enrich-posts';
import { sortFeedByTimestamp } from './transform-raw-post';

/**
 * Timeline documents arrive with `createDefaultUser` placeholders
 * (`hasDpns: false`, "Unknown User"). The feed renders before enrichment, and
 * PostCard reads `hasDpns === undefined` as "still resolving" (skeleton) versus
 * `false` as "no DPNS name" (identity-id button), so the placeholder is reset
 * to the loading shape here to avoid a flash of identity ids on every card.
 */
function withLoadingAuthor(post: Post): Post {
  return {
    ...post,
    author: { ...post.author, username: '', displayName: '', avatar: '', hasDpns: undefined },
  };
}

const PAGE_SIZE = 20;

interface FeedPage {
  posts: Post[];
  cursor: string | null;
  hasMore: boolean;
  preloaded?: PreloadedEnrichment;
}

async function fetchFeedPage(options: {
  startAfter?: string;
  language?: string;
  currentUserId?: string;
}): Promise<FeedPage> {
  const compositeOptions = {
    language: options.language || 'en',
    limit: PAGE_SIZE,
    currentUserId: options.currentUserId,
  };

  if (!options.startAfter) {
    const page = await loadCompositeFeedPage(compositeOptions);
    if (page) {
      const last = page.rawPosts[page.rawPosts.length - 1];
      const cursor = last ? String(last.$id) : null;
      return { posts: page.posts, cursor, hasMore: page.hasMore, preloaded: page.preloaded };
    }
  }

  // Composite queries have no document cursor. Use the timeline's real
  // startAfter to select subsequent pages, including timestamp ties, then
  // batch enrichment for those exact ids. Keep the raw cursor even when
  // tombstones leave no visible cards or a document changes between reads.
  const raw = (await postService.getTimeline({
    limit: PAGE_SIZE,
    startAfter: options.startAfter,
    language: options.language,
  })).documents;
  const cursor = raw.length ? raw[raw.length - 1].id : null;
  const hasMore = raw.length === PAGE_SIZE;
  if (options.startAfter && raw.length) {
    const page = await loadCompositeFeedPage({
      ...compositeOptions,
      documentIds: raw.map(post => post.id),
    });
    if (page) {
      return { posts: page.posts, cursor, hasMore, preloaded: page.preloaded };
    }
  }

  const posts = raw.filter(post => !post.deleted).map(withLoadingAuthor);
  return { posts, cursor, hasMore };
}

export async function loadForYouFeed(options: {
  startAfter?: string;
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

  logger.debug(
    'Feed: Loading posts',
    currentStartAfter ? `starting after ${currentStartAfter}` : '',
    '(iteration 1)'
  );

  const firstPage = await fetchFeedPage({
    startAfter: currentStartAfter,
    language: options.feedLanguage,
    currentUserId: options.currentUserId,
  });

  if (!firstPage.cursor) {
    logger.debug('Feed: No posts available');
    options.setHasMore(false);
    return { posts: [], cursor: null, hasMore: false };
  }

  const firstBatchPosts = firstPage.posts;
  const firstBatchCursor = firstPage.cursor;

  logger.debug(`Feed: First batch has ${firstBatchPosts.length} posts`);

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
    logger.debug(
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
        logger.debug(`Feed: Loading posts starting after ${bgCurrentStartAfter} (iteration ${bgFetchIteration})`);

        const bgPage = await fetchFeedPage({
          startAfter: bgCurrentStartAfter,
          language: options.feedLanguage,
          currentUserId: options.currentUserId,
        });

        bgHasMore = bgPage.hasMore;

        if (!bgPage.cursor) {
          logger.debug('Feed: No more posts available (background)');
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

          logger.debug(`Feed: Background added ${newItems.length} posts (total: ${allItems.length})`);
          return allItems;
        });

        options.enrichProgressively(bgPosts, bgPage.preloaded);
        if (bgCurrentStartAfter) {
          options.setLastPostId(bgCurrentStartAfter);
        }

        if (allPostCount < MIN_NON_REPLY_POSTS && bgFetchIteration < MAX_FETCH_ITERATIONS) {
          logger.debug(`Feed: Only ${allPostCount} posts, fetching more... (need ${MIN_NON_REPLY_POSTS})`);
        }
      }

      options.setHasMore(bgHasMore);
      logger.debug(`Feed: Background fetch complete. Total posts: ${allPostCount}`);
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
