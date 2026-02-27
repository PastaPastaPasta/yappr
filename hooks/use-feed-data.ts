import { logger } from '@/lib/logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useAsyncState } from '@/components/ui/loading-state';
import { Post } from '@/lib/types';
import { cacheManager } from '@/lib/cache-manager';
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment';
import { loadFollowingFeed, type FollowingFeedWindow } from '@/lib/feed/load-following-feed';
import { loadForYouFeed } from '@/lib/feed/load-for-you-feed';
import { getFeedItemTimestamp, sortFeedByTimestamp, transformRawPost } from '@/lib/feed/transform-raw-post';
import { followService, getEvoSdk } from '@/lib/services';
import { normalizeSDKResponse } from '@/lib/services/sdk-helpers';
import { YAPPR_CONTRACT_ID } from '@/lib/constants';

export type FeedTab = 'forYou' | 'following';

interface UseFeedDataOptions {
  activeTab: FeedTab;
  feedLanguage?: string;
}

interface FeedLoadPagination {
  startAfter?: string;
  timeWindow?: FollowingFeedWindow;
}

interface UseFeedDataResult {
  posts: Post[] | null;
  filteredPosts: Post[] | null;
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  pendingNewPosts: Post[];
  loadMore: () => Promise<void>;
  showNewPosts: () => void;
  refresh: () => Promise<void>;
  handlePostDelete: (postId: string) => void;
  getPostEnrichment: ReturnType<typeof useProgressiveEnrichment>['getPostEnrichment'];
}

