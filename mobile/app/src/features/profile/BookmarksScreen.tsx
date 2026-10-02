import type { PostDTO, WriteTicket } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { BookmarkIcon, EllipsisHorizontalIcon, TrashIcon } from 'react-native-heroicons/outline';

import { onEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { runWrite, sendWrite } from '~/data/writes';
import { appendLog, errorMessage } from '~/engine/logs';
import { bookmarkWrite } from '~/features/post/post-writes';
import { PostItem } from '~/features/post/PostItem';
import { Button } from '~/ui/Button';
import { ContextMenu } from '~/ui/ContextMenu';
import { confirmAlert } from '~/ui/Dialog';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { mediumImpact } from '~/ui/haptics';
import { IconButton } from '~/ui/IconButton';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { colors, useColors } from '~/ui/tokens';
import { toast } from '~/ui/toast';

import { filterBookmarks, stillBookmarked } from './bookmarks-filter';

const remove = (post: PostDTO) => sendWrite(bookmarkWrite, { post, bookmark: false }, 'Removed from bookmarks');

/**
 * Resolves with the ticket once it leaves `pending` (its `write.status`), or
 * null if the account changes first: that account's tickets never report again.
 */
function settled(ticket: WriteTicket, identityId: string | null): Promise<WriteTicket | null> {
  if (ticket.state !== 'pending') return Promise.resolve(ticket);
  return new Promise((resolve) => {
    const stops: (() => void)[] = [];
    const finish = (result: WriteTicket | null) => {
      for (const stop of stops) stop();
      resolve(result);
    };
    stops.push(
      onEngineEvent('write.status', (next) => {
        if (next.id === ticket.id && next.state !== 'pending') finish(next);
      }),
      onEngineEvent('session.changed', ({ session }) => {
        if ((session?.identityId ?? null) !== identityId) finish(null);
      }),
    );
  });
}

/** A removal that went through: confirmed, or unconfirmed but not proved absent (PRD G-3, as for every engagement). */
const removedBy = (ticket: WriteTicket | null) =>
  ticket !== null && (ticket.state === 'confirmed' || (ticket.state === 'unconfirmed' && !ticket.retryable));

/** Swipe left for "Remove" (UX_SPEC §4.24); the card's own bookmark button works too. */
function BookmarkRow({ post }: { post: PostDTO }) {
  return (
    <ReanimatedSwipeable
      // A recycled cell must not bring the previous post's open swipe with it.
      key={post.id}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={(_progress, _translation, methods) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove bookmark"
          onPress={() => {
            methods.close();
            mediumImpact();
            remove(post);
          }}
          className="w-24 items-center justify-center gap-1 bg-red-600"
          testID={`bookmark-remove-${post.id}`}
        >
          <TrashIcon size={22} color={colors.white} />
          <Text variant="captionStrong" tone="inverse">
            Remove
          </Text>
        </Pressable>
      )}
    >
      <View className="bg-white dark:bg-neutral-900">
        <PostItem post={post} />
      </View>
    </ReanimatedSwipeable>
  );
}

/**
 * Bookmarks (PRD ENG-04, UX_SPEC §4.24): the saved posts, newest first, a
 * search over them, swipe to remove, and "Clear all bookmarks". A post whose
 * bookmark the viewer removes leaves the list at once (optimistic) and comes
 * back if the write fails.
 */
