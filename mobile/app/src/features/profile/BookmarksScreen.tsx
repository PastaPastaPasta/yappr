import type { PostDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactElement } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { BookmarkIcon, EllipsisHorizontalIcon, TrashIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { runWrite, sendWrite } from '~/data/writes';
import { appendLog, errorMessage } from '~/engine/logs';
import { bookmarkWrite } from '~/features/post/post-writes';
import { PostItem } from '~/features/post/PostItem';
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

/** Swipe left for "Remove" (UX_SPEC §4.24); the card's own bookmark button works too. */
function BookmarkRow({ post }: { post: PostDTO }) {
  return (
    <ReanimatedSwipeable
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
  const { signedIn, status } = useSession();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const list = useEngineInfiniteQuery<PostDTO>(
    queryKeys.bookmarks,
    (api, cursor) => api.engage.bookmarks(cursor),
    { persist: true, enabled: signedIn },
  );
  // Bookmarks made elsewhere since the last visit: read again whenever the screen shows.
  const { refetch } = list;
  useFocusEffect(
    useCallback(() => {
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
      while (more) {
        const next = await list.fetchNextPage();
        data = next.data;
        more = next.hasNextPage === true && !next.isError;
      }
      const all = (data?.pages ?? []).flatMap((page) => page.items).filter(stillBookmarked);
      const results = await Promise.all(all.map((post) => runWrite(bookmarkWrite, { post, bookmark: false })));
      if (results.some((result) => result.status === 'refused')) toast.error('Some bookmarks could not be removed');
      else toast.success('All bookmarks cleared');
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
