'use client';

import { useState } from 'react';
import { logger } from '@/lib/logger';
import { readScoped, writeScoped } from '@/lib/storage-scope';
import { PageShell } from '@/components/layout/page-shell';
import { withAuth, useAuth } from '@/contexts/auth-context';
import { useSettingsStore } from '@/lib/store';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import type { RankingWindow } from '@/lib/services/ranked-likes';
import { FeedHeader } from '@/components/feed/feed-header';
import { FeedComposeBox } from '@/components/feed/feed-compose-box';
import { FeedLoginPrompt } from '@/components/feed/feed-login-prompt';
import { FeedPostList } from '@/components/feed/feed-post-list';
import { FeedSortToggle, type FeedSortMode } from '@/components/feed/feed-sort-toggle';
import { FeedTopList } from '@/components/feed/feed-top-list';
import { useFeedData, type FeedTab } from '@/hooks/use-feed-data';
import { useTopFeed } from '@/hooks/use-top-feed';

function readSavedTab(): FeedTab {
  const saved = readScoped('feed-tab');
  return saved === 'forYou' || saved === 'following' ? saved : 'forYou';
}

function readSavedSortMode(): FeedSortMode {
  return readScoped('feed-sort') === 'top' && likesAreIndexOnly() ? 'top' : 'recent';
}

function FeedPage() {
  const { user } = useAuth();
  const feedLanguage = useSettingsStore((state) => state.feedLanguage);

  const [activeTab, setActiveTab] = useState<FeedTab>(readSavedTab);
  const [sortMode, setSortMode] = useState<FeedSortMode>(readSavedSortMode);
  const [rankingWindow, setRankingWindow] = useState<RankingWindow>('all');
  // Top rides the v4+ ranked like axes; older topologies only have Recent.
  const topAvailable = likesAreIndexOnly();
  const showTop = topAvailable && sortMode === 'top';

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

  const topFeed = useTopFeed({ activeTab, window: rankingWindow, enabled: showTop });

  const handleTabChange = (tab: FeedTab) => {
    setActiveTab(tab);
    writeScoped('feed-tab', tab);
  };

  const handleSortModeChange = (mode: FeedSortMode) => {
    setSortMode(mode);
    writeScoped('feed-sort', mode);
  };

  const handleRefresh = () => {
    const pending = showTop ? topFeed.refresh() : refresh();
    pending.catch((error) => logger.error('Feed refresh failed', error));
  };

  return (
    <PageShell>
          <FeedHeader
            activeTab={activeTab}
            onTabChange={handleTabChange}
            onRefresh={handleRefresh}
            isLoading={showTop ? topFeed.isLoading : isLoading}
          />

          {topAvailable && (
            <FeedSortToggle
              sortMode={sortMode}
              onSortModeChange={handleSortModeChange}
              rankingWindow={rankingWindow}
              onRankingWindowChange={setRankingWindow}
            />
          )}

          <FeedComposeBox />

          {activeTab === 'following' && !user ? (
            <FeedLoginPrompt />
          ) : showTop ? (
            <FeedTopList
              posts={topFeed.posts}
              isLoading={topFeed.isLoading}
              activeTab={activeTab}
              onPostDelete={topFeed.handlePostDelete}
            />
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
              onLoadMore={loadMore}
              onRetry={() => {
                refresh().catch((error) => logger.error('Feed retry refresh failed', error));
              }}
              onPostDelete={handlePostDelete}
              getPostEnrichment={getPostEnrichment}
            />
          )}
    </PageShell>
  );
}

export default withAuth(FeedPage, { optional: true });
