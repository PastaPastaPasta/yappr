import type { PostDTO, RankingWindow } from '@engine/api';
import type { FeedTab } from '@engine/api/feed';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { ArrowTopRightOnSquareIcon } from 'react-native-heroicons/outline';
import { useReducedMotion } from 'react-native-reanimated';

import { openExternal } from '~/features/post/post-navigation';
import { PostItem } from '~/features/post/PostItem';
import { engineSupervisor } from '~/engine';
import { useEngineStatus } from '~/engine/hooks';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { PostSkeleton } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { useColors } from '~/ui/tokens';

import { LEGACY_APP_URL, readErrorMessage, UNAVAILABLE_MESSAGE } from './feed-data';
import type { FeedSort } from './home-prefs';
import { NewPostsPill } from './NewPostsPill';
import { unpinOwnPosts, usePinnedPosts } from './own-posts';
import { useHomeFeed, useNewPosts } from './use-home-feed';

/** UX_SPEC §5.11. A refresh offline ends at once with this (PRD FEED-06, G-1). */
export const OFFLINE_REFRESH_MESSAGE = "You're offline. Showing saved posts.";
const REFRESH_FAILED_MESSAGE = 'Something went wrong. Try again.';

/** PRD FEED-07: within 1.5 screens of the end, and at most 3 pages without the reader scrolling. */
const END_THRESHOLD = 1.5;
const MAX_AUTO_PAGES = 3;
/** Room under the last card for the compose button. */
const FAB_CLEARANCE = 96;
const NO_POSTS: PostDTO[] = [];

/** The imperative side of a page, for the Home tab button. */
export interface FeedPageHandle {
  /** Re-tapping Home: show the pending new posts if there are any, else scroll to the top (PRD FEED-05). */
  scrollToTopOrShowNew: () => void;
}

export interface FeedPageProps {
  tab: FeedTab;
  sort: FeedSort;
  window: RankingWindow;
  /** The feed can be read (Following needs the restored session). */
  readable: boolean;
  /** Home is on screen, this page is the visible one, and the app is in the foreground. */
  live: boolean;
  offline: boolean;
  ref?: Ref<FeedPageHandle>;
}

const EMPTY_COPY: Record<`${FeedTab}:${FeedSort}`, { title: string; description: string }> = {
  'forYou:recent': { title: 'No posts yet', description: 'Be the first to share something!' },
  'following:recent': {
    title: 'Your following feed is empty',
    description: 'Follow some people to see their posts here!',
  },
  'forYou:top': { title: 'No liked posts yet', description: 'The most-liked posts will appear here' },
  'following:top': {
    title: 'No liked posts yet',
    description: 'The most-liked posts from people you follow will appear here',
  },
};

/** Cells with the same structure recycle into each other. */
function itemType(post: PostDTO): string {
  if (post.bareRepost || post.quoted) return 'quote';
  return post.media.length > 0 ? 'media' : 'text';
}

function LegacyLink() {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => openExternal(LEGACY_APP_URL)}
      hitSlop={8}
      testID="legacy-link"
      className="min-h-11 flex-row items-center justify-center gap-1.5 px-4"
    >
      <Text variant="subhead" tone="link" className="text-center">
        Looking for older posts? Browse the previous version of Yappr
      </Text>
      <ArrowTopRightOnSquareIcon size={16} color={c.link} />
    </Pressable>
  );
}

function ListEnd() {
  return (
    <View className="items-center gap-2 p-6" testID="feed-end">
      <Text variant="subhead" tone="secondary">
        You&apos;ve reached the end.
      </Text>
      <LegacyLink />
    </View>
  );
}

