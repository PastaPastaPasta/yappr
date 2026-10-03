import type { ConversationDTO } from '@engine/api';
import { useNetInfo } from '@react-native-community/netinfo';
import { FlashList } from '@shopify/flash-list';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, RefreshControl, TextInput, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { ChatBubbleLeftRightIcon, Cog6ToothIcon, PencilSquareIcon } from 'react-native-heroicons/outline';
import { MagnifyingGlassIcon, XCircleIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { ContextMenu } from '~/ui/ContextMenu';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { LinkText } from '~/ui/LinkText';
import { useBlockScreenCapture } from '~/ui/screen-capture';
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
      {/* PRD DM-11: legacy (testnet) has no Message settings; its read receipts live in Settings (SET-04). */}
      {v5 ? (
        <IconButton
          icon={Cog6ToothIcon}
          accessibilityLabel="Message settings"
          onPress={openSettings}
          onLongPress={Platform.OS === 'android' ? () => toast('Message settings') : undefined}
          testID="messages-settings"
        />
      ) : null}
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
  const swipeable = useRef<SwipeableMethods>(null);
  // FlashList reuses this cell for other conversations: one swiped open must not stay open on another.
  useEffect(() => {
    swipeable.current?.reset();
  }, [conversation.key]);
  return (
    <ReanimatedSwipeable
      ref={swipeable}
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
  const c = useColors();
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
  // Conversation previews stay out of Android's Recents and screenshots.
  useBlockScreenCapture('private', focused);

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
  const swipes = (conversation: ConversationDTO) => v5 && Platform.OS === 'ios' && !conversation.flags.hidden;
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

  const error = status.error ?? list.error;
  let empty;
  if (!signedIn) {
    empty = <DmSignedOut groups={v5} />;
  } else if (locked) {
    empty = <DmLocked onUnlock={() => setUnlockOpen(true)} />;
  } else if ((status.isError && !status.data) || (list.isError && !list.data)) {
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
  } else if (hiddenCount > 0) {
    // Every conversation is deleted (DM-09): not a first visit, so no welcome. The footer brings them back.
    empty = (
      <EmptyState
        icon={ChatBubbleLeftRightIcon}
        title="No conversations to show"
        description="Deleted conversations come back if a new message arrives."
        testID="messages-all-deleted"
      />
    );
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

  // Signed in with the key: the inbox, its header and footer (else just the empty state).
  const inbox = signedIn && !locked;
  const recovery = status.data?.recovery ?? null;
  const listHeader = inbox ? (
    <View>
      {all.length > 0 ? <SearchBox value={query} onChange={setQuery} /> : null}
      {offline ? <InboxNotice text="You're offline. New messages show up when you reconnect." testID="messages-offline" /> : null}
      {!offline && status.data?.error ? (
        <InboxNotice text="Couldn't check for new messages. Pull to try again." testID="messages-poll-error" />
      ) : null}
      {recovery ? <RestoringBanner recovery={recovery} /> : null}
    </View>
  ) : null;

  const footer =
    inbox && v5 && hiddenCount > 0 && !query.trim() ? (
      <View className="items-center py-4">
        <LinkText
          label={showHidden ? 'Hide deleted conversations' : `Show ${hiddenCount} deleted conversation${hiddenCount === 1 ? '' : 's'}`}
          onPress={() => setShowHidden((shown) => !shown)}
          className="self-center"
          testID="messages-toggle-hidden"
        />
      </View>
    ) : null;

  // The list is the screen's first native view from the first render, in every state (signed
  // out, locked, loading, empty): iOS only collapses a large title into the bar for a scroll view
  // it finds down the first-subview chain when the screen appears, so a placeholder swapped for
  // the list later leaves the title fixed over the rows (D-L4i-004, UX_SPEC §3.4).
  return (
    <>
      {header}
      <FlashList
        data={inbox ? rows : []}
        keyExtractor={(item) => item.key}
        getItemType={(item) => (swipes(item) ? 'swipe' : 'row')}
        renderItem={({ item }) => {
          const row = (
            <ConversationRow conversation={item} onPress={onPress} onLongPress={v5 ? onLongPress : undefined} />
          );
          return swipes(item) ? (
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
        refreshControl={
          inbox ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.yappr500} colors={[colors.yappr500]} />
          ) : undefined
        }
        style={{ backgroundColor: c.bg }}
        // `messages-list` only once there is an inbox to show (the e2e flows rely on it).
        testID={inbox ? 'messages-list' : 'messages-placeholder'}
      />
      {locked ? <UnlockSheet open={unlockOpen} onClose={closeUnlock} /> : null}
    </>
  );
}
