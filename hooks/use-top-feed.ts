import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '@/lib/logger';
import { useAuth } from '@/contexts/auth-context';
import { filterBlockedAuthors } from '@/hooks/use-block';
import { followService } from '@/lib/services';
import type { Post } from '@/lib/types';
import type { RankingWindow } from '@/lib/services/ranked-likes';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import type { FeedTab } from '@/hooks/use-feed-data';

interface UseTopFeedOptions {
  /** Which feed the ranking scopes to: global for `forYou`, followed authors for `following`. */
  activeTab: FeedTab;
  /** `'today'` reads the v6 daily-windowed twin; `'all'` is all-time. */
  window: RankingWindow;
  /** Only load while the Top view is showing. */
  enabled: boolean;
}

interface UseTopFeedResult {
  posts: Post[] | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
  handlePostDelete: (postId: string) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
}

/**
 * The Top view of the home feed: the proved most-liked ranking, global for
 * For You and merged across followed authors for Following (see
 * `topLikedPostsByAuthorsHydrated`). Blocked authors are filtered the way the
 * Explore Top tab does. v4+ only — on older topologies nothing loads and the
 * page never offers the toggle (`likesAreIndexOnly()`).
 */
export function useTopFeed({ activeTab, window, enabled }: UseTopFeedOptions): UseTopFeedResult {
  const { user } = useAuth();
  const userId = user?.identityId;
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Following Top fans out one ranked read per followed author and can settle
  // well after a For You Top read issued later; only the newest request may
  // touch state, so a superseded response never overwrites the current view.
  const requestIdRef = useRef(0);
  const [limit, setLimit] = useState(20);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const load = useCallback(
    async (requestedLimit = 20, force = false, incremental = false) => {
      const requestId = ++requestIdRef.current;
      const isCurrent = () => requestIdRef.current === requestId;

      if (!likesAreIndexOnly() || (activeTab === 'following' && !userId)) {
        setPosts([]);
        setIsLoading(false);
        setIsLoadingMore(false);
        return;
      }

      setIsLoading(!incremental);
      setIsLoadingMore(incremental);
      try {
        const { topLikedPostsHydrated, topLikedPostsByAuthorsHydrated } = await import('@/lib/services/ranked-likes');
        let ranked: Post[];
        if (activeTab === 'following' && userId) {
          const authorIds = await followService.getFollowingIds(userId);
          ranked = await topLikedPostsByAuthorsHydrated({ authorIds, limit: requestedLimit, window, force, throwOnError: true });
        } else {
          ranked = await topLikedPostsHydrated({ limit: requestedLimit, window, force, throwOnError: true });
        }
        const visible = await filterBlockedAuthors(userId, ranked);
        if (isCurrent()) {
          setPosts(visible);
          setLimit(requestedLimit);
        }
      } catch (error) {
        logger.error('Feed: Failed to load top posts:', error);
        // A failed incremental request must leave the already-loaded page
        // readable and allow retrying the same next limit.
        if (isCurrent() && !incremental) setPosts([]);
      } finally {
        if (isCurrent()) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [activeTab, userId, window]
  );

  useEffect(() => {
    if (!enabled) return;
    setPosts(null);
    setLimit(20);
    load().catch((error) => logger.error('Feed: top posts load failed:', error));
    const requests = requestIdRef;
    return () => { ++requests.current; };
  }, [enabled, load]);

  const refresh = useCallback(() => load(20, true), [load]);

  const loadMore = useCallback(async () => {
    if (!enabled || isLoading || isLoadingMore || posts === null || posts.length < limit) return;
    await load(limit + 20, false, true);
  }, [enabled, isLoading, isLoadingMore, limit, load, posts]);

  const handlePostDelete = useCallback((postId: string) => {
    setPosts((current) => (current ? current.filter((post) => post.id !== postId) : current));
  }, []);

  return { posts, isLoading, refresh, handlePostDelete, hasMore: posts !== null && posts.length >= limit, isLoadingMore, loadMore };
}