export function useFeedData({ activeTab, feedLanguage }: UseFeedDataOptions): UseFeedDataResult {
  const { user } = useAuth();

  const postsState = useAsyncState<Post[]>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [lastPostId, setLastPostId] = useState<string | null>(null);
  const [followingNextWindow, setFollowingNextWindow] = useState<FollowingFeedWindow | null>(null);
  const [pendingNewPosts, setPendingNewPosts] = useState<Post[]>([]);
  const [newestPostTimestamp, setNewestPostTimestamp] = useState<number | null>(null);

  const {
    enrichProgressively,
    enrichmentState,
    reset: resetEnrichment,
    getPostEnrichment,
  } = useProgressiveEnrichment({
    currentUserId: user?.identityId,
    skipFollowStatus: activeTab === 'following',
  });

  const loadPosts = useCallback(
    async (forceRefresh = false, pagination?: FeedLoadPagination) => {
      const { setLoading, setError, setData } = postsState;
      const isPaginating = Boolean(pagination?.startAfter || pagination?.timeWindow);

      if (!isPaginating) {
        setLoading(true);
      }
      setError(null);

      try {
        if (activeTab === 'following' && !user?.identityId) {
          logger.info('Feed: Skipping Following feed load - user not logged in');
          setLoading(false);
          return;
        }

        logger.info(`Feed: Loading ${activeTab} posts from Dash Platform...`, isPaginating ? '(paginating)' : '');

        const cacheKey =
          activeTab === 'following'
            ? `feed_following_${user?.identityId}`
            : `feed_for_you_${feedLanguage || 'all'}`;

        if (!forceRefresh && !isPaginating) {
          const cached = cacheManager.get<Post[]>('feed', cacheKey);
          if (cached) {
            logger.info('Feed: Using cached data');
            setData(cached);
            setLoading(false);

            if (cached.length > 0) {
              setLastPostId(cached[cached.length - 1].id);
              setHasMore(cached.length >= 20);
            }

            enrichProgressively(cached);
            return;
          }
        }

        let posts: Post[] = [];

        if (activeTab === 'following' && user?.identityId) {
          let followingPosts: Post[] = [];
          let followingCursor: FollowingFeedWindow | null = null;
          let followingHasMore = false;

          await loadFollowingFeed({
            userId: user.identityId,
            timeWindow: pagination?.timeWindow,
            forceRefresh,
            onBatchReady: (batchPosts, nextWindow, batchHasMore) => {
              followingPosts = batchPosts;
              followingCursor = nextWindow;
              followingHasMore = batchHasMore;
            },
            enrichProgressively,
          });

          setFollowingNextWindow(followingCursor);
          setHasMore(followingHasMore);

          if (followingPosts.length === 0) {
            logger.info('Feed: No posts in this time window, cursor points to next window');
            if (!isPaginating) {
              setData([]);
            }
            return;
          }

          posts = followingPosts;
        } else {
          const forYouResult = await loadForYouFeed({
            startAfter: pagination?.startAfter,
            forceRefresh,
            feedLanguage,
            setData,
            setHasMore,
            setLastPostId,
            enrichProgressively,
          });

          posts = forYouResult.posts;

          if (posts.length === 0) {
            logger.info('Feed: No posts found on platform');
            if (!isPaginating) {
              setData([]);
            }
            setHasMore(false);
            return;
          }

          if (forYouResult.cursor) {
            setLastPostId(forYouResult.cursor);
          }
          setHasMore(forYouResult.hasMore);
        }

        const sortedPosts = sortFeedByTimestamp(posts);

        if (isPaginating) {
          setData((currentItems) => {
            const existingIds = new Set((currentItems || []).map((item) => item.id));
            const newItems = sortedPosts.filter((item) => !existingIds.has(item.id));
            const allItems = [...(currentItems || []), ...newItems];
            logger.info(
              `Feed: Appended ${newItems.length} new items (${sortedPosts.length - newItems.length} duplicates filtered)`
            );
            return allItems;
          });
        } else {
          setData(sortedPosts);

          if (sortedPosts.length > 0) {
            const newestTimestamp = Math.max(...sortedPosts.map(getFeedItemTimestamp));
            setNewestPostTimestamp(newestTimestamp);
            setPendingNewPosts([]);
          }
        }

        if (activeTab !== 'following') {
          enrichProgressively(sortedPosts);
        }

        if (!isPaginating && sortedPosts.length > 0) {
          cacheManager.set('feed', cacheKey, sortedPosts);
        }
      } catch (error) {
        logger.error('Feed: Failed to load posts from platform:', error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.info('Feed: Falling back to empty state due to error:', errorMessage);

        postsState.setData([]);

        if (errorMessage.includes('Contract ID not configured') || errorMessage.includes('Not logged in')) {
          postsState.setError(errorMessage);
        }
      } finally {
        postsState.setLoading(false);
      }
    },
    [activeTab, enrichProgressively, feedLanguage, postsState, user?.identityId]
  );

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;

    if (activeTab === 'following') {
      if (!followingNextWindow) return;
    } else if (!lastPostId) {
      return;
    }

    setIsLoadingMore(true);
    try {
      if (activeTab === 'following' && followingNextWindow) {
        await loadPosts(false, { timeWindow: followingNextWindow });
      } else if (lastPostId) {
        await loadPosts(false, { startAfter: lastPostId });
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [activeTab, followingNextWindow, hasMore, isLoadingMore, lastPostId, loadPosts]);

  const checkForNewPosts = useCallback(async () => {
    if (!newestPostTimestamp || postsState.loading) return;

    try {
      logger.info('Feed: Checking for new posts since', new Date(newestPostTimestamp).toISOString());

      let newPosts: Array<Record<string, unknown>> = [];

      if (activeTab === 'following' && user?.identityId) {
        const following = await followService.getFollowing(user.identityId);
        const followingIds = following.map((followed) => followed.followingId);

        if (followingIds.length > 0) {
          const sdk = await getEvoSdk();

          const response = await sdk.documents.query({
            dataContractId: YAPPR_CONTRACT_ID,
            documentTypeName: 'post',
            where: [
              ['$ownerId', 'in', followingIds],
              ['$createdAt', '>', newestPostTimestamp],
            ],
            orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
            limit: 50,
          });

          newPosts = normalizeSDKResponse(response);
        }
      } else {
        const sdk = await getEvoSdk();

        const response = await sdk.documents.query({
          dataContractId: YAPPR_CONTRACT_ID,
          documentTypeName: 'post',
          where: [['$createdAt', '>', newestPostTimestamp]],
          orderBy: [['$createdAt', 'desc']],
          limit: 50,
        });

        newPosts = normalizeSDKResponse(response);
      }

      if (newPosts.length === 0) return;

      logger.info(`Feed: Found ${newPosts.length} new posts`);

      const transformedPosts = newPosts.map((doc) => transformRawPost(doc));
      sortFeedByTimestamp(transformedPosts);

      const existingIds = new Set([
        ...(postsState.data || []).map((item) => item.id),
        ...pendingNewPosts.map((item) => item.id),
      ]);

      const uniqueNewPosts = transformedPosts.filter((post) => !existingIds.has(post.id));

      if (uniqueNewPosts.length > 0) {
        logger.info(`Feed: ${uniqueNewPosts.length} unique new posts to show`);
        setPendingNewPosts((prev) => [...uniqueNewPosts, ...prev]);
      }
    } catch (error) {
      logger.error('Feed: Error checking for new posts:', error);
    }
  }, [activeTab, newestPostTimestamp, pendingNewPosts, postsState.data, postsState.loading, user?.identityId]);

  const showNewPosts = useCallback(() => {
    if (pendingNewPosts.length === 0) return;

    const newestPendingTimestamp = Math.max(...pendingNewPosts.map(getFeedItemTimestamp));

    postsState.setData((currentItems) => {
      const existing = currentItems || [];
      return [...pendingNewPosts, ...existing];
    });

    enrichProgressively(pendingNewPosts);
    setNewestPostTimestamp(newestPendingTimestamp);
    setPendingNewPosts([]);
  }, [enrichProgressively, pendingNewPosts, postsState]);

  const refresh = useCallback(async () => {
    resetEnrichment();
    await loadPosts(true);
  }, [loadPosts, resetEnrichment]);

  useEffect(() => {
    if (!newestPostTimestamp) return;

    const intervalId = setInterval(() => {
      checkForNewPosts().catch((error) => logger.error('Failed to check for new posts:', error));
    }, 15000);

    return () => clearInterval(intervalId);
  }, [checkForNewPosts, newestPostTimestamp]);

  useEffect(() => {
    const handlePostCreated = () => {
      resetEnrichment();
      loadPosts(true).catch((error) => logger.error('Failed to load posts:', error));
    };

    window.addEventListener('post-created', handlePostCreated);
    return () => {
      window.removeEventListener('post-created', handlePostCreated);
    };
  }, [loadPosts, resetEnrichment]);

  useEffect(() => {
    resetEnrichment();
    postsState.setData(null);
    setLastPostId(null);
    setFollowingNextWindow(null);
    setHasMore(true);
    setPendingNewPosts([]);
    setNewestPostTimestamp(null);

    loadPosts().catch((error) => logger.error('Failed to load posts:', error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handlePostDelete = useCallback(
    (postId: string) => {
      postsState.setData((prevData) => {
        if (!prevData) return prevData;
        return prevData.filter((item) => item.id !== postId);
      });
    },
    [postsState]
  );

  const filteredPosts = useMemo(() => {
    if (!postsState.data) return null;

    return postsState.data.filter((post) => {
      if (enrichmentState.blockStatus.size > 0 && enrichmentState.blockStatus.get(post.author.id)) {
        return false;
      }
      return true;
    });
  }, [activeTab, enrichmentState.blockStatus, postsState.data]);

  return {
    posts: postsState.data,
    filteredPosts,
    isLoading: postsState.loading,
    error: postsState.error,
    hasMore,
    isLoadingMore,
    pendingNewPosts,
    loadMore,
    showNewPosts,
    refresh,
    handlePostDelete,
    getPostEnrichment,
  };
}
