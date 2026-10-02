import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { useEngineStatus } from '~/engine/hooks';
import { Button } from '~/ui/Button';
import { ErrorState } from '~/ui/EmptyState';
import { PostSkeleton } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { PostItem } from './PostItem';

function Header() {
  const { status, session } = useSession();
  const { state } = useEngineStatus();
  const who =
    status === 'signed-in' ? `Signed in as ${session?.username ?? session?.identityId}` : status === 'signed-out' ? 'Signed out' : 'Session: restoring…';
  return (
    <View className={`gap-2 border-b px-4 py-3 ${tw.border}`}>
      <Text variant="captionStrong" tone="secondary" className="uppercase tracking-wider">
        Live: feed.home For You · engine {state}
      </Text>
      <View className="flex-row items-center justify-between gap-2">
        <Text variant="subhead" tone="secondary" className="shrink" testID="live-session">
          {who}
        </Text>
        <Button
          label="Diagnostics"
          variant="outline"
          size="sm"
          onPress={() => router.push('/settings/diagnostics')}
        />
      </View>
    </View>
  );
}

/**
 * Dev gallery, `__gallery?section=live`: the real For You feed through the
 * data layer, rendered with `PostItem`, so actions run end to end (sign in
 * from diagnostics to try the writes).
 */
export function LiveFeedGallery() {
  const feed = useEngineInfiniteQuery(
    queryKeys.feed.home({ tab: 'forYou' }),
    (api, cursor) => api.feed.home({ tab: 'forYou', cursor }),
    { persist: true },
  );

  return (
    <FlashList
      data={feed.items}
      keyExtractor={(post) => post.id}
      renderItem={({ item }) => <PostItem post={item} />}
      ListHeaderComponent={Header}
      ListEmptyComponent={
        feed.isError ? (
          <ErrorState message={feed.error.message} onRetry={() => feed.refetch()} />
        ) : (
          <View>
            <PostSkeleton />
            <PostSkeleton />
          </View>
        )
      }
      ListFooterComponent={feed.isFetchingNextPage ? <Spinner /> : null}
      onEndReached={() => {
        if (feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage().catch(() => undefined);
      }}
      refreshing={feed.isRefetching && !feed.isFetchingNextPage}
      onRefresh={() => feed.refetch()}
      contentInsetAdjustmentBehavior="automatic"
      testID="live-feed"
    />
  );
}
