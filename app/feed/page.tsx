'use client';

import { useState } from 'react';
import { logger } from '@/lib/logger';
import { Sidebar } from '@/components/layout/sidebar';
import { RightSidebar } from '@/components/layout/right-sidebar';
import { ComposeModal } from '@/components/compose/compose-modal';
import { withAuth, useAuth } from '@/contexts/auth-context';
import { useSettingsStore } from '@/lib/store';
import { FeedHeader } from '@/components/feed/feed-header';
import { FeedComposeBox } from '@/components/feed/feed-compose-box';
import { FeedLoginPrompt } from '@/components/feed/feed-login-prompt';
import { FeedPostList } from '@/components/feed/feed-post-list';
import { useFeedData, type FeedTab } from '@/hooks/use-feed-data';

function FeedPage() {
  const { user } = useAuth();
  const potatoMode = useSettingsStore((state) => state.potatoMode);
  const feedLanguage = useSettingsStore((state) => state.feedLanguage);

  const [activeTab, setActiveTab] = useState<FeedTab>(() => {
    try {
      if (typeof window !== 'undefined') {
        const savedTab = localStorage.getItem('feed-tab');
        if (savedTab === 'forYou' || savedTab === 'following') {
          return savedTab;
        }
      }
    } catch {
      return 'forYou';
    }
    return 'forYou';
  });

  const {
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
  } = useFeedData({ activeTab, feedLanguage });

  const handleTabChange = (tab: FeedTab) => {
    setActiveTab(tab);
    try {
      localStorage.setItem('feed-tab', tab);
    } catch {
      // Ignore storage write failures (privacy mode/blocked storage).
    }
  };

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <FeedHeader
            activeTab={activeTab}
            onTabChange={handleTabChange}
            onRefresh={() => {
              refresh().catch((error) => logger.error('Feed refresh failed', error));
            }}
            isLoading={isLoading}
            potatoMode={potatoMode}
          />

          <FeedComposeBox />

          {activeTab === 'following' && !user ? (
            <FeedLoginPrompt />
          ) : (
            <FeedPostList
              posts={filteredPosts}
              isLoading={isLoading}
              error={error}
              activeTab={activeTab}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              pendingNewPosts={pendingNewPosts}
              onShowNewPosts={showNewPosts}
              onLoadMore={() => {
                loadMore().catch((error) => logger.error('Feed loadMore failed', error));
              }}
              onRetry={() => {
                refresh().catch((error) => logger.error('Feed retry refresh failed', error));
              }}
              onPostDelete={handlePostDelete}
              getPostEnrichment={getPostEnrichment}
            />
          )}
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  );
}

export default withAuth(FeedPage, { optional: true });
