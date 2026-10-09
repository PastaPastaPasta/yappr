import type { PostDTO, RankedUserDTO, TagDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { router, Stack } from 'expo-router';
import { useState, type ReactElement } from 'react';
import { Platform, RefreshControl, View } from 'react-native';
import { FireIcon, HashtagIcon, TrophyIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery, usePullToRefresh } from '~/data/queries';
import { useCapabilities } from '~/data/session';
import { openHashtag } from '~/features/post/post-navigation';
import { PostItem } from '~/features/post/PostItem';
import { cn } from '~/lib-allowlist';
import { ComposeFab } from '~/ui/ComposeFab';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { SegmentedControl } from '~/ui/Tabs';
import { toast } from '~/ui/toast';
import { tw, useColors } from '~/ui/tokens';

import { exploreSegments, shownSegment, useExplorePrefs, type ExploreSegment } from './explore-prefs';
import { FollowableUserRow, readFollowStatus, withFollowStatus } from './FollowableUserRow';
import { postItemType } from './PagedPostList';
import { SearchLauncher } from './SearchField';
import { LoadingRow, OfflineBanner, readErrorMessage, SectionHeader, useOffline } from './states';
import { TagRow } from './TagRow';
import { countLabel, POST_WINDOWS, TAG_WINDOWS } from './tags';

type Row =
  | { type: 'tag'; key: string; tag: TagDTO; rank: number }
  | { type: 'post'; key: string; post: PostDTO }
  | { type: 'section'; key: string; title: string }
  | { type: 'user'; key: string; entry: RankedUserDTO; rank: number };

/** Room under the last row for the compose button. */
const FAB_CLEARANCE = 96;

const COPY: Record<ExploreSegment, { loading: string; empty: string; emptyDescription: string }> = {
  trending: {
    loading: 'Loading trending hashtags…',
    empty: 'No trending tags yet',
    emptyDescription: 'Post with #hashtags or $cashtags to see them here!',
  },
  top: {
    loading: 'Loading top posts…',
    empty: 'No liked posts yet',
    emptyDescription: 'The most-liked posts will appear here',
  },
  creators: {
    loading: 'Loading top creators…',
    empty: 'No ranked creators yet',
    emptyDescription: 'Creators show up here once their posts get likes',
  },
};

const EMPTY_ICON = { trending: HashtagIcon, top: FireIcon, creators: TrophyIcon } as const;

/** The leaderboards as rows: likes received, then the most followed, each under its header. */
function creatorRows(entries: readonly RankedUserDTO[]): Row[] {
  const rows: Row[] = [];
  for (const by of ['likes', 'followers'] as const) {
    const ranked = entries.filter((entry) => entry.by === by);
    if (ranked.length === 0) continue;
    rows.push({
      type: 'section',
      key: `section:${by}`,
      title: by === 'likes' ? 'Top creators by likes received' : 'Most followed',
    });
    ranked.forEach((entry, index) => rows.push({ type: 'user', key: `${by}:${entry.user.id}`, entry, rank: index + 1 }));
  }
  return rows;
}

/**
 * The Explore tab (UX_SPEC §4.15, PRD EXPL-01 – EXPL-04): the search field,
 * then Trending tags, Top posts and Creators where the contract ranks likes,
 * each ranked list with its window where the axis has one.
 */
export function ExploreScreen() {
  const c = useColors();
  const capabilities = useCapabilities();
  const offline = useOffline();
  const prefs = useExplorePrefs();
  const segments = exploreSegments(capabilities);
  const segment = shownSegment(prefs.segment, segments);
  const windowed = Boolean(capabilities?.windowedRankings);
  const trendingWindow = windowed ? prefs.trendingWindow : 'all';
  const topWindow = windowed ? prefs.topWindow : 'all';

  const trending = useEngineQuery(
    queryKeys.explore.trending(trendingWindow),
    (api) => api.explore.trending({ window: trendingWindow }),
    { persist: true, enabled: segment === 'trending' },
  );
  const freshTop = usePullToRefresh();
  const top = useEngineQuery(
    queryKeys.explore.topPosts(topWindow),
    (api) => api.explore.topPosts({ window: topWindow, ...freshTop.take() }),
    { persist: true, enabled: segment === 'top' },
  );
  const creators = useEngineQuery(
    queryKeys.explore.topCreators(),
    async (api) => {
      const entries = await api.explore.topCreators();
      const status = await readFollowStatus(api, entries.map((entry) => entry.user.id));
      return entries.map((entry) => ({ ...entry, user: withFollowStatus(entry.user, status) }));
    },
    { persist: true, enabled: segment === 'creators' },
  );
  const active = segment === 'trending' ? trending : segment === 'top' ? top : creators;

  let rows: Row[] = [];
  if (segment === 'trending') {
    rows = (trending.data ?? []).map((tag, index) => ({ type: 'tag', key: `tag:${tag.tag}`, tag, rank: index + 1 }));
  } else if (segment === 'top') {
    rows = (top.data ?? []).map((post) => ({ type: 'post', key: `post:${post.id}`, post }));
  } else {
    rows = creatorRows(creators.data ?? []);
  }

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    if (offline) {
      toast("You're offline. Showing saved results.");
      return;
    }
    setRefreshing(true);
    if (segment === 'top') freshTop.raise();
    active
      .refetch()
      .then((result) => {
        if (result.isError && rows.length > 0) {
          toast.error(readErrorMessage(result.error) ?? 'Something went wrong. Try again.');
        }
      })
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  const windows = segment === 'trending' ? TAG_WINDOWS : segment === 'top' ? POST_WINDOWS : null;
  const header = (
    <View className={cn('gap-3 border-b px-4 pb-3', Platform.OS === 'ios' ? 'pt-1' : 'pt-3', tw.border)}>
      <SearchLauncher onPress={() => router.push('/explore/search')} />
      {segments.length > 1 ? (
        <SegmentedControl
          options={segments}
          value={segment}
          onChange={(next) => useExplorePrefs.setState({ segment: next })}
          testID="explore-segments"
        />
      ) : null}
      {windowed && windows ? (
        <SegmentedControl
          options={windows}
          value={segment === 'trending' ? trendingWindow : topWindow}
          onChange={(next) =>
            useExplorePrefs.setState(segment === 'trending' ? { trendingWindow: next } : { topWindow: next })
          }
          testID={`explore-${segment}-window`}
        />
      ) : null}
    </View>
  );

  const copy = COPY[segment];
  let empty: ReactElement;
  if (active.isError) {
    empty = (
      <ErrorState
        message={readErrorMessage(active.error, offline)}
        onRetry={() => {
          active.refetch().catch(() => undefined);
        }}
        retrying={active.isRetrying}
        testID={`explore-${segment}-error`}
      />
    );
  } else if (active.isPending) {
    empty = <LoadingRow label={copy.loading} testID={`explore-${segment}-loading`} />;
  } else {
    empty = (
      <EmptyState
        title={copy.empty}
        description={copy.emptyDescription}
        icon={EMPTY_ICON[segment]}
        testID={`explore-${segment}-empty`}
      />
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Explore', headerLargeTitle: Platform.OS === 'ios', headerShadowVisible: false }} />
      {/* The list stays the first view, so the iOS large title collapses on scroll (UX_SPEC §3.4):
          the offline banner sits in its header. */}
      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => (row.type === 'post' ? postItemType(row.post) : row.type)}
        renderItem={({ item }) => {
          switch (item.type) {
            case 'tag':
              return (
                <TagRow
                  tag={item.tag}
                  rank={item.rank}
                  onPress={(tag) => openHashtag(tag.tag)}
                  testID={`trending-${item.tag.tag}`}
                />
              );
            case 'post':
              return <PostItem post={item.post} />;
            case 'section':
              return <SectionHeader title={item.title} />;
            case 'user':
              return (
                <FollowableUserRow
                  // A leaderboard row shows the count, not the bio (web `top-creators.tsx`).
                  user={{ ...item.entry.user, bio: undefined }}
                  rank={item.rank}
                  detail={countLabel(item.entry.count, item.entry.by === 'likes' ? 'like' : 'follower')}
                  testID={`creator-${item.entry.by}-${item.entry.user.username ?? item.entry.user.id}`}
                />
              );
          }
        }}
        ListHeaderComponent={
          <>
            {offline ? <OfflineBanner /> : null}
            {header}
          </>
        }
        ListEmptyComponent={empty}
        contentInsetAdjustmentBehavior="automatic"
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
        testID={`explore-${segment}`}
      />
      <ComposeFab />
    </Screen>
  );
}
