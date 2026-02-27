import { logger } from '@/lib/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useAsyncState } from '@/components/ui/loading-state';
import { Post } from '@/lib/types';
import { cacheManager } from '@/lib/cache-manager';
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment';
import { loadFollowingFeed, type FollowingFeedWindow } from '@/lib/feed/load-following-feed';
import { loadForYouFeed } from '@/lib/feed/load-for-you-feed';
import { getFeedItemTimestamp, sortFeedByTimestamp, transformRawPost } from '@/lib/feed/transform-raw-post';
import { followService, postService } from '@/lib/services';
import { queryPostsByOwnersSince, queryPostsSince } from '@/lib/services/document-service';

export type FeedTab = 'forYou' | 'following';
type FeedPost = Post & { _syncPending?: boolean };

interface PostCreatedEventDetail {
  post?: unknown;
  postId?: string;
  confirmed?: boolean;
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return null;
}

function normalizePostId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
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
  const reconcilingPostIdsRef = useRef<Set<string>>(new Set());

  const {
    enrichProgressively,
    enrichmentState,
    reset: resetEnrichment,
    getPostEnrichment,
  } = useProgressiveEnrichment({
    currentUserId: user?.identityId,
    skipFollowStatus: activeTab === 'following',
  });

  const normalizeCreatedPost = useCallback(
    (rawPost: unknown, fallbackPostId?: string, confirmed = true): FeedPost | null => {
      const postRecord = asRecord(rawPost) || {};
      const resolvedPostId =
        normalizePostId(postRecord.id) ||
        normalizePostId(postRecord.$id) ||
        normalizePostId(postRecord.postId) ||
        normalizePostId(fallbackPostId);

      if (!resolvedPostId) return null;

      const transformed = transformRawPost({
        ...postRecord,
        id: postRecord.id || resolvedPostId,
        $id: postRecord.$id || resolvedPostId,
      }) as FeedPost;

      const authorRecord = asRecord(postRecord.author);
      if (authorRecord) {
        transformed.author = {
          ...transformed.author,
          username: typeof authorRecord.username === 'string' ? authorRecord.username : transformed.author.username,
          displayName:
            typeof authorRecord.displayName === 'string' ? authorRecord.displayName : transformed.author.displayName,
          avatar: typeof authorRecord.avatar === 'string' ? authorRecord.avatar : transformed.author.avatar,
          followers: typeof authorRecord.followers === 'number' ? authorRecord.followers : transformed.author.followers,
          following: typeof authorRecord.following === 'number' ? authorRecord.following : transformed.author.following,
          verified: typeof authorRecord.verified === 'boolean' ? authorRecord.verified : transformed.author.verified,
          hasDpns: typeof authorRecord.hasDpns === 'boolean' ? authorRecord.hasDpns : transformed.author.hasDpns,
        };
      }

      if (transformed.author.id === 'unknown' && user?.identityId) {
        transformed.author = { ...transformed.author, id: user.identityId };
      }

      transformed._syncPending = !confirmed;
      return transformed;
    },
    [user?.identityId]
  );

  const reconcileCreatedPost = useCallback(
    async (postId: string): Promise<void> => {
      if (!postId || reconcilingPostIdsRef.current.has(postId)) return;

      reconcilingPostIdsRef.current.add(postId);

      try {
        const delaysMs = [250, 500, 1000, 2000, 4000];

        for (let i = 0; i < delaysMs.length; i++) {
          const canonicalPost = await postService.getPostById(postId);

          if (canonicalPost) {
            setData((currentItems) => {
              const existing = currentItems || [];
              let found = false;
              const merged = existing.map((item) => {
                if (item.id !== postId) return item;
                found = true;
                return {
                  ...item,
                  ...canonicalPost,
                  _syncPending: false,
                } as FeedPost;
              });

              if (!found) {
                merged.unshift({ ...canonicalPost, _syncPending: false } as FeedPost);
              }

              return sortFeedByTimestamp(merged);
            });

            enrichProgressively([canonicalPost]);
            cacheManager.clear('feed');
            setNewestPostTimestamp((prev) => Math.max(prev || 0, getFeedItemTimestamp(canonicalPost)));
            return;
          }

          if (i < delaysMs.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
          }
        }
      } catch (error) {
        logger.error('Feed: Failed to reconcile created post:', error);
      } finally {
        reconcilingPostIdsRef.current.delete(postId);
      }
    },
    [enrichProgressively, setData]
  );

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
      const OVERLAP_MS = 2000;
      const sinceTimestamp = Math.max(0, newestPostTimestamp - OVERLAP_MS);

      let newPosts: Array<Record<string, unknown>> = [];

      if (activeTab === 'following' && user?.identityId) {
        const following = await followService.getFollowing(user.identityId);
        const followingIds = extractFollowedIds(following as unknown as Array<Record<string, unknown>>);

        if (followingIds.length > 0) {
          newPosts = await queryPostsByOwnersSince(followingIds, sinceTimestamp, 50);
        }
      } else {
        newPosts = await queryPostsSince(sinceTimestamp, 50, feedLanguage || 'en');
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
    const handlePostCreated = (event: Event) => {
      const customEvent = event as CustomEvent<PostCreatedEventDetail>;
      const detail = customEvent.detail || {};
      const createdPost = normalizeCreatedPost(detail.post, detail.postId, detail.confirmed !== false);

      if (!createdPost) {
        resetEnrichment();
        loadPosts(true).catch((error) => logger.error('Failed to load posts:', error));
        return;
      }

      cacheManager.clear('feed');

      setData((currentItems) => {
        const existing = currentItems || [];
        const existingIds = new Set(existing.map((item) => item.id));
        const merged = existingIds.has(createdPost.id)
          ? existing.map((item) => (item.id === createdPost.id ? ({ ...item, ...createdPost } as FeedPost) : item))
          : ([createdPost, ...existing] as FeedPost[]);

        return sortFeedByTimestamp(merged);
      });

      enrichProgressively([createdPost]);
      setNewestPostTimestamp((prev) => Math.max(prev || 0, getFeedItemTimestamp(createdPost)));

      reconcileCreatedPost(createdPost.id).catch((error) =>
        logger.error('Failed to reconcile created post:', error)
      );
    };

    window.addEventListener('post-created', handlePostCreated as EventListener);
    return () => {
      window.removeEventListener('post-created', handlePostCreated as EventListener);
    };
  }, [enrichProgressively, loadPosts, normalizeCreatedPost, reconcileCreatedPost, resetEnrichment, setData]);

  useEffect(() => {
    resetEnrichment();
    setData(null);
    setLastPostId(null);
    setFollowingNextWindow(null);
    setHasMore(true);
    setPendingNewPosts([]);
    setNewestPostTimestamp(null);

    loadPosts().catch((error) => logger.error('Failed to load posts:', error));
  }, [activeTab, loadPosts, resetEnrichment, setData]);

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
  }, [enrichmentState.blockStatus, posts]);

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
