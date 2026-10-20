import type { BlockListChoiceDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { Stack, router } from 'expo-router';
import { memo, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { UserGroupIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { sendWrite, useLandingIntent, type WriteSpec } from '~/data/writes';
import { errorMessage } from '~/engine/logs';
import { openUser } from '~/features/post/post-navigation';
import { cn } from '~/lib-allowlist';
import { queryClient } from '~/state/query-client';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { monoFont, tw, useColors, useLargeText } from '~/ui/tokens';

import { copy } from './copy';

interface BlockListVars {
  userId: string;
  follow: boolean;
  handle: string;
}

/** Marks `userId`'s list followed (or not) in the screen's list; returns the undo. */
function setListFollowed(userId: string, follow: boolean): () => void {
  const previous = queryClient.getQueryData<BlockListChoiceDTO[]>(queryKeys.blockListChoices);
  queryClient.setQueryData<BlockListChoiceDTO[]>(queryKeys.blockListChoices, (list) =>
    list?.map((user) => (user.id === userId ? { ...user, listFollowed: follow } : user)),
  );
  return () => queryClient.setQueryData(queryKeys.blockListChoices, previous);
}

/**
 * Use (or stop using) someone's block list. The row changes at once and
 * changes back if the write fails; once it lands, everything that says who
 * is hidden is read again.
 */
export const blockListWrite: WriteSpec<BlockListVars> = {
  key: ({ userId }) => `block-list:${userId}`,
  intent: ({ follow }) => follow,
  submit: (api, { userId, follow }) => api.safety.setBlockListFollowed(userId, follow),
  // Its change is the query cache's alone, which the chain read repairs.
  reconcile: null,
  optimistic: ({ userId, follow }) => setListFollowed(userId, follow),
  failureMessage: ({ follow }) => (follow ? copy.blockLists.followFailed : copy.blockLists.unfollowFailed),
  onConfirmed: () => {
    for (const queryKey of [queryKeys.blockLists, queryKeys.blockStatusAll, queryKeys.blockListChoices]) {
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
    }
  },
};

const BlockListRow = memo(function BlockListRow({ user }: { user: BlockListChoiceDTO }) {
  const largeText = useLargeText();
  const handle = handleOf(user);
  // A change still on its way: the button says so, and waits for it.
  const landing = useLandingIntent(`block-list:${user.id}`);
  const busy = landing !== undefined;
  const toggle = () => {
    if (busy) return;
    const follow = !user.listFollowed;
    sendWrite(blockListWrite, { userId: user.id, follow, handle }, follow ? copy.blockLists.followed(handle) : copy.blockLists.unfollowed(handle));
  };
  const button = (
    <Button
      label={busy ? copy.blockLists.saving : user.listFollowed ? copy.blockLists.following : copy.blockLists.follow}
      variant={user.listFollowed ? 'outline' : 'primary'}
      size="sm"
      accessibilityLabel={user.listFollowed ? copy.blockLists.unfollowA11y(handle) : copy.blockLists.followA11y(handle)}
      disabled={busy}
      onPress={toggle}
      testID={`block-list-${user.id}`}
    />
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[user.displayName, handle, user.listFollowed ? copy.blockLists.following : null].filter(Boolean).join(', ')}
      accessibilityActions={[{ name: 'toggle', label: user.listFollowed ? copy.blockLists.unfollow : copy.blockLists.follow }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'toggle') toggle();
      }}
      onPress={() => openUser(user.id)}
      testID={`block-list-row-${user.id}`}
      className={cn('min-h-[72px] flex-row items-center gap-3 border-b px-4 py-3', tw.border, tw.pressed)}
    >
      <Avatar avatar={user.avatar} identityId={user.id} size="md" />
      <View className="flex-1 gap-0.5">
        <Text variant="bodyStrong" numberOfLines={largeText ? undefined : 1}>
          {user.displayName}
        </Text>
        <Text variant="subhead" tone="secondary" numberOfLines={1} style={user.username ? undefined : monoFont}>
          {handle}
        </Text>
        {largeText ? <View className="mt-2 self-start">{button}</View> : null}
      </View>
      {largeText ? null : button}
    </Pressable>
  );
});

/**
 * Settings → Privacy & Safety → Block lists (PRD SAFE-03, web's Settings →
 * Block lists): the people the viewer follows, each with "Use list" to hide
 * whoever they block too.
 */
export function BlockListsScreen() {
  const { status, identityId: viewerId } = useSession();
  const signedIn = status === 'signed-in' && viewerId !== null;
  const c = useColors();
  const list = useEngineQuery(queryKeys.blockListChoices, (api) => api.safety.blockListChoices(), { enabled: signedIn });
  const [refreshing, setRefreshing] = useState(false);
  const header = <Stack.Screen options={{ title: copy.blockLists.title }} />;

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
            title={copy.blockLists.signIn}
            icon={UserGroupIcon}
            action={{ label: copy.signIn, onPress: () => router.push('/sign-in') }}
            testID="block-lists-signed-out"
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
      <View className="items-center gap-3 p-8" testID="block-lists-loading">
        <Spinner />
        <Text variant="subhead" tone="secondary">
          {copy.blockLists.loading}
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
        retrying={list.isRetrying}
        testID="block-lists-error"
      />
    );
  } else {
    empty = (
      <EmptyState
        title={copy.blockLists.empty}
        description={copy.blockLists.emptyDescription}
        icon={UserGroupIcon}
        testID="block-lists-empty"
      />
    );
  }

  return (
    <Screen>
      {header}
      <FlashList
        data={list.data ?? []}
        keyExtractor={(user) => user.id}
        renderItem={({ item }) => <BlockListRow user={item} />}
        ListHeaderComponent={
          <Text variant="subhead" tone="secondary" className="px-4 py-4" testID="block-lists-intro">
            {copy.blockLists.intro}
          </Text>
        }
        ListEmptyComponent={empty}
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
        testID="block-lists"
      />
    </Screen>
  );
}
