'use client';

import { TrophyIcon } from '@heroicons/react/24/outline';
import { Post } from '@/lib/types';
import ErrorBoundary from '@/components/error-boundary';
import { Spinner } from '@/components/ui/spinner';
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel';
import { PostCard } from '@/components/post/post-card';
import { useSettingsStore } from '@/lib/store';
import { useAuth } from '@/contexts/auth-context';
import { filterHiddenSensitive } from '@/lib/sensitive-content';
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll';
import type { FeedTab } from '@/hooks/use-feed-data';
import type { RankingWindow } from '@/lib/services/ranked-likes';

interface FeedTopListProps {
  posts: Post[] | null;
  isLoading: boolean;
  activeTab: FeedTab;
  /** Which ranking is showing; with `activeTab` it identifies the list being paged. */
  rankingWindow: RankingWindow;
  onPostDelete: (postId: string) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => Promise<void>;
}

/**
 * The home feed's Top view: the proved ranked list (global, or merged across
 * followed authors), already hydrated and enriched by `useTopFeed`. Scrolling
 * to the end widens the ranking by another page.
 */
export function FeedTopList({ posts, isLoading, activeTab, rankingWindow, onPostDelete, hasMore, isLoadingMore, onLoadMore }: FeedTopListProps) {
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode);
  const { user } = useAuth();
  const { sentinelRef, isSuspended, loadMore } = useInfiniteScroll({
    hasMore,
    isLoading: isLoading || isLoadingMore,
    onLoadMore,
    resetKey: `${activeTab}:${rankingWindow}`,
  });

  if (isLoading || posts === null) {
    return (
      <div className="p-8 text-center">
        <Spinner size="md" className="mx-auto mb-4" />
        <p className="text-gray-500">Loading top posts...</p>
      </div>
    );
  }

  const visiblePosts = filterHiddenSensitive(posts, sensitiveContentMode, user?.identityId);

  if (visiblePosts.length === 0) {
    return (
      <div className="p-8 text-center" data-testid="feed-top-empty">
        <TrophyIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500">No liked posts yet</p>
        <p className="text-sm text-gray-400 mt-1">
          {activeTab === 'following'
            ? 'The most-liked posts from people you follow will appear here'
            : 'The most-liked posts will appear here'}
        </p>
      </div>
    );
  }

  return (
    <ErrorBoundary level="component">
      <div className="divide-y divide-gray-200 dark:divide-gray-800" data-testid="feed-top-list">
        {visiblePosts.map((post) => (
          <ErrorBoundary key={post.id} level="component">
            <PostCard post={post} onDelete={onPostDelete} />
          </ErrorBoundary>
        ))}
        {hasMore && (
          <InfiniteScrollSentinel
            sentinelRef={sentinelRef}
            isLoading={isLoadingMore}
            isSuspended={isSuspended}
            onLoadMore={loadMore}
            className="border-t border-gray-200 dark:border-gray-800"
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