function Connecting({ connecting }: { connecting: boolean }) {
  return (
    <View testID="feed-loading">
      {[0, 1, 2, 3].map((i) => (
        <PostSkeleton key={i} />
      ))}
      {connecting ? (
        <Text variant="subhead" tone="secondary" className="p-6 text-center">
          Connecting to Dash Platform…
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One Home page (For You or Following) at the chosen sort: the post list
 * with pull to refresh, paging, the new-posts pill and its states (PRD
 * FEED-01 – FEED-07, FEED-11).
 */
export function FeedPage({ tab, sort, window, readable, live, offline, ref }: FeedPageProps) {
  const c = useColors();
  const reduceMotion = useReducedMotion();
  const { state: engineState } = useEngineStatus();
  const feed = useHomeFeed({ tab, sort, window, enabled: readable });

  // The viewer's own new posts stay on top of For You until the feed returns them.
  const pinned = usePinnedPosts();
  const pins = tab === 'forYou' && sort === 'recent' ? pinned : NO_POSTS;
  const feedItems = feed.items;
  const items = useMemo(() => {
    if (pins.length === 0) return feedItems;
    const inFeed = new Set(feedItems.map((post) => post.id));
    return [...pins.filter((post) => !inFeed.has(post.id)), ...feedItems];
  }, [pins, feedItems]);
  useEffect(() => {
    if (pins.length === 0) return;
    const inFeed = new Set(feedItems.map((post) => post.id));
    unpinOwnPosts(pins.filter((post) => inFeed.has(post.id)).map((post) => post.id));
  }, [pins, feedItems]);

  const newPosts = useNewPosts({
    tab,
    // The pins are newer than the feed but say nothing about others' posts in between.
    items: feedItems,
    shown: items,
    // A failed next page or refresh keeps the pages read (status `error`); the polling goes on.
    enabled: live && !offline && readable && sort === 'recent' && feed.data !== undefined,
  });

  const listRef = useRef<FlashListRef<PostDTO>>(null);
  const scrollToTop = () => listRef.current?.scrollToTop({ animated: !reduceMotion });

  const { insertNew, refresh } = feed;
  const showNew = () => {
    insertNew(newPosts)
      .then((error) => {
        if (error) toast.error(readErrorMessage(error) ?? REFRESH_FAILED_MESSAGE);
        // After the inserted cells have laid out.
        requestAnimationFrame(scrollToTop);
      })
      .catch(() => undefined);
  };

  useImperativeHandle(ref, () => ({
    scrollToTopOrShowNew: () => (newPosts.length > 0 ? showNew() : scrollToTop()),
  }));

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    if (offline) {
      toast(OFFLINE_REFRESH_MESSAGE);
      return;
    }
    setRefreshing(true);
    refresh()
      .then((error) => {
        if (error && items.length > 0) toast.error(readErrorMessage(error) ?? REFRESH_FAILED_MESSAGE);
      })
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  // Automatic paging pauses after MAX_AUTO_PAGES until the reader scrolls again.
  const autoPages = useRef(0);
  const [paused, setPaused] = useState(false);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = feed;
  const loadMore = () => {
    autoPages.current = 0;
    setPaused(false);
    fetchNextPage().catch(() => undefined);
  };
  const onEndReached = () => {
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError || paused) return;
    if (autoPages.current >= MAX_AUTO_PAGES) {
      setPaused(true);
      return;
    }
    autoPages.current += 1;
    fetchNextPage().catch(() => undefined);
  };
  const onScrollBeginDrag = () => {
    autoPages.current = 0;
    if (paused) loadMore();
  };

  let footer = null;
  if (items.length > 0) {
    if (isFetchingNextPage) {
      footer = (
        <View className="items-center p-6">
          <Spinner size="sm" testID="feed-next-page" />
        </View>
      );
    } else if (hasNextPage && (isFetchNextPageError || paused)) {
      footer = (
        <View className="items-center p-6">
          <Button label="Load More" size="sm" onPress={loadMore} testID="feed-load-more" />
        </View>
      );
    } else if (!hasNextPage && feed.isSuccess) {
      footer = <ListEnd />;
    }
  }

  let empty;
  if (feed.data === undefined && (engineState === 'failed' || engineState === 'unsupported')) {
    // The engine gave up (or cannot run here): nothing will load until it restarts (PRD G-11).
    empty = (
      <ErrorState
        message={UNAVAILABLE_MESSAGE}
        onRetry={() => {
          engineSupervisor.restart('Try again (Home)');
          if (readable) feed.refetch().catch(() => undefined);
        }}
        testID="feed-engine-down"
      />
    );
  } else if (feed.isError) {
    empty = (
      <ErrorState
        message={readErrorMessage(feed.error)}
        onRetry={() => {
          feed.refetch().catch(() => undefined);
        }}
        testID="feed-error"
      />
    );
  } else if (feed.isPending) {
    empty = <Connecting connecting={engineState !== 'ready' && engineState !== 'degraded'} />;
  } else {
    const copy = EMPTY_COPY[`${tab}:${sort}`];
    empty = (
      <EmptyState
        title={copy.title}
        description={copy.description}
        action={
          tab === 'following' && sort === 'recent'
            ? { label: 'Explore', onPress: () => router.navigate('/explore') }
            : undefined
        }
        testID="feed-empty"
      >
        <LegacyLink />
      </EmptyState>
    );
  }

  return (
    <View className="flex-1" testID={`feed-${tab}`}>
      <FlashList
        ref={listRef}
        data={items}
        keyExtractor={(post) => post.id}
        getItemType={itemType}
        renderItem={({ item }) => <PostItem post={item} />}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={onEndReached}
        onEndReachedThreshold={END_THRESHOLD}
        onScrollBeginDrag={onScrollBeginDrag}
        // Content added at the very top shows (a refresh, the viewer's post); deeper down the reader stays put.
        maintainVisibleContentPosition={{ autoscrollToTopThreshold: 8 }}
        contentContainerStyle={{ paddingBottom: FAB_CLEARANCE }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.accent}
            colors={[c.accent]}
            progressBackgroundColor={c.bg}
          />
        }
        testID={`feed-list-${tab}`}
      />
      <NewPostsPill posts={newPosts} onPress={showNew} />
    </View>
  );
}
