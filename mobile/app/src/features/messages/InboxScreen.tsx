import type { ConversationDTO } from '@engine/api';
import { useNetInfo } from '@react-native-community/netinfo';
import { FlashList } from '@shopify/flash-list';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, TextInput, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { ChatBubbleLeftRightIcon, Cog6ToothIcon, PencilSquareIcon } from 'react-native-heroicons/outline';
import { MagnifyingGlassIcon, XCircleIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { ContextMenu } from '~/ui/ContextMenu';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { LinkText } from '~/ui/LinkText';
import { Screen } from '~/ui/Screen';
import { toast } from '~/ui/toast';
import { colors, hitSlopFor, tw, useColors } from '~/ui/tokens';

import { ConversationRow } from './ConversationRow';
import { deleteConversation, openConversationScreen } from './dm-actions';
import { readErrorMessage, refreshDm, useConversations, useDmBackend, useDmStatus, useDmViewer } from './dm-data';
import { matchesSearch, sortConversations } from './dm-model';
import { DmLocked, DmSignedOut, InboxNotice, InboxSkeleton, RestoringBanner } from './DmStates';
import { Text } from '~/ui/Text';
import { UnlockSheet } from './UnlockSheet';

const openNew = () => router.push('/messages/new');
const openNewGroup = () => router.push('/messages/new-group');
const openSettings = () => router.push('/messages/settings');

function HeaderActions({ v5 }: { v5: boolean }) {
  const compose = (
    <IconButton
      icon={PencilSquareIcon}
      accessibilityLabel="New message"
      onPress={v5 ? undefined : openNew}
      onLongPress={Platform.OS === 'android' ? () => toast('New message') : undefined}
      testID="messages-new"
    />
  );
  return (
    <View className="flex-row items-center gap-1">
      <IconButton
        icon={Cog6ToothIcon}
        accessibilityLabel="Message settings"
        onPress={openSettings}
        onLongPress={Platform.OS === 'android' ? () => toast('Message settings') : undefined}
        testID="messages-settings"
      />
      {v5 ? (
        <ContextMenu
          items={[
            { id: 'new', title: 'New message', systemImage: 'square.and.pencil' },
            { id: 'group', title: 'New group', systemImage: 'person.3' },
          ]}
          onSelect={(id) => (id === 'group' ? openNewGroup() : openNew())}
          testID="messages-new-menu"
        >
          {compose}
        </ContextMenu>
      ) : (
        compose
      )}
    </View>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const c = useColors();
  return (
    <View className="px-4 pb-2 pt-1">
      <View
        className={cn(
          'min-h-9 flex-row items-center gap-2 px-2.5',
          tw.bgMuted,
          Platform.OS === 'ios' ? 'rounded-[10px]' : 'rounded-full px-3.5',
        )}
      >
        <MagnifyingGlassIcon size={16} color={c.textSecondary} />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="Search messages"
          placeholderTextColor={c.textPlaceholder}
          accessibilityLabel="Search messages"
          accessibilityRole="search"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          cursorColor={c.accent}
          selectionColor={c.accent}
          className="flex-1 text-gray-900 dark:text-gray-100"
          style={{ fontSize: 16, minHeight: 36, paddingVertical: 0 }}
          testID="messages-search"
        />
        {value ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={hitSlopFor(20)} onPress={() => onChange('')}>
            <XCircleIcon size={18} color={c.textSecondary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** iOS: swipe left for "Delete" (as Mail and Messages). */
function SwipeToDelete({ conversation, children }: { conversation: ConversationDTO; children: React.ReactNode }) {
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={(_progress, _translation, methods) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete conversation"
          onPress={() => {
            methods.close();
            deleteConversation(conversation).catch(() => undefined);
          }}
          className="w-24 items-center justify-center bg-red-600"
        >
          <Text variant="subheadStrong" style={{ color: colors.white }}>
            Delete
          </Text>
        </Pressable>
      )}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

/**
 * The Messages tab (UX_SPEC §4.19, PRD DM-01, DM-02, DM-09, DM-11, DM-13):
 * conversations by last activity with search, restoring progress, deleted
 * conversations behind a footer link, and the signed-out and locked states.
 */
export function InboxScreen() {
  const { signedIn } = useDmViewer();
  const backend = useDmBackend();
  const v5 = backend !== 'legacy';
  const offline = useNetInfo().isConnected === false;
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const status = useDmStatus(signedIn);
  const locked = status.data?.locked === true;
  const canList = signedIn && status.data !== undefined && !locked;
  const list = useConversations(canList, canList && backend === 'legacy' && focused);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const closeUnlock = useCallback(() => setUnlockOpen(false), []);

  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const all = useMemo(() => sortConversations(list.data ?? []), [list.data]);
  const hiddenCount = all.filter((c) => c.flags.hidden).length;
  const rows = useMemo(
    () => all.filter((c) => (showHidden || !c.flags.hidden) && matchesSearch(c, query)),
    [all, showHidden, query],
  );

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    if (offline) {
      toast("You're offline");
      return;
    }
    setRefreshing(true);
    Promise.all([status.refetch(), canList ? list.refetch() : undefined])
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  const onPress = useCallback((conversation: ConversationDTO) => openConversationScreen(conversation.key), []);
  const onLongPress = useCallback((conversation: ConversationDTO) => {
    showActionSheet({
      actions: [
        { label: 'Open', onPress: () => openConversationScreen(conversation.key) },
        { label: 'Delete conversation', destructive: true, onPress: () => deleteConversation(conversation).catch(() => undefined) },
      ],
    });
  }, []);

  const header = (
    <Stack.Screen
      options={{
        title: 'Messages',
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
        headerRight: signedIn && !locked ? () => <HeaderActions v5={v5} /> : undefined,
      }}
    />
  );

  if (!signedIn) {
    return (
      <Screen scroll>
        {header}
        <DmSignedOut groups={v5} />
      </Screen>
    );
  }

  if (locked) {
    return (
      <Screen scroll>
        {header}
        <DmLocked onUnlock={() => setUnlockOpen(true)} />
        <UnlockSheet open={unlockOpen} onClose={closeUnlock} />
      </Screen>
    );
  }

  const error = status.error ?? list.error;
  let empty;
  if ((status.isError && !status.data) || (list.isError && !list.data)) {
    empty = (
      <ErrorState
        message={readErrorMessage(error)}
        onRetry={() => refreshDm()}
        testID="messages-error"
      />
    );
  } else if (!list.data) {
    empty = <InboxSkeleton />;
  } else if (query.trim() && all.length > 0) {
    empty = <EmptyState title="No conversations match your search" icon={MagnifyingGlassIcon} testID="messages-no-match" />;
  } else {
    empty = (
      <EmptyState
        icon={ChatBubbleLeftRightIcon}
        title="Welcome to Messages"
        description={
          v5
            ? 'Private 1-on-1 and group conversations. Messages are encrypted, and nobody watching Dash Platform can tell who you talk to.'
            : 'Private 1-on-1 conversations. Messages are encrypted.'
        }
        action={{ label: 'New message', onPress: openNew }}
        testID="messages-empty"
      />
    );
  }

  const recovery = status.data?.recovery ?? null;
  const listHeader = (
    <View>
      {all.length > 0 ? <SearchBox value={query} onChange={setQuery} /> : null}
      {offline ? <InboxNotice text="You're offline. New messages show up when you reconnect." testID="messages-offline" /> : null}
      {!offline && status.data?.error ? (
        <InboxNotice text="Couldn't check for new messages. Pull to try again." testID="messages-poll-error" />
      ) : null}
      {recovery ? <RestoringBanner recovery={recovery} /> : null}
    </View>
  );

  const footer =
    v5 && hiddenCount > 0 && !query.trim() ? (
      <View className="items-center py-4">
        <LinkText
          label={showHidden ? 'Hide deleted conversations' : `Show ${hiddenCount} deleted conversation${hiddenCount === 1 ? '' : 's'}`}
          onPress={() => setShowHidden((shown) => !shown)}
          className="self-center"
          testID="messages-toggle-hidden"
        />
      </View>
    ) : null;

  return (
    <Screen>
      {header}
      <FlashList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          const row = (
            <ConversationRow conversation={item} onPress={onPress} onLongPress={v5 ? onLongPress : undefined} />
          );
          return v5 && Platform.OS === 'ios' && !item.flags.hidden ? (
            <SwipeToDelete conversation={item}>{row}</SwipeToDelete>
          ) : (
            row
          );
        }}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.yappr500} colors={[colors.yappr500]} />}
        testID="messages-list"
      />
    </Screen>
  );
}
