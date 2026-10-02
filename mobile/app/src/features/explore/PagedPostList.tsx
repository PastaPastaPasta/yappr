import type { Page, PostDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import { useRef, useState, type ReactElement } from 'react';
import { RefreshControl, View } from 'react-native';

import { useEngineInfiniteQuery } from '~/data/queries';
import { PostItem } from '~/features/post/PostItem';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Spinner } from '~/ui/Spinner';
import { toast } from '~/ui/toast';
import { useColors, type IconComponent } from '~/ui/tokens';

import { LoadingRow, readErrorMessage } from './states';

/** PRD FEED-07: within 1.5 screens of the end, and at most 3 pages without the reader scrolling. */
const END_THRESHOLD = 1.5;
const MAX_AUTO_PAGES = 3;
const OFFLINE_REFRESH_MESSAGE = "You're offline. Showing saved posts.";

/** Cells with the same structure recycle into each other. */
export function postItemType(post: PostDTO): string {
  if (post.bareRepost || post.quoted) return 'quote';
  return post.media.length > 0 ? 'media' : 'text';
}

type PagedPosts = ReturnType<typeof useEngineInfiniteQuery<PostDTO>>;

export interface PagedPostListProps {
  queryKey: QueryKey;
  query: PagedPosts;
  /** Controls above the posts (segments, windows). */
  header?: ReactElement;
  loadingLabel: string;
  empty: { title: string; description?: string; icon?: IconComponent };
  offline: boolean;
  testID: string;
}

/**
 * A cursor-paged post list: pull to refresh (back to the first page),
 * infinite scroll that pauses after three automatic pages behind a "Load
 * more posts" pill, and the loading, empty and error states (PRD FEED-06,
 * FEED-07, EXPL-07).
 */
export function PagedPostList({ queryKey, query, header, loadingLabel, empty, offline, testID }: PagedPostListProps) {
  const c = useColors();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    if (offline) {
      toast(OFFLINE_REFRESH_MESSAGE);
      return;
    }
    setRefreshing(true);
    // A refetch re-reads every page it holds: start again from the first.
    queryClient.setQueryData<InfiniteData<Page<PostDTO>, string | null>>(queryKey, (data) =>
      data && data.pages.length > 1 ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
    );
    query
      .refetch()
      .then((result) => {
        if (result.isError && query.items.length > 0) {
          toast.error(readErrorMessage(result.error) ?? 'Something went wrong. Try again.');
        }
      })
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  const autoPages = useRef(0);
  const [paused, setPaused] = useState(false);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
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
  };

  let footer = null;
  if (query.items.length > 0) {
    if (isFetchingNextPage) {
      footer = (
        <View className="items-center p-6">
          <Spinner size="sm" testID={`${testID}-next-page`} />
        </View>
      );
    } else if (hasNextPage && (isFetchNextPageError || paused)) {
      footer = (
        <View className="items-center p-6">
          <Button label="Load more posts" size="sm" onPress={loadMore} testID={`${testID}-load-more`} />
        </View>
      );
    }
  }

  let emptyState: ReactElement;
  if (query.isError) {
    emptyState = (
      <ErrorState
        message={readErrorMessage(query.error, offline)}
        onRetry={() => {
          query.refetch().catch(() => undefined);
        }}
        testID={`${testID}-error`}
      />
    );
  } else if (query.isPending) {
    emptyState = <LoadingRow label={loadingLabel} testID={`${testID}-loading`} />;
  } else {
    emptyState = (
      <EmptyState title={empty.title} description={empty.description} icon={empty.icon} testID={`${testID}-empty`} />
    );
  }

  return (
    <FlashList
      data={query.items}
      keyExtractor={(post) => post.id}
      getItemType={postItemType}
      renderItem={({ item }) => <PostItem post={item} />}
      ListHeaderComponent={header}
      ListEmptyComponent={emptyState}
      ListFooterComponent={footer}
      onEndReached={onEndReached}
      onEndReachedThreshold={END_THRESHOLD}
      onScrollBeginDrag={onScrollBeginDrag}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={c.accent}
          colors={[c.accent]}
          progressBackgroundColor={c.bg}
        />
      }
      testID={testID}
    />
  );
}
