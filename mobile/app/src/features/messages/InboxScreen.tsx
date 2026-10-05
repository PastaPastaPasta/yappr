import type { ConversationDTO } from '@engine/api';
import { useNetInfo } from '@react-native-community/netinfo';
import { FlashList } from '@shopify/flash-list';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, RefreshControl, TextInput, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { ChatBubbleLeftRightIcon, Cog6ToothIcon, PencilSquareIcon } from 'react-native-heroicons/outline';
import { MagnifyingGlassIcon, XCircleIcon } from 'react-native-heroicons/solid';

import { useEngineStatus } from '~/engine/hooks';
import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { ContextMenu } from '~/ui/ContextMenu';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { LinkText } from '~/ui/LinkText';
import { useBlockScreenCapture } from '~/ui/screen-capture';
import { toast } from '~/ui/toast';
import { RETIRING_INPUT, RETIRING_STYLE, useNativeText } from '~/ui/native-text';
import { colors, hitSlopFor, tw, useColors } from '~/ui/tokens';

import { ConversationRow } from './ConversationRow';
import { archiveConversation, openConversationScreen, useLocallyHidden } from './dm-actions';
import { pollDm, readErrorMessage, useConversations, useDmBackend, useDmStatus, useDmViewer } from './dm-data';
import { matchesSearch, sortConversations } from './dm-model';
import { DmLocked, DmSignedOut, InboxNotice, InboxSkeleton, RestoringBanner } from './DmStates';
import { Text } from '~/ui/Text';
import { UnlockSheet } from './UnlockSheet';

const openNew = () => router.push('/messages/new');
const openNewGroup = () => router.push('/messages/new-group');
const openSettings = () => router.push('/messages/settings');
const retry = () => {
  pollDm().catch(() => undefined);
};

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

const INBOX_SEARCH_TEXT = { fontSize: 16, minHeight: 36, paddingVertical: 0 } as const;

/** Uncontrolled (`useNativeText`), so no keystroke is lost; Clear is put in. */
function SearchBox({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const c = useColors();
  const { key: inputKey, attach, reset, inputProps, retiring } = useNativeText({ value, onChangeText: onChange });
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
        {retiring ? (
          // The input Clear replaced, until the fresh one has the focus.
          <TextInput key={retiring.key} {...retiring.inputProps} {...RETIRING_INPUT} style={[INBOX_SEARCH_TEXT, RETIRING_STYLE]} />
        ) : null}
        <TextInput
          key={inputKey}
          ref={attach}
          {...inputProps}
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
          style={INBOX_SEARCH_TEXT}
          testID="messages-search"
        />
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={hitSlopFor(20)}
            onPress={() => {
              reset('');
              onChange('');
            }}
          >
            <XCircleIcon size={18} color={c.textSecondary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** iOS: swipe left for "Archive" (as Mail). */
function SwipeToArchive({ conversation, children }: { conversation: ConversationDTO; children: React.ReactNode }) {
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
          accessibilityLabel="Archive conversation"
          onPress={() => {
            methods.close();
            archiveConversation(conversation);
          }}
          className="w-24 items-center justify-center bg-yappr-500"
        >
          <Text variant="subheadStrong" style={{ color: colors.white }}>
            Archive
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
 * conversations by last activity with search, restoring progress, archived
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

  const { state: engineState } = useEngineStatus();
  const status = useDmStatus(signedIn);
  const locked = status.data?.locked === true;
  const canList = signedIn && status.data !== undefined && !locked;
  const list = useConversations(canList, canList && backend === 'legacy' && focused);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const closeUnlock = useCallback(() => setUnlockOpen(false), []);

  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const all = useMemo(() => sortConversations(list.data ?? []), [list.data]);
  // Archived by the engine, or on this device ahead of it (an archive's Undo, a group just left).
  const locallyHidden = useLocallyHidden((s) => s.keys);
  const archived = useCallback((convo: ConversationDTO) => convo.flags.hidden || locallyHidden[convo.key] === true, [locallyHidden]);
  const hiddenCount = all.filter(archived).length;
  const rows = useMemo(
    () => all.filter((convo) => (showHidden || !archived(convo)) && matchesSearch(convo, query)),
    [all, archived, showHidden, query],
  );

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    if (offline) {
      toast("You're offline");
      return;
    }
    setRefreshing(true);
    pollDm().finally(() => setRefreshing(false));
  };

  const onPress = useCallback((conversation: ConversationDTO) => openConversationScreen(conversation.key), []);
  const swipes = (conversation: ConversationDTO) => v5 && Platform.OS === 'ios' && !archived(conversation);
  const onLongPress = useCallback(
    (conversation: ConversationDTO) => {
      showActionSheet({
        actions: [
          { label: 'Open', onPress: () => openConversationScreen(conversation.key) },
          ...(archived(conversation)
            ? []
            : [{ label: 'Archive conversation', onPress: () => archiveConversation(conversation) }]),
        ],
      });
    },
    [archived],
  );

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
  // The engine answers the inbox only once its first load is done (ENGINE_BUSY until then, then its
  // failure): until it is ready nothing here may read as a first visit (G-2, G-11).
  const loaded = list.data !== undefined && status.data?.ready === true;
  let empty;
  if (!signedIn) {
    empty = <DmSignedOut groups={v5} />;
  } else if (locked) {
    empty = <DmLocked onUnlock={() => setUnlockOpen(true)} />;
  } else if ((status.isError && !status.data) || (list.isError && !list.data)) {
    empty = <ErrorState message={readErrorMessage(error)} onRetry={retry} testID="messages-error" />;
  } else if (!loaded) {
    empty = <InboxSkeleton connecting={engineState !== 'ready' && engineState !== 'degraded'} />;
  } else if (query.trim() && all.length > 0) {
    empty = <EmptyState title="No conversations match your search" icon={MagnifyingGlassIcon} testID="messages-no-match" />;
  } else if (hiddenCount > 0) {
    // Every conversation is archived (DM-09): not a first visit, so no welcome. The footer shows them.
    empty = <EmptyState icon={ChatBubbleLeftRightIcon} title="No conversations yet" testID="messages-all-archived" />;
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
      {/* With no list yet, the error state says it, with "Try again". */}
      {!offline && status.data?.error && (loaded || all.length > 0) ? (
        <InboxNotice text="Couldn't check for new messages. Pull to try again." testID="messages-poll-error" />
      ) : null}
      {recovery ? <RestoringBanner recovery={recovery} /> : null}
    </View>
  ) : null;

  const footer =
    inbox && v5 && hiddenCount > 0 && !query.trim() ? (
      <View className="items-center py-4">
        <LinkText
          label={showHidden ? 'Hide archived' : `Archived (${hiddenCount})`}
          onPress={() => setShowHidden((shown) => !shown)}
          className="self-center"
          testID="messages-toggle-hidden"
        />
      </View>
    ) : null;

  // The list is the screen's first native view from the first render, in every state (signed
  // out, locked, loading, empty): iOS only collapses a large title into the bar for a scroll view
  // it finds down the first-subview chain when the screen appears, so a placeholder swapped for
  // the list later leaves the title fixed over the rows (UX_SPEC §3.4). Part of D-L4i-004: QA
  // also saw it in a steady state this doesn't explain, still to be checked on a device.
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
            <SwipeToArchive conversation={item}>{row}</SwipeToArchive>
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
