import type { ConversationDTO } from '@engine/api';
import { useNetInfo } from '@react-native-community/netinfo';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, View } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatBubbleOvalLeftEllipsisIcon, EllipsisHorizontalIcon, LockClosedIcon } from 'react-native-heroicons/outline';

import { errorCode } from '~/data/writes';
import { openUser } from '~/features/post/post-navigation';
import { ContextMenu, type MenuItem } from '~/ui/ContextMenu';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { useColors } from '~/ui/tokens';

import { Composer, ComposerBanner } from './Composer';
import { ConversationAvatar } from './ConversationAvatar';
import { deleteConversation, setBlockedInMessages } from './dm-actions';
import {
  markConversationRead,
  openConversation,
  readErrorMessage,
  refreshDm,
  useConversation,
  useDmBackend,
  useDmSettings,
  useDmStatus,
  useDmViewer,
  useMessages,
  usePeople,
} from './dm-data';
import { buildTimeline, chronological, composerBlockedReason, conversationTitle, memberCount, type TimelineItem } from './dm-model';
import { DaySeparator, MessageBubble } from './MessageBubble';
import { DmLocked } from './DmStates';
import { takeDraft, useDraft, useDrafts } from './drafts';
import { forgetLanded, mergeOutbox, resolveFailed, sendInBackground, useOutboxFor } from './outbox';
import { UnlockSheet } from './UnlockSheet';

/** Hides the tab bar while this screen is focused (UX_SPEC §4.20). */
function useHiddenTabBar(): void {
  const navigation = useNavigation();
  useFocusEffect(
    useCallback(() => {
      const tabs = navigation.getParent();
      tabs?.setOptions({ tabBarStyle: { display: 'none' } });
      return () => tabs?.setOptions({ tabBarStyle: undefined });
    }, [navigation]),
  );
}

