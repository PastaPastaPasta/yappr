import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '@/lib/logger';
import { useAuth } from '@/contexts/auth-context';
import { filterBlockedAuthors } from '@/hooks/use-block';
import { followService } from '@/lib/services';
import type { Post } from '@/lib/types';
import type { RankingWindow } from '@/lib/services/ranked-likes';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import type { FeedTab } from '@/hooks/use-feed-data';

/** How many ranked posts one page asks for; each load-more widens the ranking by this much. */
const PAGE_SIZE = 20;

/** Drive's `max_query_limit`: a ranked read wider than this is rejected outright. */
const MAX_RANKED_LIMIT = 100;

interface UseTopFeedOptions {
  /** Which feed the ranking scopes to: global for `forYou`, followed authors for `following`. */
  activeTab: FeedTab;
  /** `'today'` reads the v9 daily-windowed twin; `'all'` is all-time. */
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
  /** Widens the ranking by one page. Rejects when the wider read fails, so the caller can offer a retry. */
  loadMore: () => Promise<void>;
}

interface LoadOptions {
  /** Bypass the ranked-page cache. */
  force?: boolean;
  /** Keep the current list on screen while the wider page loads. */
  append?: boolean;
}

/**
 * The Top view of the home feed: the proved most-liked ranking, global for
 * For You and merged across followed authors for Following (see
 * `topLikedPostsByAuthorsHydrated`). Blocked authors are filtered the way the
 * Explore Top tab does. v9 only — on v2 nothing loads and the
 * page never offers the toggle (`likesAreIndexOnly()`).
 *
 * A ranking is a bounded top-K rather than a cursor-paged timeline, so "more"
 * re-reads the ranking with a larger K. Posts already on screen keep their
 * place and only the genuinely new ids are appended, so a like-count shuffle
 * between reads never reorders the list under the reader.
 */
export function useTopFeed({ activeTab, window, enabled }: UseTopFeedOptions): UseTopFeedResult {
  const { user } = useAuth();
  const userId = user?.identityId;
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Following Top fans out one ranked read per followed author and can settle
  // well after a For You Top read issued later; only the newest request may
  // touch state, so a superseded response never overwrites the current view.
  const requestIdRef = useRef(0);
  // Raw size of the last ranked page (before block filtering). The next K is
  // derived from it rather than accumulated, so two overlapping load-more
  // calls cannot skip a page.
  const rankedCountRef = useRef(0);

  const load = useCallback(
    async ({ force = false, append = false }: LoadOptions = {}) => {
      const requestId = ++requestIdRef.current;
      const isCurrent = () => requestIdRef.current === requestId;

      if (!likesAreIndexOnly() || (activeTab === 'following' && !userId)) {
        setPosts([]);
        setHasMore(false);
        setIsLoading(false);
        setIsLoadingMore(false);
        return;
      }

      const limit = append ? Math.min(rankedCountRef.current + PAGE_SIZE, MAX_RANKED_LIMIT) : PAGE_SIZE;
      // A widening always bypasses the cache: its wider limit is a cold key
      // anyway, and a retry should re-read rather than serve a page that was
      // already on screen when the previous attempt failed.
      const bypassCache = force || append;
      if (append) setIsLoadingMore(true);
      else setIsLoading(true);
      try {
        const { topLikedPostsHydrated, topLikedPostsByAuthorsHydrated } = await import('@/lib/services/ranked-likes');
        let ranked: Post[];
        if (activeTab === 'following' && userId) {
          const authorIds = await followService.getFollowingIds(userId);
          ranked = await topLikedPostsByAuthorsHydrated({ authorIds, limit, window, force: bypassCache, throwOnError: true });
        } else {
          ranked = await topLikedPostsHydrated({ limit, window, force: bypassCache, throwOnError: true });
        }
        // `throwOnError` makes a failed ranking or hydration reject rather than
        // degrade to an empty page, so an empty result here is genuinely the
        // end of the ranking and never a swallowed error.
        const visible = await filterBlockedAuthors(userId, ranked);
        if (!isCurrent()) return;
        rankedCountRef.current = ranked.length;
        setPosts((current) => {
          if (!append || !current) return visible;
          const known = new Set(current.map((post) => post.id));
          return [...current, ...visible.filter((post) => !known.has(post.id))];
        });
        // Judged on the ranked page, not the block-filtered one, so a filtered
        // author never makes a full page look like the end of the ranking.
        setHasMore(ranked.length >= limit && limit < MAX_RANKED_LIMIT);
      } catch (error) {
        logger.error('Feed: Failed to load top posts:', error);
        if (!isCurrent()) return;
        // A failed widening keeps what is already on screen and rejects so the
        // caller can offer a retry; a failed first page shows empty.
        if (append) throw error;
        setPosts([]);
        setHasMore(false);
      } finally {
        if (isCurrent()) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [activeTab, userId, window]
  );

  // A different ranking (tab, window, or viewer) starts from the first page.
  useEffect(() => {
    if (!enabled) return;
    setPosts(null);
    load().catch((error) => logger.error('Feed: top posts load failed:', error));
  }, [enabled, load]);

  const refresh = useCallback(() => load({ force: true }), [load]);

  const loadMore = useCallback(async () => {
    if (isLoading || isLoadingMore || !hasMore) return;
    await load({ append: true });
  }, [isLoading, isLoadingMore, hasMore, load]);

  const handlePostDelete = useCallback((postId: string) => {
    setPosts((current) => (current ? current.filter((post) => post.id !== postId) : current));
  }, []);

  return { posts, isLoading, refresh, handlePostDelete, hasMore, isLoadingMore, loadMore };
}
