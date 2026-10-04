import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { DocumentMagnifyingGlassIcon } from 'react-native-heroicons/outline';

import { usePostRemoved } from '~/data/optimistic';
import { readErrorMessage } from '~/data/read-error';
import { useEngineStatus } from '~/engine/hooks';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { LinkText } from '~/ui/LinkText';
import { OfflineBanner } from '~/ui/OfflineBanner';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { useColors } from '~/ui/tokens';

import { ReplyBar, replyBlockOf } from './ReplyBar';
import { buildThreadRows, threadRowType, type ThreadRow } from './thread-rows';
import { ThreadRowView } from './ThreadRows';
import { FocusUnavailableError, useParentPost, useSeedPost, useThread } from './use-thread';

/** How many reply pages the screen reads on its own looking for a `?reply=` target. */
const MAX_HIGHLIGHT_PAGES = 5;

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function Footer({
  loading,
  failed,
  onLoadMore,
}: {
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
}) {
  if (loading) {
    return (
      <View className="items-center py-6" testID="replies-loading-more">
        <Spinner size="sm" />
      </View>
    );
  }
  if (failed) {
    return (
      <View className="items-center py-6">
        <Button label="Load More" size="sm" onPress={onLoadMore} testID="replies-load-more" />
      </View>
    );
  }
  return null;
}

/**
 * Post detail and thread (PRD POST-01 – POST-05, POST-10; UX_SPEC §4.9):
 * the posts above the focus, the focus as a detail card, its replies at
 * one indent level, paged as the list nears its end, and the docked reply
 * bar. Opened from a list it paints the tapped card at once; opened by link
 * it shows a skeleton first. `highlightId` (`?reply=`) scrolls to that
 * reply and tints it.
 */
