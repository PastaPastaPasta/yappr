import { useCallback, useEffect, useState } from 'react';
import { logger } from '@/lib/logger';
import { useAuth } from '@/contexts/auth-context';
import { checkBlockedForAuthors } from '@/hooks/use-block';
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

  const load = useCallback(
    async (force = false) => {
      if (!likesAreIndexOnly()) {
        setPosts([]);
        return;
      }
      if (activeTab === 'following' && !userId) {
        setPosts([]);
        return;
      }

      setIsLoading(true);
      try {
        const { topLikedPostsHydrated, topLikedPostsByAuthorsHydrated } = await import('@/lib/services/ranked-likes');
        let ranked: Post[];
        if (activeTab === 'following' && userId) {
          const authorIds = await followService.getFollowingIds(userId);
          ranked = await topLikedPostsByAuthorsHydrated({ authorIds, limit: 20, window, force });
        } else {
          ranked = await topLikedPostsHydrated({ limit: 20, window, force });
        }

        if (userId && ranked.length > 0) {
          const authorIds = Array.from(new Set(ranked.map((post) => post.author.id)));
          const blockedMap = await checkBlockedForAuthors(userId, authorIds);
          ranked = ranked.filter((post) => !blockedMap.get(post.author.id));
        }

        setPosts(ranked);
      } catch (error) {
        logger.error('Feed: Failed to load top posts:', error);
        setPosts([]);
      } finally {
        setIsLoading(false);
      }
    },
    [activeTab, userId, window]
  );

  useEffect(() => {
    if (!enabled) return;
    setPosts(null);
    load().catch((error) => logger.error('Feed: top posts load failed:', error));
  }, [enabled, load]);

  const refresh = useCallback(() => load(true), [load]);

  const handlePostDelete = useCallback((postId: string) => {
    setPosts((current) => (current ? current.filter((post) => post.id !== postId) : current));
  }, []);

  return { posts, isLoading, refresh, handlePostDelete };
}
