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
import { followService } from '@/lib/services';
import { queryPostsByOwnersSince, queryPostsSince } from '@/lib/services/document-service';

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

function normalizeRelationId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function extractFollowedIds(following: Array<Record<string, unknown>>): string[] {
  const ids = following
    .map((followed) =>
      normalizeRelationId(
        followed.followingId ??
          followed.followedId ??
          followed.following ??
          followed.$id
      )
    )
    .filter((id): id is string => Boolean(id));

  return Array.from(new Set(ids));
}

export function useFeedData({ activeTab, feedLanguage }: UseFeedDataOptions): UseFeedDataResult {
  const { user } = useAuth();

  const postsState = useAsyncState<Post[]>(null);
  const {
    data: posts,
    loading: isLoading,
    error,
    setData,
    setLoading,
    setError,
  } = postsState;
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
              const newestTimestamp = Math.max(...cached.map(getFeedItemTimestamp));
              setNewestPostTimestamp(newestTimestamp);
            }
            setPendingNewPosts([]);

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

        setData([]);

        if (errorMessage.includes('Contract ID not configured') || errorMessage.includes('Not logged in')) {
          setError(errorMessage);
        }
      } finally {
        setLoading(false);
      }
    },
    [activeTab, enrichProgressively, feedLanguage, setData, setError, setLoading, user?.identityId]
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
    if (!newestPostTimestamp || isLoading) return;

    try {
      logger.info('Feed: Checking for new posts since', new Date(newestPostTimestamp).toISOString());

      let newPosts: Array<Record<string, unknown>> = [];

      if (activeTab === 'following' && user?.identityId) {
        const following = await followService.getFollowing(user.identityId);
        const followingIds = extractFollowedIds(following as unknown as Array<Record<string, unknown>>);

        if (followingIds.length > 0) {
          newPosts = await queryPostsByOwnersSince(followingIds, newestPostTimestamp, 50);
        }
      } else {
        newPosts = await queryPostsSince(newestPostTimestamp, 50, feedLanguage || 'en');
      }

      if (newPosts.length === 0) return;

      logger.info(`Feed: Found ${newPosts.length} new posts`);

      const transformedPosts = newPosts.map((doc) => transformRawPost(doc));
      sortFeedByTimestamp(transformedPosts);

      const existingIds = new Set([
        ...(posts || []).map((item) => item.id),
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
  }, [activeTab, feedLanguage, isLoading, newestPostTimestamp, pendingNewPosts, posts, user?.identityId]);

  const showNewPosts = useCallback(() => {
    if (pendingNewPosts.length === 0) return;

    const newestPendingTimestamp = Math.max(...pendingNewPosts.map(getFeedItemTimestamp));

    setData((currentItems) => {
      const existing = currentItems || [];
      return [...pendingNewPosts, ...existing];
    });

    enrichProgressively(pendingNewPosts);
    setNewestPostTimestamp(newestPendingTimestamp);
    setPendingNewPosts([]);
  }, [enrichProgressively, pendingNewPosts, setData]);

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
    setData(null);
    setLastPostId(null);
    setFollowingNextWindow(null);
    setHasMore(true);
    setPendingNewPosts([]);
    setNewestPostTimestamp(null);

    loadPosts().catch((error) => logger.error('Failed to load posts:', error));
  }, [activeTab, loadPosts, resetEnrichment]);

  const handlePostDelete = useCallback(
    (postId: string) => {
      setData((prevData) => {
        if (!prevData) return prevData;
        return prevData.filter((item) => item.id !== postId);
      });
    },
    [setData]
  );

  const filteredPosts = useMemo(() => {
    if (!posts) return null;

    return posts.filter((post) => {
      if (enrichmentState.blockStatus.size > 0 && enrichmentState.blockStatus.get(post.author.id)) {
        return false;
      }
      return true;
    });
  }, [activeTab, enrichmentState.blockStatus, posts]);

  return {
    posts,
    filteredPosts,
    isLoading,
    error,
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