export function ThreadScreen({ id, highlightId }: { id: string; highlightId?: string }) {
  const c = useColors();
  const seed = useSeedPost(id);
  const query = useThread(id);
  const { thread } = query;
  const focus = thread?.focus ?? seed;
  const focusId = focus?.id ?? id;
  const focusRemoved = usePostRemoved(focusId);
  const { state: engineState } = useEngineStatus();

  // Flat threads list only the root above a reply: read its direct parent for the context line.
  const parentId = focus?.parentId;
  const needsParent =
    thread !== undefined &&
    parentId !== undefined &&
    !thread.ancestors.some((post) => post.id === parentId) &&
    !thread.removedAncestorIds.includes(parentId);
  const parentQuery = useParentPost(needsParent ? parentId : undefined);

  const repliesError = query.isError && !query.isFetchNextPageError ? readErrorMessage(query.error) : null;
  // The last read lost a focus already shown: keep its replies, but never offer it as live.
  const focusUnavailable = thread?.focus != null && query.error instanceof FocusUnavailableError;
  const rows = useMemo(
    () =>
      buildThreadRows({
        thread,
        seed,
        parent: needsParent ? parentQuery.data : undefined,
        parentMissing: needsParent && parentQuery.isSuccess && parentQuery.data === null,
        focusRemoved,
        focusUnavailable,
        highlightId,
        repliesError,
      }),
    [
      thread,
      seed,
      needsParent,
      parentQuery.data,
      parentQuery.isSuccess,
      focusRemoved,
      focusUnavailable,
      highlightId,
      repliesError,
    ],
  );

  const [refreshing, setRefreshing] = useState(false);
  const { refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const refetchParent = parentQuery.refetch;
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([refetch(), needsParent ? refetchParent() : null])
      .then(([result]) => {
        // A failed refresh keeps what is shown; say so rather than fail silently.
        if (result.isError && result.data) toast.error(readErrorMessage(result.error));
      })
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [refetch, refetchParent, needsParent]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage().catch(() => undefined);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const retry = useCallback(() => {
    refetch().catch(() => undefined);
  }, [refetch]);

  // The viewer deleted (or hid) the post this screen is about: leave it (data README, `removal`).
  const wasRemoved = useRef(focusRemoved);
  useEffect(() => {
    if (focusRemoved && !wasRemoved.current) goBack();
    wasRemoved.current = focusRemoved;
  }, [focusRemoved]);

  // `?reply=`: scroll to the reply once it is in the list, reading a few more pages to find it.
  const listRef = useRef<FlashListRef<ThreadRow>>(null);
  const scrolledTo = useRef<string | null>(null);
  const searchedPages = useRef(0);
  const { isFetching } = query;
  useEffect(() => {
    if (!highlightId || scrolledTo.current === highlightId || !thread?.focus) return undefined;
    const index = rows.findIndex((row) => row.type === 'reply' && row.reply.id === highlightId);
    if (index >= 0) {
      // After the rows have laid out; a re-render before then reschedules it.
      const timer = setTimeout(() => {
        scrolledTo.current = highlightId;
        listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true })?.catch(() => undefined);
      }, 250);
      return () => clearTimeout(timer);
    }
    if (isFetching) return undefined;
    if (hasNextPage && searchedPages.current < MAX_HIGHLIGHT_PAGES) {
      searchedPages.current += 1;
      fetchNextPage().catch(() => undefined);
      return undefined;
    }
    // Not a row here (nested behind "Continue thread", or past the pages read): open the reply itself,
    // which shows this post above it.
    if (highlightId !== id) {
      scrolledTo.current = highlightId;
      router.replace({ pathname: '/post/[id]', params: { id: highlightId } });
    }
    return undefined;
  }, [highlightId, id, rows, thread, hasNextPage, isFetching, fetchNextPage]);

  const title = focus?.kind === 'reply' ? 'Reply' : 'Post';
  const header = <Stack.Screen options={{ title }} />;

  // Nothing under the id, and nothing shown before (POST-01).
  if (!id || (thread && !thread.focus && !seed)) {
    return (
      <Screen>
        {header}
        <EmptyState
          title="Post not found"
          description="It may have been deleted, or the link is wrong."
          icon={DocumentMagnifyingGlassIcon}
          action={{ label: 'Go back', onPress: goBack }}
          testID="post-not-found"
        >
          {/* The engine can't tell a missing post from a failed read (posts.get), so offer a re-read. */}
          {!id ? null : query.isFetching ? (
            <View className="mt-3 h-11 items-center justify-center" testID="post-not-found-checking">
              <Spinner size="sm" />
            </View>
          ) : (
            <LinkText label="Try again" role="button" onPress={retry} className="mt-3 self-center" testID="post-not-found-retry" />
          )}
        </EmptyState>
      </Screen>
    );
  }
  // A failed first read with nothing cached.
  if (!thread && !seed && query.isError) {
    return (
      <Screen>
        {header}
        <OfflineBanner />
        <ErrorState
          message={readErrorMessage(query.error)}
          onRetry={retry}
          retrying={query.isRetrying}
          testID="thread-error"
        />
      </Screen>
    );
  }

  const block = replyBlockOf(focus ?? undefined, focusRemoved, (thread !== undefined && !thread.focus) || focusUnavailable);
  const connecting = !thread && !seed && engineState !== 'ready';

  return (
    <Screen>
      {header}
      <OfflineBanner />
      <FlashList
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={threadRowType}
        renderItem={({ item }) => <ThreadRowView row={item} onRetryReplies={retry} />}
        ListFooterComponent={
          <>
            {connecting ? (
              <Text variant="subhead" tone="secondary" className="pb-6 text-center" testID="thread-connecting">
                Connecting to Dash Platform…
              </Text>
            ) : null}
            <Footer loading={isFetchingNextPage} failed={query.isFetchNextPageError} onLoadMore={loadMore} />
          </>
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        // The posts above the focus arrive after it; show them in place rather than holding the focus at the top.
        maintainVisibleContentPosition={{ disabled: true }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.accent}
            colors={[c.accent]}
            progressBackgroundColor={c.bg}
          />
        }
        contentInsetAdjustmentBehavior="automatic"
        testID="thread-list"
      />
      {focus ? <ReplyBar post={focus} block={block} /> : null}
    </Screen>
  );
}
