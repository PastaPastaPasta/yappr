import type { BlockedUserDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { Stack, router } from 'expo-router';
import { memo, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { NoSymbolIcon } from 'react-native-heroicons/outline';

import { config } from '~/config';
import { cn } from '~/lib-allowlist';
import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { sendWrite } from '~/data/writes';
import { errorMessage } from '~/engine/logs';
import { openExternal, openUser } from '~/features/post/post-navigation';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { LinkText } from '~/ui/LinkText';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { monoFont, tw, useColors, useLargeText } from '~/ui/tokens';

import { blockWrite, useBlockedList } from './block-state';
import { copy } from './copy';

/** Where web manages block lists (Settings → Privacy & Security). */
const BLOCK_LISTS_URL = `https://yap.pr${config.webBasePath}/settings?section=privacy`;

/** One blocked account: avatar, name, handle, the public note, and "Unblock" (UX_SPEC §4.29). */
const BlockedRow = memo(function BlockedRow({ user, viewerId }: { user: BlockedUserDTO; viewerId: string }) {
  const largeText = useLargeText();
  const handle = handleOf(user);
  const unblock = () => sendWrite(blockWrite, { viewerId, userId: user.id, block: false }, copy.toast.unblocked);
  const button = (
    <Button
      label={copy.block.unblock}
      variant="outline"
      size="sm"
      accessibilityLabel={`Unblock ${handle}`}
      onPress={unblock}
      testID={`unblock-${user.id}`}
    />
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[user.displayName, handle, user.message].filter(Boolean).join(', ')}
      accessibilityActions={[{ name: 'unblock', label: 'Unblock' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'unblock') unblock();
      }}
      onPress={() => openUser(user.id)}
      testID={`blocked-${user.id}`}
      className={cn('min-h-[72px] flex-row gap-3 border-b px-4 py-3', tw.border, tw.pressed)}
    >
      <Avatar avatar={user.avatar} identityId={user.id} size="md" />
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-start gap-3">
          <View className="flex-1">
            <Text variant="bodyStrong" numberOfLines={largeText ? undefined : 1}>
              {user.displayName}
            </Text>
            <Text variant="subhead" tone="secondary" numberOfLines={1} style={user.username ? undefined : monoFont}>
              {handle}
            </Text>
          </View>
          {largeText ? null : button}
        </View>
        {user.message ? (
          <Text variant="subhead" tone="secondary" className="italic" numberOfLines={3}>
            {user.message}
          </Text>
        ) : null}
        {largeText ? <View className="mt-2 self-start">{button}</View> : null}
      </View>
    </Pressable>
  );
});

/** "Block lists you follow are managed on yap.pr." with the link (PRD SAFE-03). */
function ListsNote() {
  return (
    <View className="gap-1 px-4 py-5">
      <Text variant="subhead" tone="secondary">
        {copy.blocked.listsNote}
      </Text>
      <LinkText label={copy.blocked.listsLink} onPress={() => openExternal(BLOCK_LISTS_URL)} testID="blocked-lists-link" />
    </View>
  );
}

/**
 * Settings → Privacy & Safety → Blocked accounts (PRD SAFE-03). The viewer's
 * own blocks, newest first, each with its note and "Unblock", which takes
 * the row away at once (it comes back if the unblock fails).
 */
export function BlockedAccountsScreen() {
  const { status, identityId: viewerId } = useSession();
  const signedIn = status === 'signed-in' && viewerId !== null;
  const c = useColors();
  const list = useEngineInfiniteQuery(queryKeys.blocked, (api, cursor) => api.safety.blocked(cursor), {
    enabled: signedIn,
  });
  const users = useBlockedList(viewerId ?? '', list.items);
  const [refreshing, setRefreshing] = useState(false);
  const header = <Stack.Screen options={{ title: copy.blocked.title }} />;

  if (!signedIn) {
    return (
      <Screen>
        {header}
        {status === 'unknown' ? (
          <View className="items-center p-8">
            <Spinner />
          </View>
        ) : (
          <EmptyState
            title={copy.blocked.signIn}
            icon={NoSymbolIcon}
            action={{ label: copy.signIn, onPress: () => router.push('/sign-in') }}
            testID="blocked-signed-out"
          />
        )}
      </Screen>
    );
  }

  const onRefresh = () => {
    setRefreshing(true);
    list
      .refetch()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  let empty;
  if (list.isPending) {
    empty = (
      <View className="items-center gap-3 p-8" testID="blocked-loading">
        <Spinner />
        <Text variant="subhead" tone="secondary">
          Loading blocked accounts…
        </Text>
      </View>
    );
  } else if (list.isError) {
    empty = (
      <ErrorState
        message={errorMessage(list.error)}
        onRetry={() => {
          list.refetch().catch(() => undefined);
        }}
        testID="blocked-error"
      />
    );
  } else {
    empty = (
      <EmptyState
        title={copy.blocked.empty}
        description={copy.blocked.emptyDescription}
        icon={NoSymbolIcon}
        testID="blocked-empty"
      />
    );
  }

  const footer = (
    <>
      {list.isFetchingNextPage ? (
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
      ) : null}
      {list.isPending || list.isError ? null : <ListsNote />}
    </>
  );

  return (
    <Screen>
      {header}
      <FlashList
        data={users}
        keyExtractor={(user) => user.id}
        renderItem={({ item }) => <BlockedRow user={item} viewerId={viewerId} />}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage && !list.isFetchNextPageError) {
            list.fetchNextPage().catch(() => undefined);
          }
        }}
        onEndReachedThreshold={1.5}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.accent}
            colors={[c.accent]}
            progressBackgroundColor={c.bg}
          />
        }
        testID="blocked-list"
      />
    </Screen>
  );
}
