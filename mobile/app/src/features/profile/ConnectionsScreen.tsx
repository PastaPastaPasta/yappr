import type { ProfileDTO, UserSummaryDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { Stack } from 'expo-router';
import { useEffect, useState, type ReactElement } from 'react';
import { RefreshControl, View } from 'react-native';
import { UserGroupIcon, UsersIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useSession } from '~/data/session';
import { openUser } from '~/features/post/post-navigation';
import { Button } from '~/ui/Button';
import { EmptyState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { Screen } from '~/ui/Screen';
import { RowSkeleton } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { useColors } from '~/ui/tokens';
import { UserRow } from '~/ui/UserRow';

import { toggleFollow } from './profile-actions';
import { filterUsers, isSearching } from './connections-search';

/** Matches enough to fill the screen: search-driven paging stops there, and scrolling takes over. */
const SEARCH_SCREENFUL = 20;

export type ConnectionKind = 'followers' | 'following';

const COPY = {
  followers: {
    title: 'Followers',
    empty: { title: 'No followers yet', description: 'Share interesting content to gain followers' },
    icon: UsersIcon,
  },
  following: {
    title: 'Following',
    empty: { title: 'Not following anyone yet', description: 'Find interesting people to follow on Yappr' },
    icon: UserGroupIcon,
  },
} as const;

/** iOS: the two-line title view; Android: title and subtitle (UX_SPEC §4.14). */
function HeaderTitle({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <View className="items-center" accessibilityRole="header" accessibilityLabel={`${name}, ${subtitle}`}>
      {name ? (
        <Text variant="bodyStrong" tone="emphasis" numberOfLines={1}>
          {name}
        </Text>
      ) : null}
      <Text variant={name ? 'caption' : 'bodyStrong'} tone={name ? 'secondary' : 'emphasis'}>
        {subtitle}
      </Text>
    </View>
  );
}

function ConnectionRow({ user, viewerId, followsYou }: { user: UserSummaryDTO; viewerId: string | null; followsYou: boolean }) {
  const isSelf = user.id === viewerId;
  const following = user.viewerFollows === true;
  // Signed out: "Follow" opens the sign-in sheet; signed in, only once the follow state is known.
  const showFollow = !isSelf && (viewerId === null || typeof user.viewerFollows === 'boolean');
  const userId = user.id;
  const handle = handleOf(user);
  return (
    <UserRow
      user={user}
      isSelf={isSelf}
      following={following}
      followsYou={followsYou}
      onFollowPress={showFollow ? () => requireAuth(() => toggleFollow(userId, handle, following)) : undefined}
      onPress={() => openUser(userId)}
      testID={`user-row-${userId}`}
    />
  );
}

/**
 * Followers / Following (PRD PROF-04, UX_SPEC §4.14): user rows with a
 * follow button, a username filter, and the empty and error states.
 */
export function ConnectionsScreen({ id, kind }: { id: string; kind: ConnectionKind }) {
  const c = useColors();
  const { identityId: viewerId } = useSession();
  const copy = COPY[kind];
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const { data: profile } = useEngineQuery<ProfileDTO | null>(
    queryKeys.profile.detail(id),
    (api) => api.profiles.get(id),
    { persist: true, enabled: !!id },
  );
  const list = useEngineInfiniteQuery<UserSummaryDTO>(
    kind === 'followers' ? queryKeys.profile.followers(id) : queryKeys.profile.following(id),
    (api, cursor) => (kind === 'followers' ? api.graph.followers(id, cursor) : api.graph.following(id, cursor)),
    { persist: true, enabled: !!id },
  );
  // Everyone on the viewer's own followers list follows them: "Follow back".
  const followsYou = kind === 'followers' && id === viewerId;
  const searching = isSearching(query);
  const users = searching ? filterUsers(list.items, query) : list.items;

  // The filter covers the loaded pages: while it is on, keep paging until it has a screenful
  // or the list ends (a short filtered list never reaches onEndReached).
  const pageForSearch =
    searching && users.length < SEARCH_SCREENFUL && list.hasNextPage && !list.isFetchingNextPage && !list.isFetchNextPageError;
  const { fetchNextPage } = list;
  useEffect(() => {
    if (pageForSearch) fetchNextPage().catch(() => undefined);
  }, [pageForSearch, fetchNextPage]);

  const onRefresh = () => {
    setRefreshing(true);
    list
      .refetch()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  let empty: ReactElement;
  if (list.isError) {
    empty = (
      <EmptyState
        title="Something went wrong"
        description={`Could not load ${kind}. Check your connection and try again.`}
        action={{
          label: 'Try again',
          onPress: () => {
            list.refetch().catch(() => undefined);
          },
        }}
        testID="connections-error"
      />
    );
  } else if (list.isPending) {
    empty = (
      <View testID="connections-loading">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <RowSkeleton key={i} />
        ))}
      </View>
    );
  } else if (searching && list.hasNextPage) {
    // Still paging (or a page failed, and the footer offers Load more): not "no match" yet.
    empty = <View />;
  } else if (searching) {
    empty = <EmptyState title="No users found with that name" icon={copy.icon} testID="connections-no-match" />;
  } else {
    empty = (
      <EmptyState title={copy.empty.title} description={copy.empty.description} icon={copy.icon} testID="connections-empty" />
    );
  }

  const footer = list.isFetchingNextPage ? (
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
      />
    </View>
  ) : null;

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: copy.title,
          headerTitle: () => <HeaderTitle name={profile?.displayName ?? ''} subtitle={copy.title} />,
          headerSearchBarOptions: {
            placeholder: 'Search by username...',
            autoCapitalize: 'none',
            hideWhenScrolling: false,
            onChangeText: (event) => setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          },
        }}
      />
      <FlashList
        data={users}
        keyExtractor={(user) => user.id}
        renderItem={({ item }) => <ConnectionRow user={item} viewerId={viewerId} followsYou={followsYou} />}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage && !list.isFetchNextPageError) {
            list.fetchNextPage().catch(() => undefined);
          }
        }}
        onEndReachedThreshold={1.5}
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
        testID={`connections-${kind}`}
      />
    </Screen>
  );
}
