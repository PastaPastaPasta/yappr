'use client';

import { Post } from '@/lib/types';
import ErrorBoundary from '@/components/error-boundary';
import { LoadingState } from '@/components/ui/loading-state';
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel';
import { LegacyYapprLink } from '@/components/ui/legacy-yappr-link';
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll';
import { PostCard } from '@/components/post/post-card';
import { useSettingsStore } from '@/lib/store';
import { useAuth } from '@/contexts/auth-context';
import { filterHiddenSensitive } from '@/lib/sensitive-content';

interface FeedPostListProps {
  posts: Post[] | null;
  isLoading: boolean;
  error: string | null;
  activeTab: 'forYou' | 'following';
  hasMore: boolean;
  isLoadingMore: boolean;
  pendingNewPosts: Post[];
  onShowNewPosts: () => void;
  onLoadMore: () => Promise<void>;
  onRetry: () => void;
  onPostDelete: (postId: string) => void;
  getPostEnrichment: (post: Post) => {
    username: string | null | undefined;
    displayName: string | undefined;
    avatarUrl: string | undefined;
    stats: { likes: number; reposts: number; replies: number; quotes: number; views: number } | undefined;
    interactions: { liked: boolean; reposted: boolean; bookmarked: boolean } | undefined;
    isBlocked: boolean | undefined;
    isFollowing: boolean | undefined;
    replyTo?: { id: string; authorId: string; authorUsername: string | null };
  };
}

export function FeedPostList({
  posts,
  isLoading,
  error,
  activeTab,
  hasMore,
  isLoadingMore,
  pendingNewPosts,
  onShowNewPosts,
  onLoadMore,
  onRetry,
  onPostDelete,
  getPostEnrichment,
}: FeedPostListProps) {
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode);
  const { user } = useAuth();
  // 'hide' filters at render time so pagination cursors stay untouched — a
  // short page is fine, a broken cursor is not.
  const visiblePosts = posts && filterHiddenSensitive(posts, sensitiveContentMode, user?.identityId);

  const { sentinelRef, isSuspended, loadMore } = useInfiniteScroll({
    hasMore,
    isLoading: isLoadingMore || isLoading,
    onLoadMore,
    resetKey: activeTab,
  });

  return (
    <ErrorBoundary level="component">
      {pendingNewPosts.length > 0 && (
        <button
          onClick={onShowNewPosts}
          className="w-full py-3 text-center text-yappr-500 hover:bg-yappr-50 dark:hover:bg-yappr-900/20 font-medium transition-colors border-b border-gray-200 dark:border-gray-800"
        >
          Show {pendingNewPosts.length} new {pendingNewPosts.length === 1 ? 'post' : 'posts'}
        </button>
      )}

      <LoadingState
        loading={isLoading || posts === null}
        error={error}
        isEmpty={!isLoading && visiblePosts !== null && visiblePosts.length === 0}
        onRetry={onRetry}
        loadingText="Connecting to Dash Platform..."
        emptyText={activeTab === 'following' ? 'Your following feed is empty' : 'No posts yet'}
        emptyDescription={
          activeTab === 'following'
            ? 'Follow some people to see their posts here!'
            : 'Be the first to share something!'
        }
        emptyAction={<LegacyYapprLink />}
      >
        <div data-testid="feed-post-list">
          {visiblePosts?.map((post) => (
            <ErrorBoundary key={post.id} level="component">
              <PostCard
                post={post}
                enrichment={getPostEnrichment(post)}
                onDelete={onPostDelete}
              />
            </ErrorBoundary>
          ))}

          {hasMore && posts && posts.length > 0 && (
            <InfiniteScrollSentinel
              sentinelRef={sentinelRef}
              isLoading={isLoadingMore}
              isSuspended={isSuspended}
              onLoadMore={loadMore}
              className="border-t border-gray-200 dark:border-gray-800"
            />
          )}

          {!hasMore && posts && posts.length > 0 && (
            <div className="p-6 flex flex-col items-center gap-2 border-t border-gray-200 dark:border-gray-800 text-center">
              <p className="text-sm text-gray-500">You&apos;ve reached the end.</p>
              <LegacyYapprLink />
            </div>
          )}
        </div>
      </LoadingState>
    </ErrorBoundary>
  );
}
