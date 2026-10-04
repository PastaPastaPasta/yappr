import type { EngagementDTO, PostDTO } from '@engine/api/dto';
import type { EngagementTab } from '@engine/api/posts';
import { FlashList } from '@shopify/flash-list';
import { router, Stack } from 'expo-router';
import { memo, useCallback, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import {
  ArrowPathIcon,
  ChatBubbleBottomCenterTextIcon,
  DocumentMagnifyingGlassIcon,
  HeartIcon,
} from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { readErrorMessage } from '~/data/read-error';
import { requireAuth } from '~/data/require-auth';
import { useCapabilities, useViewerId } from '~/data/session';
import { sendWrite } from '~/data/writes';
import { PostItem } from '~/features/post/PostItem';
import { openPost, openUser } from '~/features/post/post-navigation';
import { followWrite } from '~/features/post/post-writes';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { lightImpact } from '~/ui/haptics';
import { OfflineBanner } from '~/ui/OfflineBanner';
import { Screen } from '~/ui/Screen';
import { PostSkeleton, RowSkeleton } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { TopTabs } from '~/ui/Tabs';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';
import { UserRow } from '~/ui/UserRow';

import { EMPTY_COPY, engagementTabs, initialTab, tabLabel } from './engagement-tabs';

const EMPTY_ICONS = { quotes: ChatBubbleBottomCenterTextIcon, reposts: ArrowPathIcon, likes: HeartIcon } as const;

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** A row's identity: a quote by its post, everyone else by who they are. */
const engagementId = (entry: EngagementDTO) => entry.quote?.id ?? entry.user.id;

function follow(userId: string, following: boolean) {
  requireAuth(() => {
    if (!following) lightImpact();
    sendWrite(followWrite, { authorId: userId, follow: !following });
  });
}

/** Someone who liked or reposted: a user row with the follow button (UX_SPEC §2.10). */
const EngagementUser = memo(function EngagementUser({
  entry,
  viewerId,
}: {
  entry: EngagementDTO;
  viewerId: string | null;
}) {
  const { user } = entry;
  const following = user.viewerFollows === true;
  return (
    <UserRow
      user={user}
      isSelf={user.id === viewerId}
      following={following}
      onFollowPress={() => follow(user.id, following)}
      onPress={() => openUser(user.id)}
      testID={`engagement-user-${user.id}`}
    />
  );
});

/**
 * A quote, as the quoting post's card (PRD POST-06). The list carries only
 * the quote's id and text, so each visible row reads its post (one
 * `posts.get` per row; TODO post-1.0: a batched engine read); until it
 * arrives, or if it can't be read, the quoter's row with the quote text
 * stands in (web's engagements page).
 */
const EngagementQuote = memo(function EngagementQuote({
  entry,
  viewerId,
}: {
  entry: EngagementDTO;
  viewerId: string | null;
}) {
  const quoteId = entry.quote?.id ?? '';
  const { data: post, isPending } = useEngineQuery<PostDTO | null>(
    queryKeys.post.detail(quoteId),
    (api) => api.posts.get(quoteId),
    { enabled: quoteId.length > 0, persist: true },
  );
  if (post) return <PostItem post={post} />;
  if (isPending && quoteId) return <PostSkeleton />;
  return (
    <View className={cn('border-b', tw.border)}>
      <EngagementUser entry={entry} viewerId={viewerId} />
      {entry.quote?.content ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Quote: ${entry.quote.content}`}
          onPress={() => openPost(quoteId)}
          className={cn('-mt-2 px-4 pb-3', tw.pressed)}
          style={{ paddingLeft: 16 + 40 + 12 }}
        >
          <Text variant="subhead" numberOfLines={3}>
            {entry.quote.content}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

function ListSkeleton({ tab }: { tab: EngagementTab }) {
  return (
    <View testID="engagements-loading">
      {Array.from({ length: tab === 'quotes' ? 3 : 6 }, (_, i) =>
        tab === 'quotes' ? <PostSkeleton key={i} /> : <RowSkeleton key={i} />,
      )}
    </View>
  );
}

/** One tab's list: 30 people (or quotes) a page, with its own empty and error states. */
function EngagementList({
  id,
  kind,
  tab,
  onRefreshCounts,
}: {
  id: string;
  kind: PostDTO['kind'];
  tab: EngagementTab;
  onRefreshCounts: () => void;
}) {
  const c = useColors();
  const viewerId = useViewerId();
  const list = useEngineInfiniteQuery(
    queryKeys.post.engagements(id, tab),
    (api, cursor) => api.posts.engagements({ id, kind }, tab, cursor),
    { itemId: engagementId, enabled: id.length > 0 },
  );
  const [refreshing, setRefreshing] = useState(false);
  const { refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = list;
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    onRefreshCounts();
    refetch()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [refetch, onRefreshCounts]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage().catch(() => undefined);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const empty = EMPTY_COPY[tab];
  let emptyView;
  if (list.isPending) emptyView = <ListSkeleton tab={tab} />;
  else if (list.isError && list.items.length === 0)
    emptyView = (
      <ErrorState
        message={readErrorMessage(list.error)}
        onRetry={() => refetch().catch(() => undefined)}
        retrying={list.isRetrying}
        testID="engagements-error"
      />
    );
  else
    emptyView = (
      <EmptyState
        title={empty.title}
        description={empty.description}
        icon={EMPTY_ICONS[tab]}
        testID={`engagements-empty-${tab}`}
      />
    );

  return (
    <FlashList
      data={list.items}
      keyExtractor={engagementId}
      getItemType={() => tab}
      renderItem={({ item }) =>
        tab === 'quotes' ? (
          <EngagementQuote entry={item} viewerId={viewerId} />
        ) : (
          <EngagementUser entry={item} viewerId={viewerId} />
        )
      }
      ListEmptyComponent={emptyView}
      ListFooterComponent={
        isFetchingNextPage ? (
          <View className="items-center py-6">
            <Spinner size="sm" />
          </View>
        ) : list.isFetchNextPageError ? (
          <View className="items-center py-6">
            <Button label="Load more" size="sm" onPress={loadMore} testID="engagements-load-more" />
          </View>
        ) : null
      }
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={c.accent}
          colors={[c.accent]}
          progressBackgroundColor={c.bg}
        />
      }
      testID={`engagements-list-${tab}`}
    />
  );
}

/**
 * Who liked, reposted and quoted a post (PRD POST-06, UX_SPEC §4.10): top
 * tabs with their counts, a list per tab. Reposts is absent where the
 * post's kind can't be reposted.
 */
export function EngagementsScreen({
  id,
  kind,
  requestedTab,
}: {
  id: string;
  kind: PostDTO['kind'];
  requestedTab?: string;
}) {
  const capabilities = useCapabilities();
  const tabs = engagementTabs(capabilities?.repostable[kind] ?? true);
  const [selected, setTab] = useState<EngagementTab>(() => initialTab(requestedTab, tabs));
  // Capabilities can arrive after the first render and take Reposts away.
  const tab = tabs.includes(selected) ? selected : 'likes';
  const counts = useEngineQuery(
    queryKeys.post.engagementCounts(id),
    (api) => api.posts.engagementCounts({ id, kind }),
    { enabled: id.length > 0 },
  );
  const refetchCounts = counts.refetch;
  const refreshCounts = useCallback(() => {
    refetchCounts().catch(() => undefined);
  }, [refetchCounts]);

  if (!id) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Post engagements' }} />
        <EmptyState
          title="Post not found"
          description="It may have been deleted, or the link is wrong."
          icon={DocumentMagnifyingGlassIcon}
          action={{ label: 'Go back', onPress: goBack }}
          testID="engagements-not-found"
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Post engagements' }} />
      <OfflineBanner />
      <TopTabs
        options={tabs.map((value) => ({ value, label: tabLabel(value, counts.data) }))}
        value={tab}
        onChange={setTab}
        testID="engagement-tabs"
      />
      <View className="flex-1">
        <EngagementList key={tab} id={id} kind={kind} tab={tab} onRefreshCounts={refreshCounts} />
      </View>
    </Screen>
  );
}
