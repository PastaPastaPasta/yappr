import type { PostDTO, RankingWindow } from '@engine/api';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { CurrencyDollarIcon, HashtagIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, usePullToRefresh } from '~/data/queries';
import { useCapabilities } from '~/data/session';
import { cn } from '~/lib-allowlist';
import { EmptyState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { SegmentedControl, type TabOption } from '~/ui/Tabs';
import { tw } from '~/ui/tokens';

import { PagedPostList } from './PagedPostList';
import { OfflineBanner, useOffline } from './states';
import { TAG_WINDOWS, tagFromParam } from './tags';

type TagSort = 'recent' | 'top';

const SORTS: readonly TabOption<TagSort>[] = [
  { value: 'recent', label: 'Latest' },
  { value: 'top', label: 'Top' },
];

/**
 * A hashtag or cashtag page (UX_SPEC §4.17, PRD EXPL-07): Latest, and Top
 * where the contract ranks likes, with its 24h / All time window. The page
 * reads the tag as indexed, so on dev only posts whose first tag it is show.
 */
export function HashtagScreen({ tagParam }: { tagParam: string | undefined }) {
  const tag = tagFromParam(tagParam);
  const capabilities = useCapabilities();
  const offline = useOffline();
  const [chosenSort, setSort] = useState<TagSort>('recent');
  const [chosenWindow, setWindow] = useState<RankingWindow>('all');
  const sort: TagSort = chosenSort === 'top' && capabilities?.rankings ? 'top' : 'recent';
  const windowed = sort === 'top' && Boolean(capabilities?.windowedRankings);
  const rankWindow: RankingWindow = windowed ? chosenWindow : 'all';

  const storage = tag.storage;
  const key = queryKeys.feed.hashtag({ tag: storage, sort, window: rankWindow });
  const fresh = usePullToRefresh();
  const posts = useEngineInfiniteQuery<PostDTO>(
    key,
    (api, cursor) => api.feed.hashtag({ tag: storage, sort, window: rankWindow, cursor, ...fresh.take() }),
    { persist: true, enabled: storage !== '' },
  );

  if (!storage) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Hashtag' }} />
        <EmptyState
          title="Not a hashtag"
          description="This link doesn't name a hashtag or cashtag."
          icon={HashtagIcon}
          testID="hashtag-invalid"
        />
      </Screen>
    );
  }

  const header = capabilities?.rankings ? (
    <View className={cn('gap-2 border-b px-4 py-2', tw.border)}>
      <SegmentedControl options={SORTS} value={sort} onChange={setSort} testID="hashtag-sort" />
      {windowed ? (
        <SegmentedControl options={TAG_WINDOWS} value={rankWindow} onChange={setWindow} testID="hashtag-window" />
      ) : null}
    </View>
  ) : undefined;

  return (
    <Screen>
      <Stack.Screen options={{ title: tag.display }} />
      {offline ? <OfflineBanner message="You're offline. Showing saved posts." /> : null}
      <PagedPostList
        key={`${sort}:${rankWindow}`}
        queryKey={key}
        query={posts}
        header={header}
        loadingLabel={sort === 'top' ? `Loading top posts with ${tag.display}…` : `Loading posts with ${tag.display}…`}
        empty={{
          title: sort === 'top' ? 'No liked posts yet' : 'No posts yet',
          icon: tag.display.startsWith('$') ? CurrencyDollarIcon : HashtagIcon,
        }}
        offline={offline}
        onPullToRefresh={sort === 'top' ? fresh.raise : undefined}
        testID="hashtag-posts"
      />
    </Screen>
  );
}