export function BookmarksScreen() {
  const c = useColors();
  const { signedIn, status, identityId } = useSession();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const list = useEngineInfiniteQuery<PostDTO>(
    queryKeys.bookmarks,
    (api, cursor) => api.engage.bookmarks(cursor),
    { persist: true, enabled: signedIn },
  );
  // Bookmarks made elsewhere since the last visit: read again whenever the screen shows
  // again (the first time, the query's own fetch does it).
  const { refetch } = list;
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!focusedBefore.current) {
        focusedBefore.current = true;
        return;
      }
      if (signedIn) refetch().catch(() => undefined);
    }, [signedIn, refetch]),
  );
  const saved = list.items.filter(stillBookmarked);
  const posts = filterBookmarks(saved, query);

  const clearAll = async () => {
    const confirmed = await confirmAlert({
      title: 'Clear all bookmarks?',
      message: "This removes every saved post. It can't be undone.",
      confirmText: 'Clear all',
      destructive: true,
    });
    if (!confirmed) return;
    setClearing(true);
    try {
      // Every bookmark, not just the pages loaded so far.
      let data = list.data;
      let more = list.hasNextPage;
      let complete = true;
      while (more) {
        const next = await list.fetchNextPage();
        data = next.data;
        complete = !next.isError;
        more = complete && next.hasNextPage === true;
      }
      const all = (data?.pages ?? []).flatMap((page) => page.items).filter(stillBookmarked);
      // One at a time, each settled before the next, stopping at the first that doesn't go
      // through: the tracker already says why, and the rest would most likely fail the same
      // way, each with its own toast. A queued removal (one for that post was already
      // pending) isn't counted: its outcome is the pending write's.
      let removed = 0;
      for (const post of all) {
        const result = await runWrite(bookmarkWrite, { post, bookmark: false });
        if (result.status === 'queued') continue;
        if (result.status !== 'submitted' || !removedBy(await settled(result.ticket, identityId))) break;
        removed += 1;
      }
      if (removed === all.length && complete) toast.success('All bookmarks cleared');
      else if (removed === all.length) toast.error("Some bookmarks couldn't be loaded. Pull to refresh and try again.");
      else toast.error(`Removed ${removed} of ${all.length} bookmarks`);
    } catch (error) {
      appendLog('warn', 'host', `Clearing bookmarks failed: ${errorMessage(error)}`);
      toast.error('Some bookmarks could not be removed');
    } finally {
      setClearing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    list
      .refetch()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  let empty: ReactElement;
  if (status === 'signed-out') {
    empty = (
      <EmptyState
        title="Sign in to see your bookmarks"
        icon={BookmarkIcon}
        action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
        testID="bookmarks-signed-out"
      />
    );
  } else if (list.isError) {
    empty = (
      <ErrorState
        onRetry={() => {
          list.refetch().catch(() => undefined);
        }}
        testID="bookmarks-error"
      />
    );
  } else if (list.isPending) {
    empty = (
      <View className="items-center gap-4 p-8" testID="bookmarks-loading" accessibilityLiveRegion="polite">
        <Spinner />
        <Text variant="subhead" tone="secondary">
          Loading bookmarks…
        </Text>
      </View>
    );
  } else if (query.trim() && saved.length > 0) {
    empty = <EmptyState title="No bookmarks match your search" icon={BookmarkIcon} testID="bookmarks-no-match" />;
  } else {
    empty = (
      <EmptyState
        title="Save posts for later"
        description="Don't let the good ones fly away! Bookmark posts to easily find them again."
        icon={BookmarkIcon}
        testID="bookmarks-empty"
      />
    );
  }

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: 'Bookmarks',
          headerLargeTitle: true,
          headerSearchBarOptions: signedIn
            ? {
                placeholder: 'Search bookmarks',
                hideWhenScrolling: false,
                onChangeText: (event) => setQuery(event.nativeEvent.text),
                onCancelButtonPress: () => setQuery(''),
              }
            : undefined,
          headerRight: () =>
            clearing ? (
              <Spinner size="sm" testID="bookmarks-clearing" />
            ) : saved.length > 0 ? (
              <ContextMenu
                items={[{ id: 'clear', title: 'Clear all bookmarks', systemImage: 'trash', destructive: true }]}
                onSelect={() => {
                  clearAll().catch(() => undefined);
                }}
                testID="bookmarks-menu"
              >
                <IconButton icon={EllipsisHorizontalIcon} accessibilityLabel="Bookmark options" color={c.textPrimary} />
              </ContextMenu>
            ) : null,
        }}
      />
      <FlashList
        data={signedIn ? posts : []}
        keyExtractor={(post) => post.id}
        renderItem={({ item }) => <BookmarkRow post={item} />}
        ListEmptyComponent={empty}
        ListFooterComponent={
          list.isFetchingNextPage ? (
            <View className="items-center p-6">
              <Spinner size="sm" />
            </View>
          ) : list.isFetchNextPageError ? (
            <View className="items-center p-6">
              <Button
                label="Load more"
                size="sm"
                onPress={() => {
                  list.fetchNextPage().catch(() => undefined);
                }}
                testID="bookmarks-load-more"
              />
            </View>
          ) : null
        }
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage && !list.isFetchNextPageError) {
            list.fetchNextPage().catch(() => undefined);
          }
        }}
        onEndReachedThreshold={1.5}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        refreshControl={
          signedIn ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.accent}
              colors={[c.accent]}
              progressBackgroundColor={c.bg}
            />
          ) : undefined
        }
        testID="bookmarks-list"
      />
    </Screen>
  );
}
