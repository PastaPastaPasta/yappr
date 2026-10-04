import type { PostDTO, TagDTO, UserSummaryDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { Stack } from 'expo-router';
import type { ReactElement } from 'react';
import { MagnifyingGlassIcon } from 'react-native-heroicons/outline';

import { openHashtag } from '~/features/post/post-navigation';
import { PostItem } from '~/features/post/PostItem';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';

import { FollowableUserRow } from './FollowableUserRow';
import { postItemType } from './PagedPostList';
import { useRecentSearches } from './recent-searches';
import { LoadingRow, OfflineBanner, readErrorMessage, useOffline } from './states';
import { TagRow } from './TagRow';
import { isSearchKind, SEARCH_TITLES, useSearch } from './use-search';

type Row =
  | { type: 'user'; key: string; user: UserSummaryDTO }
  | { type: 'tag'; key: string; tag: TagDTO }
  | { type: 'post'; key: string; post: PostDTO };

/**
 * One search group in full (PRD EXPL-06): "People" (with follow buttons),
 * "Hashtags" or "Recent posts" for the query. The search screen's reads are
 * cached, so this opens on the rows it was showing.
 */
export function SearchResultsScreen({ kind: kindParam, query }: { kind: string | undefined; query: string }) {
  const offline = useOffline();
  const recent = useRecentSearches();
  const kind = isSearchKind(kindParam) ? kindParam : 'posts';
  const search = useSearch(query, kind);
  const active = kind === 'people' ? search.people : kind === 'hashtags' ? search.hashtags : search.posts;
  const enabled = search.enabled[kind];

  let rows: Row[] = [];
  if (kind === 'people') rows = (search.people.data ?? []).map((user) => ({ type: 'user', key: user.id, user }));
  else if (kind === 'hashtags') rows = (search.hashtags.data ?? []).map((tag) => ({ type: 'tag', key: tag.tag, tag }));
  else rows = (search.posts.data ?? []).map((post) => ({ type: 'post', key: post.id, post }));

  let empty: ReactElement;
  if (active.isError) {
    empty = (
      <ErrorState
        message={readErrorMessage(active.error, offline)}
        onRetry={() => {
          active.refetch().catch(() => undefined);
        }}
        retrying={active.isRetrying}
        testID="search-results-error"
      />
    );
  } else if (enabled && active.isPending) {
    empty = <LoadingRow label="Searching…" testID="search-results-loading" />;
  } else {
    empty = (
      <EmptyState
        title={`No results for "${search.q}"`}
        description="Try searching for something else"
        icon={MagnifyingGlassIcon}
        testID="search-results-empty"
      />
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: SEARCH_TITLES[kind] }} />
      {offline ? <OfflineBanner /> : null}
      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => (row.type === 'post' ? postItemType(row.post) : row.type)}
        renderItem={({ item }) => {
          switch (item.type) {
            case 'user':
              return (
                <FollowableUserRow
                  user={item.user}
                  onOpen={(user) =>
                    recent.add({ kind: 'user', id: user.id, name: user.displayName, username: user.username })
                  }
                  testID={`search-user-${item.user.username ?? item.user.id}`}
                />
              );
            case 'tag':
              return (
                <TagRow
                  tag={item.tag}
                  onPress={(tag) => {
                    recent.add({ kind: 'tag', tag: tag.tag });
                    openHashtag(tag.tag);
                  }}
                  testID={`search-tag-${item.tag.tag}`}
                />
              );
            case 'post':
              return <PostItem post={item.post} />;
          }
        }}
        ListEmptyComponent={empty}
        contentInsetAdjustmentBehavior="automatic"
        testID={`search-results-${kind}`}
      />
    </Screen>
  );
}
