import { logger } from '@/lib/logger';
import { getDashPlatformClient } from '@/lib/dash-platform-client';
import { Post } from '@/lib/types';
import { enrichPostsWithRepostsAndQuotes } from './enrich-posts';
import { sortFeedByTimestamp, transformRawPost } from './transform-raw-post';

export async function loadForYouFeed(options: {
  startAfter?: string;
  forceRefresh: boolean;
  feedLanguage?: string;
  setData: (updater: (prev: Post[] | null) => Post[] | null) => void;
  setHasMore: (value: boolean) => void;
  setLastPostId: (id: string) => void;
  enrichProgressively: (posts: Post[]) => void;
}): Promise<{ posts: Post[]; cursor: string | null; hasMore: boolean }> {
  const MIN_NON_REPLY_POSTS = 20;
  const MAX_FETCH_ITERATIONS = 5;
  const dashClient = getDashPlatformClient();

  const currentStartAfter = options.startAfter;

  logger.info(
    'Feed: Loading posts',
    currentStartAfter ? `starting after ${currentStartAfter}` : '',
    '(iteration 1)'
  );

  const firstBatchRaw = await dashClient.queryPosts({
    limit: 20,
    forceRefresh: options.forceRefresh,
    startAfter: currentStartAfter,
    language: options.feedLanguage,
  });

  if (firstBatchRaw.length === 0) {
    logger.info('Feed: No posts available');
    options.setHasMore(false);
    return { posts: [], cursor: null, hasMore: false };
  }

  const firstBatchPosts = firstBatchRaw.map((doc) => transformRawPost(doc as Record<string, unknown>));
  const firstBatchCursor = (firstBatchRaw[firstBatchRaw.length - 1].$id ||
    firstBatchRaw[firstBatchRaw.length - 1].id) as string;

  logger.info(`Feed: First batch has ${firstBatchPosts.length} posts`);

  const forYouNextCursor: string | null = firstBatchCursor;
  const forYouHasMore = firstBatchRaw.length === 20;

  enrichPostsWithRepostsAndQuotes(firstBatchPosts)
    .then(() => {
      options.setData((current) => (current ? [...current] : current));
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
      let bgLastBatchSize = firstBatchRaw.length;

      while (
        allPostCount < MIN_NON_REPLY_POSTS &&
        bgFetchIteration < MAX_FETCH_ITERATIONS &&
        bgLastBatchSize === 20
      ) {
        bgFetchIteration++;
        logger.info(`Feed: Loading posts starting after ${bgCurrentStartAfter} (iteration ${bgFetchIteration})`);

        const bgRawPosts = await dashClient.queryPosts({
          limit: 20,
          forceRefresh: false,
          startAfter: bgCurrentStartAfter,
          language: options.feedLanguage,
        });

        bgLastBatchSize = bgRawPosts.length;

        if (bgRawPosts.length === 0) {
          logger.info('Feed: No more posts available (background)');
          options.setHasMore(false);
          break;
        }

        const bgPosts = bgRawPosts.map((doc) => transformRawPost(doc as Record<string, unknown>));

        enrichPostsWithRepostsAndQuotes(bgPosts)
          .then(() => {
            options.setData((current) => (current ? [...current] : current));
          })
          .catch((error) => {
            logger.error('Feed: Error enriching background batch:', error);
          });

        allPostCount += bgPosts.length;

        const lastPost = bgRawPosts[bgRawPosts.length - 1];
        bgCurrentStartAfter = (lastPost.$id || lastPost.id) as string;

        options.setData((currentItems) => {
          if (!currentItems) return bgPosts;

          const existingIds = new Set(currentItems.map((item) => item.id));
          const newItems = bgPosts.filter((post) => !existingIds.has(post.id));
          const allItems = sortFeedByTimestamp([...currentItems, ...newItems]);

          logger.info(`Feed: Background added ${newItems.length} posts (total: ${allItems.length})`);
          return allItems;
        });

        options.enrichProgressively(bgPosts);
        options.setLastPostId(bgCurrentStartAfter);

        if (allPostCount < MIN_NON_REPLY_POSTS && bgFetchIteration < MAX_FETCH_ITERATIONS) {
          logger.info(`Feed: Only ${allPostCount} posts, fetching more... (need ${MIN_NON_REPLY_POSTS})`);
        }
      }

      options.setHasMore(bgLastBatchSize === 20);
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
  };
}
