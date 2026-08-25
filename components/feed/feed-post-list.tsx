'use client';

import { Post } from '@/lib/types';
import ErrorBoundary from '@/components/error-boundary';
import { LoadingState } from '@/components/ui/loading-state';
import { PostCard } from '@/components/post/post-card';

interface FeedPostListProps {
  posts: Post[] | null;
  isLoading: boolean;
  error: string | null;
  activeTab: 'forYou' | 'following';
  hasMore: boolean;
  isLoadingMore: boolean;
  pendingNewPosts: Post[];
  onShowNewPosts: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onPostDelete: (postId: string) => void;
  getPostEnrichment: (post: Post) => {
    username: string | null | undefined;
    displayName: string | undefined;
    avatarUrl: string | undefined;
    stats: { likes: number; reposts: number; replies: number; views: number } | undefined;
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
        isEmpty={!isLoading && posts !== null && posts.length === 0}
        onRetry={onRetry}
        loadingText="Connecting to Dash Platform..."
        emptyText={activeTab === 'following' ? 'Your following feed is empty' : 'No posts yet'}
        emptyDescription={
          activeTab === 'following'
            ? 'Follow some people to see their posts here!'
            : 'Be the first to share something!'
        }
      >
        <div>
          {posts?.map((post) => (
            <ErrorBoundary key={post.id} level="component">
              <PostCard
                post={post}
                enrichment={getPostEnrichment(post)}
                onDelete={onPostDelete}
              />
            </ErrorBoundary>
          ))}

          {hasMore && posts && posts.length > 0 && (
            <div className="p-4 flex justify-center border-t border-gray-200 dark:border-gray-800">
              <button
                onClick={onLoadMore}
                disabled={isLoadingMore}
                className="px-6 py-2 rounded-full bg-yappr-500 text-white hover:bg-yappr-600 disabled:opacity-50 transition-colors"
              >
                {isLoadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </div>
      </LoadingState>
    </ErrorBoundary>
  );
}