function HeaderTitle({ conversation, onPress }: { conversation: ConversationDTO; onPress: () => void }) {
  const title = conversationTitle(conversation);
  const subtitle =
    conversation.kind === 'group'
      ? memberCount(conversation.members.length)
      : conversation.peer?.username
        ? `@${conversation.peer.username}`
        : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={conversation.kind === 'group' ? `${title}, group info` : `${title}, view profile`}
      onPress={onPress}
      className="flex-row items-center gap-2 active:opacity-70"
      style={{ maxWidth: 240 }}
      testID="dm-header-title"
    >
      <ConversationAvatar conversation={conversation} size="sm" />
      <View className="shrink">
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function menuItems(conversation: ConversationDTO, v5: boolean): MenuItem[] {
  if (conversation.kind === 'group') {
    return [
      { id: 'info', title: 'Group info', systemImage: 'info.circle' },
      ...(v5 ? [{ id: 'delete', title: 'Delete conversation', systemImage: 'trash', destructive: true }] : []),
    ];
  }
  const items: MenuItem[] = [{ id: 'profile', title: 'View profile', systemImage: 'person.crop.circle' }];
  if (v5) {
    items.push(
      conversation.flags.blocked
        ? { id: 'unblock', title: 'Unblock', systemImage: 'hand.raised.slash' }
        : { id: 'block', title: 'Block', systemImage: 'hand.raised', destructive: true },
      { id: 'delete', title: 'Delete conversation', systemImage: 'trash', destructive: true },
    );
  } else {
    items.push({ id: 'block', title: 'Block', systemImage: 'hand.raised', destructive: true });
  }
  return items;
}

/**
 * A conversation (UX_SPEC §4.20, PRD DM-03, DM-04, DM-08, DM-10, DM-11):
 * bubbles oldest to newest opening at the newest, older pages on scrolling
 * up, the composer with per-send status, live updates while open (the engine
 * polls an open conversation every 4 s), read marks, and the states that
 * replace the composer.
 */
export function ConversationScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  const key = conversationId ?? '';
  const { signedIn, viewerId } = useDmViewer();
  const backend = useDmBackend();
  const v5 = backend !== 'legacy';
  const c = useColors();
  const insets = useSafeAreaInsets();
  // The bottom follows the keyboard frame by frame (Android edge-to-edge never resizes the window).
  const keyboard = useAnimatedKeyboard();
  const bottomInset = insets.bottom;
  const keyboardPadding = useAnimatedStyle(() => ({
    paddingBottom: Math.max(keyboard.height.value, bottomInset),
  }));
  useHiddenTabBar();

  const status = useDmStatus(signedIn);
  const locked = status.data?.locked === true;
  const ready = signedIn && status.data !== undefined && !locked;
  const conversation = useConversation(key, ready);
  const messages = useMessages(key, ready);
  const settings = useDmSettings(ready && backend === 'legacy');
  // Members, and anyone who wrote here (a member who has left keeps their name on their messages).
  const group = conversation?.kind === 'group';
  const members = conversation?.members;
  const senderIds = useMemo(
    () => (group ? [...(members ?? []), ...messages.items.filter((m) => !m.own).map((m) => m.sender)] : []),
    [group, members, messages.items],
  );
  const people = usePeople(senderIds, ready);
  const outbox = useOutboxFor(viewerId, key);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const closeUnlock = useCallback(() => setUnlockOpen(false), []);

  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  // The engine polls the conversation on screen fast (v5 4 s, legacy 3 s).
  useEffect(() => {
    if (!focused || !ready || !key) return undefined;
    openConversation(key);
    return () => openConversation(null);
  }, [focused, ready, key]);

  const unread = conversation?.unread ?? 0;
  useEffect(() => {
    if (focused && ready && unread > 0) markConversationRead(key);
  }, [focused, ready, unread, key]);

  const merged = useMemo(() => mergeOutbox(chronological(messages.items), outbox), [messages.items, outbox]);
  useEffect(() => forgetLanded(merged.landed), [merged.landed]);
  const receipts = backend === 'legacy' && settings.data?.sendReadReceipts === true;
  const peerReadAt = conversation?.peerReadAt ?? null;
  const timeline = useMemo(
    () =>
      buildTimeline(merged.messages, {
        sending: merged.sending,
        peerReadAt: receipts && peerReadAt ? new Date(peerReadAt) : null,
      }),
    [merged, receipts, peerReadAt],
  );

  const draft = useDraft(viewerId, key);
  const setDraft = useCallback(
    (text: string) => {
      if (viewerId) useDrafts.getState().set(viewerId, key, text);
    },
    [viewerId, key],
  );

  const listRef = useRef<FlashListRef<TimelineItem>>(null);
  const scrollToNewest = useCallback((animated = true) => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
  }, []);
  // The newest message stays in view when the keyboard opens.
  useEffect(() => {
    const sub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => scrollToNewest());
    return () => sub.remove();
  }, [scrollToNewest]);

  const offline = useNetInfo().isConnected === false;
  const send = () => {
    if (!viewerId || !draft.trim()) return;
    if (offline) {
      // PRD G-1: nothing is sent, and the text stays in the composer.
      toast("You're offline. Nothing was sent.");
      return;
    }
    // Taken from the store, not this render: a second tap before the re-render finds it empty.
    const text = takeDraft(viewerId, key);
    if (!text.trim()) return;
    sendInBackground(viewerId, key, text);
    scrollToNewest();
  };

  const openInfo = useCallback(() => {
    router.push({ pathname: '/messages/[conversationId]/info', params: { conversationId: key } });
  }, [key]);
  const peerId = conversation?.peer?.id ?? '';
  const onMenu = (id: string) => {
    if (!conversation) return;
    if (id === 'info') openInfo();
    else if (id === 'profile') openUser(peerId);
    else if (id === 'delete') {
      deleteConversation(conversation)
        .then((deleted) => {
          if (deleted && router.canGoBack()) router.back();
        })
        .catch(() => undefined);
    } else if (id === 'block' && v5) setBlockedInMessages(peerId, true).catch(() => undefined);
    else if (id === 'block') router.push({ pathname: '/block/[userId]', params: { userId: peerId } });
    else if (id === 'unblock') setBlockedInMessages(peerId, false).catch(() => undefined);
  };

  const header = (
    <Stack.Screen
      options={{
        title: conversation ? conversationTitle(conversation) : 'Conversation',
        headerTitle: conversation
          ? () => (
              <HeaderTitle
                conversation={conversation}
                onPress={conversation.kind === 'group' ? openInfo : () => openUser(peerId)}
              />
            )
          : undefined,
        headerRight: conversation
          ? () => (
              <ContextMenu items={menuItems(conversation, v5)} onSelect={onMenu} testID="dm-conversation-menu">
                <IconButton icon={EllipsisHorizontalIcon} accessibilityLabel="Conversation options" />
              </ContextMenu>
            )
          : undefined,
      }}
    />
  );

  if (locked) {
    return (
      <Screen scroll>
        {header}
        <DmLocked onUnlock={() => setUnlockOpen(true)} />
        <UnlockSheet open={unlockOpen} onClose={closeUnlock} />
      </Screen>
    );
  }
  if (!signedIn) {
    return (
      <Screen>
        {header}
        <EmptyState icon={LockClosedIcon} title="Sign in to read your messages" />
      </Screen>
    );
  }

  let empty = null;
  if (status.isError && !status.data) {
    // The status gates every read below: without it nothing would ever load.
    empty = <ErrorState message={readErrorMessage(status.error)} onRetry={() => refreshDm()} testID="dm-conversation-error" />;
  } else if (messages.isError && !messages.data) {
    empty =
      errorCode(messages.error) === 'BAD_REQUEST' ? (
        <EmptyState
          icon={ChatBubbleOvalLeftEllipsisIcon}
          title="This conversation isn't available"
          description="It may have been removed from this device."
          testID="dm-conversation-missing"
        />
      ) : (
        <ErrorState
          message={readErrorMessage(messages.error)}
          onRetry={() => {
            messages.refetch().catch(() => undefined);
          }}
          testID="dm-conversation-error"
        />
      );
  } else if (!messages.data && !merged.messages.length) {
    empty = (
      <View className="flex-1 items-center justify-center p-8" testID="dm-conversation-loading">
        <Spinner size="md" />
      </View>
    );
  } else if (timeline.length === 0) {
    empty = (
      <View className="flex-1 items-center justify-center p-8">
        <Text variant="body" tone="secondary" className="text-center" testID="dm-conversation-empty">
          No messages yet. Start the conversation!
        </Text>
      </View>
    );
  }

  const blockedReason = composerBlockedReason(conversation);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messages;

  return (
    <Screen>
      {header}
      <View className="flex-1">
        {empty ?? (
          <FlashList
            ref={listRef}
            data={timeline}
            keyExtractor={(item) => item.id}
            getItemType={(item) => item.type}
            renderItem={({ item }) =>
              item.type === 'day' ? (
                <DaySeparator label={item.label} />
              ) : (
                <MessageBubble
                  item={item}
                  group={group}
                  senderName={people.byId.get(item.message.sender)?.displayName}
                  senderAvatar={people.byId.get(item.message.sender)?.avatar}
                  onResolve={(id) => {
                    resolveFailed(id).catch(() => undefined);
                  }}
                  onSenderPress={openUser}
                />
              )
            }
            maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
            onStartReached={() => {
              if (hasNextPage && !isFetchingNextPage) fetchNextPage().catch(() => undefined);
            }}
            onStartReachedThreshold={0.5}
            ListHeaderComponent={
              isFetchingNextPage ? (
                <View className="items-center py-3">
                  <Spinner size="sm" />
                </View>
              ) : null
            }
            ListFooterComponent={<View className="h-2" />}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            testID="dm-messages"
          />
        )}
      </View>
      {/* The bar and the space under it (keyboard or home indicator) share its color. */}
      <Animated.View style={[{ backgroundColor: blockedReason ? c.bgMuted : c.bg }, keyboardPadding]}>
        {blockedReason ? (
          <ComposerBanner text={blockedReason} />
        ) : (
          <Composer value={draft} onChangeText={setDraft} onSend={send} disabled={!conversation && !messages.data} />
        )}
      </Animated.View>
    </Screen>
  );
}
