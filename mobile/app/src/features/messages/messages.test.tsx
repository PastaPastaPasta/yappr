import type { ConversationDTO, DmStatusDTO, MessageDTO, Page, SessionDTO, WriteTicket } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react-native';
import {
  Alert,
  AppState,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  type AppStateStatus,
  type KeyboardEvent,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { resetWriteTracking, runWrite } from '~/data/writes';
import { blockWrite, resetBlockDecisions, useAuthorBlocked } from '~/features/safety/block-state';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { largeTitleScrollView } from '~/ui/testing/large-title';
import { RETIRE_MS } from '~/ui/native-text';
import { hostViewAbove } from '~/ui/testing/native-parent';
import { useToastStore } from '~/ui/toast';

import { Composer } from './Composer';
import { ConversationScreen } from './ConversationScreen';
import { GroupInfoScreen } from './GroupInfoScreen';
import { MessageSettingsScreen } from './MessageSettingsScreen';
import { NewGroupScreen } from './NewGroupScreen';
import { NewMessageScreen } from './NewMessageScreen';
import { UNAVAILABLE_MESSAGE, useMessagesBadge, usePeople } from './dm-data';
import { ARCHIVE_UNDO_MS, archiveConversation, setBlockedInMessages } from './dm-actions';
import { resetKeyResends } from './group-keys';
import { forgetDmDrafts, useDraft, useDrafts } from './drafts';
import { InboxScreen } from './InboxScreen';
import { clearLocalMessages, forgetLanded, mergeOutbox, sendMessage, useOutbox, type OutboxEntry } from './outbox';
import { BOB_ID, conversation, dmMessage, FLAGS } from './test-fixtures';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('~/features/post/post-navigation', () => ({ openUser: jest.fn(), openExternal: jest.fn() }));

// FlashList's own Jest setup (@shopify/flash-list/jestSetup): fixed layouts, so cells render.
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => {
  const layout = { x: 0, y: 0, width: 400, height: 900 };
  return {
    ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
    measureParentSize: () => layout,
    measureFirstChildLayout: () => layout,
    measureItemLayout: () => ({ x: 0, y: 0, width: 400, height: 80 }),
  };
});

const VIEWER = 'AliceId111111111111111111111111111111111111';
const viewer: SessionDTO = {
  identityId: VIEWER,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

function status(overrides: Partial<DmStatusDTO> = {}): DmStatusDTO {
  return {
    backend: 'v5',
    locked: false,
    ready: true,
    unreadTotal: 0,
    unreadConversations: 0,
    capReached: false,
    retention: 'never',
    blocked: [],
    recovery: null,
    error: null,
    ...overrides,
  };
}

const page = (items: MessageDTO[]): Page<MessageDTO> => ({ items, cursor: null, hasMore: false });

function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack />
    </QueryClientProvider>
  );
}

let rendered: ReturnType<typeof renderRouter> | null = null;
/** Where the router is now. */
const pathname = () => rendered?.getPathname();

async function renderAt(initialUrl: string) {
  rendered = renderRouter(
    {
      _layout: Layout,
      'messages/index': InboxScreen,
      'messages/new': NewMessageScreen,
      'messages/new-group': NewGroupScreen,
      'settings/messages': MessageSettingsScreen,
      'messages/[conversationId]/index': ConversationScreen,
      'messages/[conversationId]/info': GroupInfoScreen,
      'block/[userId]': () => null,
    },
    { initialUrl },
  );
  await act(async () => {});
}

const nativeCapture = jest.requireMock<{ isCaptureBlocked: () => boolean }>('../../../modules/secure-window');
async function onAndroid(run: () => Promise<void>) {
  const os = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }
}

const signIn = () => useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: { dm: 'v5' } as never } });
  queryClient.clear();
  resetWriteTracking();
  resetBlockDecisions();
  useOutbox.setState({ entries: [] });
  resetKeyResends();
  useDrafts.getState().clearAll();
  // Drafts are saved on the device too (drafts.ts): one test's must not show up in the next.
  forgetDmDrafts(VIEWER);
  useToastStore.setState({ current: null });
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
  fakeEngine.method('dm.open').mockResolvedValue(undefined);
  fakeEngine.method('dm.markRead').mockResolvedValue(undefined);
  fakeEngine.method('profiles.batch').mockResolvedValue([]);
});

describe('Messages inbox (DM-01, DM-02)', () => {
  it('keeps the inbox out of Android Recents and screenshots while it is open', async () => {
    await onAndroid(async () => {
      signIn();
      fakeEngine.method('dm.status').mockResolvedValue(status());
      fakeEngine.method('dm.conversations').mockResolvedValue([]);
      await renderAt('/messages');
      expect(nativeCapture.isCaptureBlocked()).toBe(true);
      rendered?.unmount();
      rendered = null;
      expect(nativeCapture.isCaptureBlocked()).toBe(false);
    });
  });

  it('signed out, invites the user to sign in and reads nothing', async () => {
    await renderAt('/messages');
    expect(screen.getByText('Sign in to read your messages')).toBeTruthy();
    expect(fakeEngine.method('dm.status')).not.toHaveBeenCalled();
  });

  it('locked, offers the unlock sheet, which falls back to pasting the key (#22)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true }));
    fakeEngine.method('dm.unlock').mockResolvedValueOnce({ unlocked: false, reason: 'not-derivable' });
    await renderAt('/messages');
    expect(screen.getByText('Unlock your messages')).toBeTruthy();
    expect(fakeEngine.method('dm.conversations')).not.toHaveBeenCalled();
    // The inbox itself is Android-only private; on iOS only the key sheet blocks screenshots.
    expect(nativeCapture.isCaptureBlocked()).toBe(false);

    fireEvent.press(screen.getByText('Unlock messages'));
    await act(async () => {});
    expect(fakeEngine.method('dm.unlock')).toHaveBeenCalledWith({});
    expect(nativeCapture.isCaptureBlocked()).toBe(true);
    // One plain field: no key formats until a paste is not a key.
    expect(screen.getByTestId('dm-unlock-key').props.placeholder).toBe('Paste your encryption key');
    expect(screen.queryByText(/WIF|hex/)).toBeNull();

    fakeEngine.method('dm.unlock').mockResolvedValueOnce({ unlocked: true, status: status() });
    fireEvent.changeText(screen.getByTestId('dm-unlock-key'), 'cWIFkey');
    fireEvent.press(screen.getByTestId('dm-unlock-save'));
    await act(async () => {});
    expect(fakeEngine.method('dm.unlock')).toHaveBeenLastCalledWith({ key: 'cWIFkey' });
    expect(useToastStore.getState().current?.message).toBe('Messages unlocked');
  });

  it('unlocks by itself when the key can be recovered: no "Key Recovered!" step (#22)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true }));
    let answer: (result: { unlocked: true; status: DmStatusDTO }) => void = () => undefined;
    fakeEngine.method('dm.unlock').mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await renderAt('/messages');
    fireEvent.press(screen.getByText('Unlock messages'));
    await act(async () => {});
    expect(screen.getByText('Unlocking your messages…')).toBeTruthy();
    expect(screen.queryByText(/Recover/i)).toBeNull();

    await act(async () => answer({ unlocked: true, status: status() }));
    expect(useToastStore.getState().current?.message).toBe('Messages unlocked');
    expect(screen.queryByTestId('dm-unlock-key')).toBeNull();
  });

  it('explains the key formats only for text that is not a key (#22)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true }));
    fakeEngine.method('dm.unlock').mockResolvedValueOnce({ unlocked: false, reason: 'not-derivable' });
    await renderAt('/messages');
    fireEvent.press(screen.getByText('Unlock messages'));
    await act(async () => {});
    fakeEngine.method('dm.unlock').mockRejectedValueOnce(Object.assign(new Error('Invalid key'), { code: 'KEY_INVALID' }));
    fireEvent.changeText(screen.getByTestId('dm-unlock-key'), 'nope');
    fireEvent.press(screen.getByTestId('dm-unlock-save'));
    await act(async () => {});
    expect(screen.getByTestId('dm-unlock-error')).toHaveTextContent(
      "That doesn't look like an encryption key. It's a WIF or 64-character hex key from yap.pr.",
    );

    // A key, but not this account's.
    fakeEngine.method('dm.unlock').mockRejectedValueOnce(Object.assign(new Error('Invalid key'), { code: 'KEY_INVALID' }));
    fireEvent.changeText(screen.getByTestId('dm-unlock-key'), 'ab'.repeat(32));
    fireEvent.press(screen.getByTestId('dm-unlock-save'));
    await act(async () => {});
    expect(screen.getByTestId('dm-unlock-error')).toHaveTextContent("That isn't the encryption key for this account's messages.");
  });

  it('lists conversations with previews, filters by search, and keeps archived ones behind the footer (#18)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ unreadConversations: 1 }));
    fakeEngine.method('dm.conversations').mockResolvedValue([
      conversation({ unread: 2 }),
      conversation({
        key: 'g:builders',
        kind: 'group',
        peer: null,
        name: 'Builders',
        members: [VIEWER, BOB_ID],
        lastMessage: { text: 'shipped it', at: new Date('2026-09-30T09:00:00Z'), own: true },
        lastActivity: new Date('2026-09-30T09:00:00Z'),
      }),
      conversation({ key: 'd:hidden', peer: { ...conversation().peer!, displayName: 'Old Chat' }, flags: { ...FLAGS, hidden: true } }),
    ]);
    await renderAt('/messages');

    expect(screen.getByText('Bob Builder')).toBeTruthy();
    expect(screen.getByText('You: shipped it')).toBeTruthy();
    expect(screen.queryByText('Old Chat')).toBeNull();

    fireEvent.press(screen.getByText('Archived (1)'));
    expect(screen.getByText('Old Chat')).toBeTruthy();
    expect(screen.getByText('Hide archived')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('messages-search'), 'build');
    expect(screen.getByText('Builders')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('messages-search'), 'zzz');
    expect(screen.getByText('No conversations match your search')).toBeTruthy();
  });

  it('shows the welcome state when there are no conversations', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    await renderAt('/messages');
    expect(screen.getByText('Welcome to Messages')).toBeTruthy();
    expect(screen.getByText('New message')).toBeTruthy();
  });

  // D-L4i-004: a placeholder swapped for the list later left the iOS large title fixed over the rows.
  it('keeps one list, first in the screen, from signed out through locked to the inbox (UX_SPEC §3.4)', async () => {
    await renderAt('/messages');
    const list = largeTitleScrollView(screen.UNSAFE_root);
    expect(list?.props.testID).toBe('messages-placeholder');
    expect(screen.getByTestId('messages-signed-out')).toBeTruthy();

    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true }));
    await act(async () => signIn());
    expect(screen.getByTestId('messages-locked')).toBeTruthy();
    expect(largeTitleScrollView(screen.UNSAFE_root)).toBe(list);

    fakeEngine.method('dm.conversations').mockResolvedValue([conversation()]);
    await act(async () => {
      queryClient.setQueryData(queryKeys.dm.status, status());
    });
    expect(screen.getByText('Bob Builder')).toBeTruthy();
    expect(largeTitleScrollView(screen.UNSAFE_root)).toBe(list);
    expect(list?.props.testID).toBe('messages-list');
  });

  it('while the engine has not loaded the messages yet, shows the skeleton, never the welcome or a failed check (QA D-L4a-001)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ ready: false }));
    fakeEngine.method('dm.conversations').mockRejectedValue(busy());
    await renderAt('/messages');
    expect(screen.getByTestId('messages-loading')).toBeTruthy();
    expect(screen.queryByText('Welcome to Messages')).toBeNull();
    expect(screen.queryByTestId('messages-poll-error')).toBeNull();
  });

  it('never welcomes a first visit to an empty list from a status that is not ready', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ ready: false }));
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    await renderAt('/messages');
    expect(screen.getByTestId('messages-loading')).toBeTruthy();
    expect(screen.queryByText('Welcome to Messages')).toBeNull();
  });

  it('shows "Connecting to Dash Platform…" under the skeleton while the engine boots (G-2)', async () => {
    fakeEngine.setStatus({ state: 'handshaking' });
    signIn();
    fakeEngine.method('dm.status').mockReturnValue(new Promise(() => undefined));
    await renderAt('/messages');
    expect(screen.getByTestId('messages-loading')).toBeTruthy();
    expect(screen.getByText('Connecting to Dash Platform…')).toBeTruthy();
  });

  it('when the first check failed, says so with Try again, which checks again (QA D-L4i-002)', async () => {
    signIn();
    const failed = 'Request timeout after 8000ms';
    fakeEngine.method('dm.status').mockResolvedValue(status({ ready: false, error: failed }));
    fakeEngine.method('dm.conversations').mockRejectedValue(Object.assign(new Error(failed), { code: 'TIMEOUT' }));
    fakeEngine.method('dm.refresh').mockResolvedValue(undefined);
    await renderAt('/messages');
    // One retry a second later (renderRouter runs Jest's fake timers).
    await act(async () => {
      jest.advanceTimersByTime(1100);
    });
    expect(screen.getByTestId('messages-error')).toBeTruthy();
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText('Welcome to Messages')).toBeNull();
    expect(screen.queryByTestId('messages-poll-error')).toBeNull();

    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation()]);
    fireEvent.press(screen.getByText('Try again'));
    await act(async () => {});
    expect(fakeEngine.method('dm.refresh')).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Bob Builder')).toBeTruthy();
  });

  it('when every conversation is archived, says so instead of welcoming a first visit (SR-41)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: 'd:gone', flags: { ...FLAGS, hidden: true } })]);
    await renderAt('/messages');
    expect(screen.queryByText('Welcome to Messages')).toBeNull();
    expect(screen.getByTestId('messages-all-archived')).toHaveTextContent('No conversations yet');
    expect(screen.getByText('Archived (1)')).toBeTruthy();
    expect(screen.queryByText(/comes? back/)).toBeNull();
  });

  it('archives at once with Undo, and saves it only once Undo has passed (#18)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation()]);
    fakeEngine.method('dm.hide').mockResolvedValue(undefined);
    await renderAt('/messages');
    expect(screen.getByText('Bob Builder')).toBeTruthy();

    act(() => archiveConversation(conversation()));
    expect(screen.queryByText('Bob Builder')).toBeNull();
    expect(screen.getByText('Archived (1)')).toBeTruthy();
    const archived = useToastStore.getState().current;
    expect(archived?.message).toBe('Conversation archived');
    expect(archived?.action?.label).toBe('Undo');
    // Undo puts it back, and nothing is saved.
    act(() => archived?.action?.onPress());
    expect(screen.getByText('Bob Builder')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(ARCHIVE_UNDO_MS + 100);
    });
    expect(fakeEngine.method('dm.hide')).not.toHaveBeenCalled();

    // Without Undo it is saved once the toast has gone.
    act(() => archiveConversation(conversation()));
    await act(async () => {
      jest.advanceTimersByTime(ARCHIVE_UNDO_MS - 100);
    });
    expect(fakeEngine.method('dm.hide')).not.toHaveBeenCalled();
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ flags: { ...FLAGS, hidden: true } })]);
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(fakeEngine.method('dm.hide')).toHaveBeenCalledWith(conversation().key);
    expect(screen.queryByText('Bob Builder')).toBeNull();
    expect(screen.getByText('Archived (1)')).toBeTruthy();
  });
});

describe('Messages badge (DM-13)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('counts conversations with unread messages and follows dm.changed', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ unreadConversations: 2 }));
    const { result } = renderHook(() => useMessagesBadge(), { wrapper });
    await act(async () => {});
    expect(result.current).toBe(2);
    await act(async () => {
      fakeEngine.emit('dm.changed', { unreadTotal: 5, unreadConversations: 3, changedKeys: [], ready: true, error: null });
    });
    expect(result.current).toBe(3);
  });

  it('forgets drafts and local sends when the account signs out', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    useDrafts.getState().set(VIEWER, 'k', 'half-typed secret');
    const { result, rerender } = renderHook(() => ({ badge: useMessagesBadge(), draft: useDraft(VIEWER, 'k') }), { wrapper });
    await act(async () => {});
    expect(result.current.draft).toBe('half-typed secret');
    useOutbox.setState({
      entries: [
        {
          id: 'local:1',
          identityId: VIEWER,
          key: 'k',
          text: 'unsent secret',
          createdAt: Date.now(),
          before: [],
          after: 0,
          ticketId: null,
          state: 'failed',
          retryable: false,
        },
      ],
    });
    act(() => useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] }));
    rerender({});
    await act(async () => {});
    expect(result.current.draft).toBe('');
    expect(useOutbox.getState().entries).toEqual([]);
  });

  it('is hidden signed out and while locked', async () => {
    const { result, rerender } = renderHook(() => useMessagesBadge(), { wrapper });
    expect(result.current).toBe(0);
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true, unreadConversations: 4 }));
    rerender({});
    await act(async () => {});
    expect(result.current).toBe(0);
  });
});

describe('Conversation (DM-03, DM-04)', () => {
  const KEY = 'd:alice-bob';
  const theirs = dmMessage('m1', { text: 'hey, coming?', at: new Date(Date.now() - 60_000) });

  async function openConversation(messages: MessageDTO[] = [theirs], row: Partial<ConversationDTO> = {}) {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, ...row })]);
    fakeEngine.method('dm.messages').mockResolvedValue(page(messages));
    await renderAt(`/messages/${encodeURIComponent(KEY)}`);
  }

  it('shows the messages, opens the conversation for fast polling and marks it read', async () => {
    await openConversation([theirs], { unread: 1 });
    expect(screen.getByText('hey, coming?')).toBeTruthy();
    expect(fakeEngine.method('dm.open')).toHaveBeenCalledWith(KEY);
    expect(fakeEngine.method('dm.markRead')).toHaveBeenCalledWith(KEY);
  });

  it('marks messages that arrive in the background read only once the app is back (SR-19)', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    // Swapped, not spied: jest-expo's AppState is a mock whose restore would drop its implementation.
    const original = AppState.addEventListener;
    AppState.addEventListener = ((_type: string, listener: (state: AppStateStatus) => void) => {
      listeners.push(listener);
      return { remove: () => undefined };
    }) as unknown as typeof AppState.addEventListener;
    try {
      await openConversation();
      await act(async () => listeners.forEach((listener) => listener('background')));
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, unread: 1 })]);
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations });
      });
      expect(fakeEngine.method('dm.markRead')).not.toHaveBeenCalled();
      await act(async () => listeners.forEach((listener) => listener('active')));
      expect(fakeEngine.method('dm.markRead')).toHaveBeenCalledWith(KEY);
      rendered?.unmount();
      rendered = null;
    } finally {
      AppState.addEventListener = original;
    }
  });

  it("follows the user's own scrolls, to keep the newest in view while they read there (QA dm-thread-stale-after-cold-launch)", async () => {
    await openConversation();
    const list = screen.getByTestId('dm-messages');
    expect(list.props.onScrollBeginDrag).toEqual(expect.any(Function));
    expect(list.props.onScrollEndDrag).toEqual(expect.any(Function));
    expect(list.props.onMomentumScrollEnd).toEqual(expect.any(Function));
  });

  it('keeps the conversation out of Android Recents and screenshots while it is open', async () => {
    await onAndroid(async () => {
      await openConversation();
      expect(nativeCapture.isCaptureBlocked()).toBe(true);
      rendered?.unmount();
      rendered = null;
      expect(nativeCapture.isCaptureBlocked()).toBe(false);
    });
  });

  it('leaves the message text to the input while typing, and clears it once sent (QA rc7 D-2)', async () => {
    // A `value` composer pushed each keystroke's text back from the draft store, and under load
    // that echo dropped the keys typed meanwhile.
    await openConversation();
    const sent = ticket({ op: 'dm.send', target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(sent);
    const composer = () => screen.getByTestId('dm-composer');
    fireEvent(composer(), 'focus');
    for (const text of ['s', 'se', 'see', 'see ', 'see y', 'see yo', 'see you']) fireEvent.changeText(composer(), text);
    expect(composer().props.value).toBeUndefined();
    expect(composer().props.defaultValue).toBe('');
    expect(screen.getByTestId('dm-send')).toBeEnabled();

    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    expect(fakeEngine.method('dm.send')).toHaveBeenCalledWith(KEY, 'see you');
    // A send empties the box with a fresh input, which takes the focus (QA rc9 c2).
    expect(composer()).toHaveDisplayValue('');
    expect(composer().props.autoFocus).toBe(true);
    // The next message's typing is the input's own again: nothing is put in over it.
    fireEvent.changeText(composer(), 'and');
    expect(composer()).toHaveDisplayValue('and');
    expect(composer().props.defaultValue).toBe('');
    expect(screen.getByTestId('dm-send')).toBeEnabled();
  });

  describe('typing right after Send (QA rc9 c2)', () => {
    /** The conversation's draft as the store holds it ('' when none). */
    const draftNow = () => Object.values(useDrafts.getState().byKey).join('|');
    const composer = () => screen.getByTestId('dm-composer');
    async function typeHello() {
      await openConversation();
      fakeEngine.method('dm.send').mockResolvedValue(ticket({ op: 'dm.send', target: { conversationKey: KEY } }));
      fireEvent(composer(), 'focus');
      fireEvent.changeText(composer(), 'hello');
    }
    const sentTexts = () => fakeEngine.method('dm.send').mock.calls.map((call) => call[1]);
    /** The change handler of the input in the box now, to deliver its events late. */
    const changeHandlerNow = (): ((text: string) => void) => composer().props.onChangeText;

    it('never brings the sent text back with a keystroke the old field reports late', async () => {
      // The field still held "hello" when "x" went in (Android dropped the clear: its event count was
      // behind the keystroke), and reported "hellox" after the send.
      await typeHello();
      const sentField = composer();
      const lateChange = changeHandlerNow();
      fireEvent.press(screen.getByTestId('dm-send'));
      act(() => lateChange('hellox'));
      await act(async () => {});
      expect(composer()).not.toBe(sentField);
      expect(composer()).toHaveDisplayValue('');
      expect(draftNow()).toBe('');
      // The fresh box keeps the keyboard, and takes what is typed next.
      expect(composer().props.autoFocus).toBe(true);
      fireEvent.changeText(composer(), 'y');
      fireEvent.press(screen.getByTestId('dm-send'));
      await act(async () => {});
      expect(sentTexts()).toEqual(['hello', 'y']);
    });

    it('does the same when the late report reaches the app before the emptied draft renders', async () => {
      await typeHello();
      const lateChange = changeHandlerNow();
      await act(async () => {
        fireEvent.press(screen.getByTestId('dm-send'));
        lateChange('hellox');
      });
      expect(composer()).toHaveDisplayValue('');
      expect(draftNow()).toBe('');
      expect(sentTexts()).toEqual(['hello']);
    });

    it('keeps the old input, hidden, until the fresh one has the focus, so the keyboard stays up (QA rc11 c3)', async () => {
      await typeHello();
      const live = composer();
      const liveProps = { style: live.props.style, editable: live.props.editable, multiline: live.props.multiline };
      fireEvent.press(screen.getByTestId('dm-send'));
      await act(async () => {});
      // Both mounted: the fresh box, taking the focus, and the one that held "hello", out of sight.
      const retiring = screen.getByTestId('dm-composer-retiring', { includeHiddenElements: true });
      // The same input (never a new native view), and nothing on it that would make iOS resign it
      // (QA rc12 c1): no pointerEvents, no change to its style or editability. Its slot hides it.
      expect(retiring).toBe(live);
      expect(retiring.props.pointerEvents).toBeUndefined();
      expect({ style: retiring.props.style, editable: retiring.props.editable, multiline: retiring.props.multiline }).toEqual(liveProps);
      const slot = hostViewAbove(retiring);
      expect(slot?.props.collapsable).toBe(false);
      expect(slot?.props.accessibilityElementsHidden).toBe(true);
      expect(StyleSheet.flatten(slot?.props.style)).toMatchObject({ position: 'absolute', height: 0, overflow: 'hidden', opacity: 0 });
      expect(composer().props.autoFocus).toBe(true);
      expect(composer()).toHaveDisplayValue('');
      // Its late events, and its blur as the focus moves, change nothing.
      fireEvent.changeText(retiring, 'hellox');
      fireEvent(retiring, 'blur');
      expect(draftNow()).toBe('');
      // The fresh box has the focus: only now does the old one go.
      fireEvent(composer(), 'focus');
      expect(screen.queryByTestId('dm-composer-retiring', { includeHiddenElements: true })).toBeNull();
      fireEvent.changeText(composer(), 'y');
      expect(draftNow()).toBe('y');
    });

    it('lets the old input go anyway if the fresh one never says it has the focus', async () => {
      await typeHello();
      fireEvent.press(screen.getByTestId('dm-send'));
      expect(screen.getByTestId('dm-composer-retiring', { includeHiddenElements: true })).toBeTruthy();
      act(() => {
        jest.advanceTimersByTime(RETIRE_MS);
      });
      expect(screen.queryByTestId('dm-composer-retiring', { includeHiddenElements: true })).toBeNull();
    });

    it('swaps straight away when the box did not have the focus', async () => {
      await openConversation();
      fakeEngine.method('dm.send').mockResolvedValue(ticket({ op: 'dm.send', target: { conversationKey: KEY } }));
      fireEvent.changeText(composer(), 'hello');
      fireEvent.press(screen.getByTestId('dm-send'));
      expect(screen.queryByTestId('dm-composer-retiring', { includeHiddenElements: true })).toBeNull();
      expect(composer()).toHaveDisplayValue('');
    });

    it('grows the box a line at a time up to 5 lines on iOS, then back to one after Send (QA rc13 c6)', async () => {
      // iOS sizes an uncontrolled input that mounted empty by its empty text: the height comes from a mirror.
      await typeHello();
      const style = () => StyleSheet.flatten(composer().props.style);
      const mirror = () => screen.getByTestId('dm-composer-mirror', { includeHiddenElements: true });
      fireEvent.changeText(composer(), 'line one\nline two\nline three');
      expect(mirror().props.children).toBe('line one\nline two\nline three');
      // A line on screen: the cap is 5 of them plus the padding.
      const lineHeight = ((style().maxHeight as number) - 18) / 5;
      fireEvent(mirror(), 'layout', { nativeEvent: { layout: { height: lineHeight * 3 } } });
      expect(style().height).toBe(Math.ceil(lineHeight * 3) + 18);
      // Past 5 lines it stays at its maximum, and scrolls.
      fireEvent(mirror(), 'layout', { nativeEvent: { layout: { height: lineHeight * 9 } } });
      expect(style().height).toBe(style().maxHeight);

      fireEvent.press(screen.getByTestId('dm-send'));
      await act(async () => {});
      expect(mirror().props.children).toBe('\u200b');
      fireEvent(mirror(), 'layout', { nativeEvent: { layout: { height: lineHeight } } });
      // One line (40 at the default text size).
      expect(style().height).toBe(style().minHeight);
    });

    it.each([1, 1.12])('caps the box at exactly 5 full lines at font scale %s (QA rc14 c3)', (fontScale) => {
      const dimensions = jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
      try {
        render(<Composer value="" onChangeText={jest.fn()} onSend={() => false} />);
        const style = () => StyleSheet.flatten(composer().props.style);
        const mirror = screen.getByTestId('dm-composer-mirror', { includeHiddenElements: true });
        // Given unscaled, as the text's own size is: on screen a line is 22 × the font scale.
        expect(style().lineHeight).toBe(22);
        expect(StyleSheet.flatten(mirror.props.style).lineHeight).toBe(22);
        const line = 22 * fontScale;
        expect(style().minHeight).toBe(Math.max(40, line + 18));
        expect(style().maxHeight).toBe(line * 5 + 18);
        fireEvent(mirror, 'layout', { nativeEvent: { layout: { height: line * 5 } } });
        // Five lines laid out: the full height of five, within the cap.
        expect(style().height).toBe(Math.min(line * 5 + 18, Math.ceil(line * 5) + 18));
      } finally {
        dimensions.mockRestore();
      }
    });

    it('grows the box by its own laid-out text on Android, capped at 5 of its drawn lines (QA rc16 A-08)', async () => {
      await onAndroid(async () => {
        await typeHello();
        const style = () => StyleSheet.flatten(composer().props.style);
        const lines = () => screen.getByTestId('dm-composer-lines', { includeHiddenElements: true });
        const contentSize = (height: number) =>
          fireEvent(composer(), 'contentSizeChange', { nativeEvent: { contentSize: { width: 300, height } } });
        expect(screen.queryByTestId('dm-composer-mirror', { includeHiddenElements: true })).toBeNull();
        // Android draws typed text at the font's own spacing: the box is given no line height, and
        // its cap is 5 of those lines, measured.
        expect(style().lineHeight).toBeUndefined();
        expect(StyleSheet.flatten(lines().props.style)).toMatchObject({ fontSize: 16, opacity: 0 });
        expect(StyleSheet.flatten(lines().props.style).lineHeight).toBeUndefined();
        expect(lines().props.children).toBe('\u200b\n\u200b\n\u200b\n\u200b\n\u200b');
        expect(style().height).toBeUndefined();
        fireEvent(lines(), 'layout', { nativeEvent: { layout: { height: 18.75 * 5 } } });
        expect(style().maxHeight).toBe(94 + 18);
        expect(style().minHeight).toBe(40);

        // The field's text layout and padding, as it reports them.
        contentSize(18.75 * 3 + 18);
        expect(style().height).toBe(75);
        contentSize(18.75 * 9 + 18);
        expect(style().height).toBe(style().maxHeight);

        // A larger text size: the field keeps the height its text has, under the new cap once
        // the lines are measured again, instead of the one empty line Fabric measures until the
        // next keystroke.
        const initial = Dimensions.get('window').fontScale;
        const setFontScale = (fontScale: number) =>
          act(() =>
            Dimensions.set({
              window: { ...Dimensions.get('window'), fontScale },
              screen: { ...Dimensions.get('screen'), fontScale },
            }),
          );
        setFontScale(1.3);
        try {
          expect(style().height).toBe(112);
          fireEvent(lines(), 'layout', { nativeEvent: { layout: { height: 24.4 * 5 } } });
          expect(style().maxHeight).toBe(122 + 18);
          contentSize(24.4 * 9 + 18);
          expect(style().height).toBe(140);
        } finally {
          setFontScale(initial);
        }
        fireEvent(lines(), 'layout', { nativeEvent: { layout: { height: 18.75 * 5 } } });

        // The fresh box after Send is sized by its own report, not the sent text's: not even by a
        // late one from the box it replaced.
        fireEvent.press(screen.getByTestId('dm-send'));
        await act(async () => {});
        expect(style().height).toBeUndefined();
        fireEvent(screen.getByTestId('dm-composer-retiring', { includeHiddenElements: true }), 'contentSizeChange', {
          nativeEvent: { contentSize: { width: 300, height: 18.75 * 2 + 18 } },
        });
        expect(style().height).toBeUndefined();
        contentSize(18.75 + 18);
        expect(style().height).toBe(40);
      });
    });

    /** Send "hello" with the engine's answer held back; returns the refusal to deliver later. */
    async function sendHeldBack() {
      await openConversation();
      let refuse: (error: Error) => void = () => undefined;
      fakeEngine.method('dm.send').mockImplementationOnce(() => new Promise<WriteTicket>((_, reject) => (refuse = reject)));
      fireEvent(composer(), 'focus');
      fireEvent.changeText(composer(), 'hello');
      fireEvent.press(screen.getByTestId('dm-send'));
      await act(async () => {});
      return () => refuse(Object.assign(new Error('Unblock this person to message them.'), { code: 'BAD_REQUEST' }));
    }

    it('shows a failed message put back in the box, though the box last held that text (QA rc7 review)', async () => {
      // "hello" pasted and deleted in the fresh box before the screen re-rendered: a late render of
      // it is an echo, but the message put back is not.
      const refuse = await sendHeldBack();
      fireEvent(composer(), 'focus');
      act(() => {
        fireEvent.changeText(composer(), 'hello');
        fireEvent.changeText(composer(), '');
      });
      expect(draftNow()).toBe('');
      await act(async () => refuse());
      expect(draftNow()).toBe('hello');
      expect(composer()).toHaveDisplayValue('hello');
      fireEvent.changeText(composer(), 'hello!');
      expect(draftNow()).toBe('hello!');
    });

    it('hands the keyboard on to the message put back when Send fails before the fresh box has the focus', async () => {
      const refuse = await sendHeldBack();
      // The box that held "hello" still has the keyboard; the fresh one has not said it took it.
      const holding = screen.getByTestId('dm-composer-retiring', { includeHiddenElements: true });
      await act(async () => refuse());
      expect(composer()).toHaveDisplayValue('hello');
      expect(composer().props.autoFocus).toBe(true);
      // The input holding the keyboard stays until the box with the message takes it.
      expect(screen.getByTestId('dm-composer-retiring', { includeHiddenElements: true })).toBe(holding);
      fireEvent(composer(), 'focus');
      expect(screen.queryByTestId('dm-composer-retiring', { includeHiddenElements: true })).toBeNull();
    });

    it('keeps a paste right after Send whole, even one that starts with the message sent', async () => {
      // One change event for the whole paste (or an IME's whole-text insert): nothing is taken off it.
      await typeHello();
      fireEvent.press(screen.getByTestId('dm-send'));
      fireEvent.changeText(composer(), 'hello again');
      expect(composer()).toHaveDisplayValue('hello again');
      expect(draftNow()).toBe('hello again');
      fireEvent.press(screen.getByTestId('dm-send'));
      await act(async () => {});
      expect(sentTexts()).toEqual(['hello', 'hello again']);
    });

    it('keeps a message typed afresh that starts like the one sent', async () => {
      await typeHello();
      fireEvent.press(screen.getByTestId('dm-send'));
      await act(async () => {});
      for (const text of ['h', 'he', 'hel', 'hell', 'hello', 'hello ', 'hello again']) fireEvent.changeText(composer(), text);
      expect(draftNow()).toBe('hello again');
      expect(composer()).toHaveDisplayValue('hello again');
    });

    it('keeps a failed message put back in the box, and what is typed after it', async () => {
      await openConversation();
      fakeEngine
        .method('dm.send')
        .mockRejectedValue(Object.assign(new Error('Unblock this person to message them.'), { code: 'BAD_REQUEST' }));
      fireEvent.changeText(composer(), 'hello?');
      fireEvent.press(screen.getByTestId('dm-send'));
      await act(async () => {});
      expect(composer()).toHaveDisplayValue('hello?');
      fireEvent.changeText(composer(), 'hello?!');
      expect(draftNow()).toBe('hello?!');
      expect(composer()).toHaveDisplayValue('hello?!');
    });
  });

  it('sends: a "Sending…" bubble at once, then the engine’s own message with "Sent"', async () => {
    await openConversation();
    const sent = ticket({ op: 'dm.send', target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(sent);

    fireEvent.changeText(screen.getByTestId('dm-composer'), 'on my way');
    fireEvent.press(screen.getByTestId('dm-send'));
    expect(screen.getByText('on my way')).toBeTruthy();
    expect(screen.getByText('Sending…')).toBeTruthy();
    await act(async () => {});
    expect(fakeEngine.method('dm.send')).toHaveBeenCalledWith(KEY, 'on my way');
    expect(screen.getByTestId('dm-composer')).toHaveDisplayValue('');

    // Confirmed: the engine now holds the message; it shows once, with "Sent".
    fakeEngine
      .method('dm.messages')
      .mockResolvedValue(page([dmMessage('m2', { text: 'on my way', own: true, sender: VIEWER, at: new Date() }), theirs]));
    await act(async () => {
      fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(screen.getAllByText('on my way')).toHaveLength(1);
    expect(screen.getByText('Sent')).toBeTruthy();
  });

  it('keeps a failed send on screen and retries it on tap', async () => {
    await openConversation();
    const sent = ticket({ op: 'dm.send', target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(sent);
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'are you there?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    await act(async () => {
      fakeEngine.emit(
        'write.status',
        advance(sent, {
          state: 'failed',
          retryable: true,
          error: { code: 'NETWORK', userMessage: 'Network error.' } as never,
        }),
      );
    });
    expect(screen.getByText('Not delivered · Tap to retry')).toBeTruthy();

    // The engine reports every transition as `write.status` before it answers the call.
    fakeEngine.method('writes.retry').mockImplementation(async () => {
      const retried = advance(sent, { state: 'pending', retryable: false, updatedAt: new Date(Date.now() + 5000) });
      fakeEngine.emit('write.status', retried);
      return retried;
    });
    fireEvent.press(screen.getByText('Not delivered · Tap to retry'));
    await act(async () => {});
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(sent.id);
    expect(screen.getByText('Sending…')).toBeTruthy();
  });

  it('a send whose call hangs stays "Sending…" while the app checks it, never Retry, then "Sent" once it answers (QA D-L4a-002)', async () => {
    await openConversation();
    const sent = ticket({ op: 'dm.send', identityId: VIEWER, target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(sent);
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'through a stall');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    expect(screen.getByText('Sending…')).toBeTruthy();

    // Dash Platform stalls: a minute without an answer, and the engine's deadline says so.
    const stalled = advance(sent, {
      state: 'unconfirmed',
      stage: null,
      error: { code: 'STILL_SENDING', outcome: 'unknown', retryable: false } as never,
    });
    await act(async () => {
      fakeEngine.emit('write.status', stalled);
    });
    fakeEngine.method('writes.check').mockResolvedValue(advance(stalled, { lastCheckedAt: new Date() }));
    // Still "Sending…": the app checks it by itself, and while its call runs the checks never run out.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(sent.id);
    expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
    expect(screen.getByText('Sending…')).toBeTruthy();
    expect(screen.queryByText('Not delivered · Tap to retry')).toBeNull();
    expect(screen.queryByText("Couldn't confirm · Tap to check")).toBeNull();
    expect(useToastStore.getState().current).toBeNull();

    // The stall clears: the call answers, and the engine's own message stands for the send.
    fakeEngine
      .method('dm.messages')
      .mockResolvedValue(page([dmMessage('m2', { text: 'through a stall', own: true, sender: VIEWER, at: new Date() }), theirs]));
    await act(async () => {
      fakeEngine.emit('write.status', advance(stalled, { state: 'confirmed', error: null, updatedAt: new Date(Date.now() + 5000) }));
    });
    await act(async () => {});
    expect(screen.getAllByText('through a stall')).toHaveLength(1);
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(fakeEngine.method('dm.send')).toHaveBeenCalledTimes(1);
  });

  it('says "Couldn\'t confirm · Tap to check" only once the checks of an unknown send ran out, and a tap checks with a spinner', async () => {
    await openConversation();
    const sent = ticket({ op: 'dm.send', identityId: VIEWER, target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(sent);
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'maybe');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    // The wait timed out after the broadcast (a DAPI 504): it may have landed.
    const unknown = advance(sent, {
      state: 'unconfirmed',
      error: { code: 'TIMEOUT', outcome: 'unknown', retryable: false } as never,
    });
    await act(async () => {
      fakeEngine.emit('write.status', unknown);
    });
    fakeEngine.method('writes.check').mockResolvedValue(advance(unknown, { lastCheckedAt: new Date() }));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(130_000 - 1);
    });
    expect(screen.getByText('Sending…')).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledTimes(4);
    expect(screen.getByText("Couldn't confirm · Tap to check")).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();

    // A tap checks again, with a spinner on the bubble meanwhile, and a second tap runs no second check.
    let answer: (t: typeof unknown) => void = () => undefined;
    fakeEngine.method('writes.check').mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    fireEvent.press(screen.getByText("Couldn't confirm · Tap to check"));
    await act(async () => {});
    expect(screen.getByTestId('dm-status-checking')).toBeTruthy();
    fireEvent.press(screen.getByText("Couldn't confirm · Tap to check"));
    await act(async () => {});
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledTimes(5);
    // Found: "Sent", and no toast.
    const confirmed = advance(unknown, { state: 'confirmed', error: null, updatedAt: new Date(Date.now() + 5000) });
    fakeEngine
      .method('dm.messages')
      .mockResolvedValue(page([dmMessage('m3', { text: 'maybe', own: true, sender: VIEWER, at: new Date() }), theirs]));
    await act(async () => {
      fakeEngine.emit('write.status', confirmed);
      answer(confirmed);
    });
    await act(async () => {});
    expect(screen.queryByTestId('dm-status-checking')).toBeNull();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();
    expect(fakeEngine.method('dm.send')).toHaveBeenCalledTimes(1);
  });

  it('puts the text back in the composer when the engine refuses the send', async () => {
    await openConversation();
    fakeEngine
      .method('dm.send')
      .mockRejectedValue(Object.assign(new Error('Unblock this person to message them.'), { code: 'BAD_REQUEST' }));
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'hello?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    expect(screen.getByTestId('dm-composer')).toHaveDisplayValue('hello?');
    expect(useToastStore.getState().current?.message).toBe('Unblock this person to message them.');
  });

  it('does not put the text back when the account signed out while the send was pending', async () => {
    signIn();
    let refuse: (error: Error) => void = () => undefined;
    fakeEngine.method('dm.send').mockReturnValue(
      new Promise((_, reject) => {
        refuse = reject;
      }),
    );
    const sending = sendMessage(VIEWER, KEY, 'secret');
    await act(async () => {});
    clearLocalMessages();
    refuse(Object.assign(new Error('Unblock this person to message them.'), { code: 'BAD_REQUEST' }));
    await act(async () => {
      await sending;
    });
    expect(useDrafts.getState().byKey).toEqual({});
    expect(useOutbox.getState().entries).toEqual([]);
  });

  it('replaces the composer when the user blocked the peer (DM-10)', async () => {
    await openConversation([theirs], { flags: { ...FLAGS, blocked: true } });
    expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();
    expect(screen.queryByTestId('dm-composer')).toBeNull();
  });

  describe('Block and Unblock from a DM v5 conversation (DM-10, SAFE-01)', () => {
    const select = (event: string) =>
      act(async () => {
        fireEvent(screen.getByTestId('dm-conversation-menu'), 'pressAction', { nativeEvent: { event } });
      });

    it('opens the same Block sheet as everywhere, which blocks in Messages too', async () => {
      await openConversation();
      fakeEngine.method('safety.blockedBy').mockResolvedValue({ [BOB_ID]: null });
      await select('block');
      await act(async () => {});
      expect(pathname()).toBe(`/block/${BOB_ID}`);
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
    });

    it('blocks only in Messages when the account already blocks them', async () => {
      await openConversation();
      fakeEngine.method('safety.blockedBy').mockResolvedValue({ [BOB_ID]: 'self' });
      fakeEngine.method('dm.setBlocked').mockResolvedValue(true);
      await select('block');
      await act(async () => {});
      expect(pathname()).toBe(`/messages/${KEY}`);
      expect(fakeEngine.method('dm.setBlocked')).toHaveBeenCalledWith(BOB_ID, true);
      expect(fakeEngine.method('safety.block')).not.toHaveBeenCalled();
      expect(useToastStore.getState().current?.message).toBe('Blocked @bob');
    });

    it("lifts the account's own block, and Messages follow it once that is confirmed", async () => {
      await openConversation([theirs], { flags: { ...FLAGS, blocked: true } });
      fakeEngine.method('safety.blockedBy').mockResolvedValue({ [BOB_ID]: 'self' });
      const pending = ticket({ op: 'unblock', target: { identityId: BOB_ID } });
      fakeEngine.method('safety.unblock').mockResolvedValue(pending);
      fakeEngine.method('dm.setBlocked').mockResolvedValue(undefined);
      await select('unblock');
      await act(async () => {});
      expect(fakeEngine.method('safety.unblock')).toHaveBeenCalledWith(BOB_ID);
      // On its way: still blocked here, "Unblocking…", and nothing said yet (RC16-A-02).
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
      expect(useToastStore.getState().current).toBeNull();
      expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();
      const actions = () => screen.getByTestId('dm-conversation-menu').props.actions as { title: string }[];
      expect(actions().map((a) => a.title)).toContain('Unblocking…');

      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
      await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      // The engine lifts the block in Messages itself; the app only reads them again.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.dm.status });
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
      expect(useToastStore.getState().current?.message).toBe('Unblocked @bob');
      invalidate.mockRestore();
    });

    it('shows the banner from the same block as the profile, and takes it away when the block fails (RC16-A-02)', async () => {
      await openConversation([theirs]);
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();
      const pending = ticket({ op: 'block', target: { identityId: BOB_ID } });
      fakeEngine.method('safety.block').mockResolvedValue(pending);
      // Blocked from the profile: the conversation says so at once, though Messages save nothing yet.
      await act(async () => {
        await runWrite(blockWrite, { viewerId: VIEWER, userId: BOB_ID, block: true, handle: '@bob' });
      });
      expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();

      await act(async () =>
        fakeEngine.emit(
          'write.status',
          advance(pending, {
            state: 'failed',
            error: { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: '' },
          }),
        ),
      );
      // Failed: no banner, the composer is back, and nothing was ever saved in Messages to outlive it.
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();
      expect(screen.getByTestId('dm-composer')).toBeTruthy();
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
    });

    it('drops a banner Messages show for a block this device has since lifted', async () => {
      await openConversation([theirs], { flags: { ...FLAGS, blocked: true } });
      const pending = ticket({ op: 'unblock', target: { identityId: BOB_ID } });
      fakeEngine.method('safety.unblock').mockResolvedValue(pending);
      fakeEngine.method('dm.setBlocked').mockResolvedValue(true);
      await act(async () => {
        await runWrite(blockWrite, { viewerId: VIEWER, userId: BOB_ID, block: false, handle: '@bob' });
      });
      // The engine lifts it in Messages as it confirms the unblock; the conversation follows the unblock at once.
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked: false } })]);
      await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();
    });

    /** Messages as another device left them, synchronized here: the inbox is read again (`dm.changed`). */
    async function synchronized(blocked: boolean) {
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked } })]);
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations });
      });
    }

    it('shows a conversation unblocked once Messages on another device lift a block the account still has', async () => {
      await openConversation([theirs]);
      const pending = ticket({ op: 'block', target: { identityId: BOB_ID } });
      fakeEngine.method('safety.block').mockResolvedValue(pending);
      await act(async () => {
        await runWrite(blockWrite, { viewerId: VIEWER, userId: BOB_ID, block: true, handle: '@bob' });
      });
      // Confirmed: the engine blocked them in Messages too, and the conversation reads so.
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked: true } })]);
      await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();

      // Message settings' Unblock on another device: Messages only, the account's block stays.
      await synchronized(false);
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();
      expect(screen.getByTestId('dm-composer')).toBeTruthy();
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
      const { result } = renderHook(() => useAuthorBlocked(BOB_ID));
      expect(result.current).toBe(true);
    });

    it('shows a conversation blocked once Messages on another device block someone the account unblocked', async () => {
      await openConversation([theirs], { flags: { ...FLAGS, blocked: true } });
      const pending = ticket({ op: 'unblock', target: { identityId: BOB_ID } });
      fakeEngine.method('safety.unblock').mockResolvedValue(pending);
      await act(async () => {
        await runWrite(blockWrite, { viewerId: VIEWER, userId: BOB_ID, block: false, handle: '@bob' });
      });
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked: false } })]);
      await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();

      // Blocked in Messages alone on another device: the account's block stays lifted.
      await synchronized(true);
      expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
      const { result } = renderHook(() => useAuthorBlocked(BOB_ID));
      expect(result.current).toBe(false);
    });

    it('keeps a confirmed block over a read of Messages begun before it, and hands over to the next read', async () => {
      // The inbox's first read is still on its way, with Messages from before the block.
      let answerStale: (rows: ConversationDTO[]) => void = () => undefined;
      signIn();
      fakeEngine.method('dm.status').mockResolvedValue(status());
      fakeEngine.method('dm.conversations').mockReturnValueOnce(
        new Promise<ConversationDTO[]>((resolve) => {
          answerStale = resolve;
        }),
      );
      fakeEngine.method('dm.messages').mockResolvedValue(page([theirs]));
      await renderAt(`/messages/${encodeURIComponent(KEY)}`);
      const pending = ticket({ op: 'block', target: { identityId: BOB_ID } });
      fakeEngine.method('safety.block').mockResolvedValue(pending);
      await act(async () => {
        await runWrite(blockWrite, { viewerId: VIEWER, userId: BOB_ID, block: true, handle: '@bob' });
      });
      // Confirmed: the engine blocked them in Messages too, so a read begun from now on says so.
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked: true } })]);
      await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      expect(fakeEngine.method('dm.conversations')).toHaveBeenCalledTimes(1);

      // The old read answers late, from before the block: the conversation keeps it, and Messages are read again.
      await act(async () => answerStale([conversation({ key: KEY, flags: { ...FLAGS, blocked: false } })]));
      await act(async () => {});
      expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();
      expect(fakeEngine.method('dm.conversations')).toHaveBeenCalledTimes(2);

      // That read began after the block: from then on Messages decide (lifted alone on another device).
      await synchronized(false);
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();
      const { result } = renderHook(() => useAuthorBlocked(BOB_ID));
      expect(result.current).toBe(true);
    });

    it('reads Messages again after a block lifted there alone, when a read begun before answers late', async () => {
      // The inbox's first read is still on its way, with Messages from before: blocked there (made on web).
      let answerStale: (rows: ConversationDTO[]) => void = () => undefined;
      signIn();
      fakeEngine.method('dm.status').mockResolvedValue(status());
      fakeEngine.method('dm.conversations').mockReturnValueOnce(
        new Promise<ConversationDTO[]>((resolve) => {
          answerStale = resolve;
        }),
      );
      fakeEngine.method('dm.messages').mockResolvedValue(page([theirs]));
      await renderAt(`/messages/${encodeURIComponent(KEY)}`);
      // Message settings' Unblock: Messages only, no account block.
      fakeEngine.method('dm.setBlocked').mockResolvedValue(true);
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked: false } })]);
      await act(async () => {
        await setBlockedInMessages(BOB_ID, false);
      });
      expect(fakeEngine.method('dm.conversations')).toHaveBeenCalledTimes(1);

      await act(async () => answerStale([conversation({ key: KEY, flags: { ...FLAGS, blocked: true } })]));
      await act(async () => {});
      expect(fakeEngine.method('dm.conversations')).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();
      expect(screen.getByTestId('dm-composer')).toBeTruthy();
    });

    it('shows a conversation unblocked once Message settings lift a block the account still has', async () => {
      await openConversation([theirs]);
      const pending = ticket({ op: 'block', target: { identityId: BOB_ID } });
      fakeEngine.method('safety.block').mockResolvedValue(pending);
      await act(async () => {
        await runWrite(blockWrite, { viewerId: VIEWER, userId: BOB_ID, block: true, handle: '@bob' });
      });
      await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      // The engine blocked them in Messages too, and the conversation reads so.
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked: true } })]);
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations });
      });
      expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();

      // Message settings' Unblock: Messages only, the account's block stays.
      fakeEngine.method('dm.setBlocked').mockResolvedValue(true);
      fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY, flags: { ...FLAGS, blocked: false } })]);
      await act(async () => {
        await setBlockedInMessages(BOB_ID, false);
      });
      expect(fakeEngine.method('dm.setBlocked')).toHaveBeenCalledWith(BOB_ID, false);
      expect(fakeEngine.method('safety.unblock')).not.toHaveBeenCalled();
      expect(screen.queryByText('You blocked this person. Unblock them to send messages.')).toBeNull();
      expect(screen.getByTestId('dm-composer')).toBeTruthy();
      // Elsewhere the account still blocks them.
      const { result } = renderHook(() => useAuthorBlocked(BOB_ID));
      expect(result.current).toBe(true);
    });

    it("changes nothing when the account's block can't be read, and says so", async () => {
      await openConversation([theirs], { flags: { ...FLAGS, blocked: true } });
      fakeEngine.method('safety.blockedBy').mockRejectedValue(new Error('unavailable'));
      await select('unblock');
      await act(async () => {});
      expect(fakeEngine.method('safety.unblock')).not.toHaveBeenCalled();
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
      expect(useToastStore.getState().current?.message).toBe("Couldn't unblock @bob. Try again.");
    });

    it('ignores a second tap while the first still reads the account block', async () => {
      await openConversation();
      let answer: (sources: Record<string, null>) => void = () => undefined;
      fakeEngine.method('safety.blockedBy').mockReturnValue(new Promise((resolve) => (answer = resolve)));
      await select('block');
      await select('block');
      await act(async () => answer({ [BOB_ID]: null }));
      expect(fakeEngine.method('safety.blockedBy')).toHaveBeenCalledTimes(1);
      expect(pathname()).toBe(`/block/${BOB_ID}`);
    });

    it('lifts only the block in Messages when there is no account block (one made on web)', async () => {
      await openConversation([theirs], { flags: { ...FLAGS, blocked: true } });
      fakeEngine.method('safety.blockedBy').mockResolvedValue({ [BOB_ID]: null });
      fakeEngine.method('dm.setBlocked').mockResolvedValue(undefined);
      await select('unblock');
      await act(async () => {});
      expect(fakeEngine.method('safety.unblock')).not.toHaveBeenCalled();
      expect(fakeEngine.method('dm.setBlocked')).toHaveBeenCalledWith(BOB_ID, false);
      expect(useToastStore.getState().current?.message).toBe('Unblocked @bob');
    });
  });

  it('on legacy, follows the account\'s block: the banner, and Unblock in the menu (SR-20)', async () => {
    fakeEngine.setStatus({ state: 'ready', info: { capabilities: { dm: 'legacy' } as never } });
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ backend: 'legacy', retention: null }));
    fakeEngine.method('settings.get').mockResolvedValue({ sendReadReceipts: false } as never);
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: 'l:C1', backend: 'legacy', flags: { ...FLAGS, blocked: true } })]);
    fakeEngine.method('dm.messages').mockResolvedValue(page([theirs]));
    await renderAt(`/messages/${encodeURIComponent('l:C1')}`);
    expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();
    const actions = screen.getByTestId('dm-conversation-menu').props.actions as { id: string; title: string }[];
    expect(actions.map((a) => a.title)).toEqual(['View profile', 'Unblock']);
  });

  it('shows an error with Retry when the status read fails, instead of loading forever', async () => {
    signIn();
    fakeEngine.method('dm.status').mockRejectedValue(Object.assign(new Error('offline'), { code: 'NETWORK' }));
    await renderAt(`/messages/${encodeURIComponent(KEY)}`);
    // renderRouter runs Jest's fake timers.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });
    }
    expect(screen.queryByTestId('dm-conversation-loading')).toBeNull();
    expect(screen.getByText('Network error. Please check your connection and try again.')).toBeTruthy();

    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY })]);
    fakeEngine.method('dm.messages').mockResolvedValue(page([theirs]));
    fireEvent.press(screen.getByText('Try again'));
    await act(async () => {});
    expect(screen.getByText('hey, coming?')).toBeTruthy();
  });

  it('sends once when Send is tapped twice before the screen re-renders', async () => {
    await openConversation();
    fakeEngine.method('dm.send').mockResolvedValue(ticket({ op: 'dm.send', target: { conversationKey: KEY } }));
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'just once');
    // The handler itself, called twice in one tick (fireEvent would re-render between taps).
    const onSend = screen.UNSAFE_getAllByProps({ testID: 'dm-send' })[0].props.onPress as () => void;
    await act(async () => {
      onSend();
      onSend();
    });
    expect(fakeEngine.method('dm.send')).toHaveBeenCalledTimes(1);
  });

  it('keeps the composer off until the first messages arrive', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: KEY })]);
    let load: (p: Page<MessageDTO>) => void = () => undefined;
    fakeEngine.method('dm.messages').mockReturnValue(
      new Promise((resolve) => {
        load = resolve;
      }),
    );
    await renderAt(`/messages/${encodeURIComponent(KEY)}`);
    expect(screen.getByTestId('dm-composer').props.editable).toBe(false);
    await act(async () => {
      load(page([theirs]));
    });
    expect(screen.getByTestId('dm-composer').props.editable).toBe(true);
  });

  it('follows the restored ticket of a send an engine restart cut short', async () => {
    await openConversation();
    fakeEngine.method('dm.send').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENGINE_RESTARTED' }));
    fakeEngine.method('writes.list').mockResolvedValue([]);
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'still there?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    // It may have gone out: "Sending…" while the app looks for it.
    expect(screen.getByText('Sending…')).toBeTruthy();
    expect(useOutbox.getState().entries[0].ticketId).toBeNull();

    // The next engine restores it; the app checks that ticket from here, by itself.
    const restored = ticket({ op: 'dm.send', identityId: VIEWER, state: 'unconfirmed', target: { conversationKey: KEY } });
    await act(async () => {
      fakeEngine.emit('write.status', restored);
    });
    expect(useOutbox.getState().entries[0].ticketId).toBe(restored.id);
    fakeEngine.method('writes.check').mockResolvedValue(restored);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(restored.id);
    expect(screen.getByText('Sending…')).toBeTruthy();
  });

  it('puts the text of a send the engine never took back in the composer, once it has no ticket for it (SR-16)', async () => {
    await openConversation();
    fakeEngine.method('dm.send').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENGINE_RESTARTED' }));
    fakeEngine.method('writes.list').mockResolvedValue([]);
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'did it go?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});

    // Just cut short: the engine may still make its ticket. The 5 s and 20 s checks find none, and wait.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    // Each check reads the engine's tickets (to adopt the send's, then to look for it).
    expect(fakeEngine.method('writes.list')).toHaveBeenCalledTimes(4);
    expect(screen.getByText('Sending…')).toBeTruthy();
    expect(screen.getByTestId('dm-composer')).toHaveDisplayValue('');
    expect(useToastStore.getState().current).toBeNull();

    // The 80 s check, still no ticket: it never went out.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId('dm-composer')).toHaveDisplayValue('did it go?');
    expect(screen.queryByText('Sending…')).toBeNull();
    expect(useToastStore.getState().current?.message).toBe("Message not sent. It's back in the message box.");
  });

  it('never takes a later send that landed for the ticket of one the engine never took', async () => {
    await openConversation();
    fakeEngine.method('dm.send').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENGINE_RESTARTED' }));
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'did it go?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});

    // A second send in the same conversation lands, and its bubble gives way to the engine's message.
    const later = ticket({ op: 'dm.send', target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(later);
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'and this');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    fakeEngine
      .method('dm.messages')
      .mockResolvedValue(page([dmMessage('m2', { text: 'and this', own: true, sender: VIEWER, at: new Date() }), theirs]));
    await act(async () => {
      fakeEngine.emit('write.status', advance(later, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(useOutbox.getState().entries.map((e) => e.text)).toEqual(['did it go?']);

    // The engine still lists the landed send's ticket; the first send has none.
    fakeEngine.method('writes.list').mockResolvedValue([advance(later, { state: 'confirmed' })]);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(130_000);
    });
    expect(screen.getByTestId('dm-composer')).toHaveDisplayValue('did it go?');
  });

  it('puts back only the parts a long send did not deliver when it fails part way (SR-18)', async () => {
    await openConversation();
    const first = 'a'.repeat(4081);
    const rest = `${'b'.repeat(4081)}${'c'.repeat(10)}`;
    const sent = ticket({ op: 'dm.send', target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(sent);
    fireEvent.changeText(screen.getByTestId('dm-composer'), `${first}${rest}`);
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    // The first part landed, then the send was refused for good.
    fakeEngine
      .method('dm.messages')
      .mockResolvedValue(page([dmMessage('p1', { text: first, own: true, sender: VIEWER, at: new Date() }), theirs]));
    await act(async () => {
      fakeEngine.emit(
        'write.status',
        advance(sent, { state: 'failed', retryable: false, error: { code: 'FEE_UNPAYABLE', userMessage: 'No credits.' } as never }),
      );
    });
    await act(async () => {});
    fireEvent.press(screen.getByText('Not delivered · Tap to edit'));
    await act(async () => {});
    expect(screen.getByTestId('dm-composer')).toHaveDisplayValue(rest);
  });

  it('offers to send only the rest of a long send whose next part never went out (SR-18)', async () => {
    await openConversation();
    const first = 'a'.repeat(4081);
    const rest = `${'b'.repeat(4081)}${'c'.repeat(10)}`;
    const sent = ticket({ op: 'dm.send', target: { conversationKey: KEY } });
    fakeEngine.method('dm.send').mockResolvedValue(sent);
    fireEvent.changeText(screen.getByTestId('dm-composer'), `${first}${rest}`);
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    // The first part landed; the connection failed before the next went out.
    fakeEngine
      .method('dm.messages')
      .mockResolvedValue(page([dmMessage('p1', { text: first, own: true, sender: VIEWER, at: new Date() }), theirs]));
    await act(async () => {
      fakeEngine.emit(
        'write.status',
        advance(sent, {
          state: 'failed',
          retryable: true,
          progress: { done: 1, total: 3 },
          error: { code: 'NETWORK', userMessage: 'Network error.' } as never,
        }),
      );
    });
    await act(async () => {});
    // What went out shows as sent; only the rest reads as not delivered.
    expect(screen.getByText(first)).toBeTruthy();
    expect(screen.getByText(rest)).toBeTruthy();
    expect(screen.queryByText(`${first}${rest}`)).toBeNull();

    fakeEngine.method('writes.retry').mockImplementation(async () => {
      const retried = advance(sent, { state: 'pending', retryable: false, updatedAt: new Date(Date.now() + 5000) });
      fakeEngine.emit('write.status', retried);
      return retried;
    });
    fireEvent.press(screen.getByText('Not delivered · Tap to retry'));
    await act(async () => {});
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(sent.id);
    expect(screen.getByTestId('dm-composer')).toHaveDisplayValue('');
  });

  it('shows the empty conversation copy', async () => {
    await openConversation([]);
    expect(screen.getByText('No messages yet. Start the conversation!')).toBeTruthy();
  });
});

describe('mergeOutbox', () => {
  const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
    id: 'local:1',
    identityId: VIEWER,
    key: 'k',
    text: 'hi',
    createdAt: Date.now(),
    before: ['old'],
    after: 1000,
    ticketId: 't1',
    state: 'sending',
    retryable: false,
    ...overrides,
  });
  const own = (id: string, text: string, at: number) => ({
    id,
    sender: VIEWER,
    text,
    at: new Date(at),
    own: true,
    pending: false,
  });

  it('lets the engine’s copy stand for a send, by the engine’s clock', () => {
    // The device clock can run ahead of the chain's: the match must not depend on it.
    const merged = mergeOutbox([own('old', 'hi', 900), own('new', 'hi', 2000)], [entry({ createdAt: 10_000_000 })]);
    expect(merged.messages.map((m) => m.id)).toEqual(['old', 'new']);
    expect(merged.sending).toBe(true);
    expect(merged.landed).toEqual([]);
  });

  it('never takes an older identical message, nor one another send claimed', () => {
    const merged = mergeOutbox(
      [own('old', 'hi', 900), own('new', 'hi', 2000)],
      [entry({ state: 'confirmed' }), entry({ id: 'local:2', state: 'failed', retryable: true })],
    );
    expect(merged.landed).toEqual([{ id: 'local:1', messageIds: ['new'] }]);
    expect(merged.messages.map((m) => [m.id, m.outbox])).toEqual([
      ['old', undefined],
      ['new', undefined],
      ['local:2', 'failed-retry'],
    ]);
  });

  it('lets a send that went out claim before an identical one that failed', () => {
    const merged = mergeOutbox(
      [own('new', 'hi', 2000)],
      [entry({ state: 'failed', retryable: true }), entry({ id: 'local:2', state: 'confirmed' })],
    );
    expect(merged.landed).toEqual([{ id: 'local:2', messageIds: ['new'] }]);
    expect(merged.messages.map((m) => [m.id, m.outbox])).toEqual([
      ['new', undefined],
      ['local:1', 'failed-retry'],
    ]);
  });

  it('keeps a landed send’s message its own on the next merge', () => {
    useOutbox.setState({
      entries: [entry({ state: 'confirmed' }), entry({ id: 'local:2', state: 'failed', retryable: true })],
    });
    const messages = [own('old', 'hi', 900), own('new', 'hi', 2000)];
    forgetLanded(mergeOutbox(messages, useOutbox.getState().entries).landed);
    expect(useOutbox.getState().entries.map((e) => e.id)).toEqual(['local:2']);

    const again = mergeOutbox(messages, useOutbox.getState().entries);
    expect(again.landed).toEqual([]);
    expect(again.messages.map((m) => [m.id, m.outbox])).toEqual([
      ['old', undefined],
      ['new', undefined],
      ['local:2', 'failed-retry'],
    ]);
  });

  it('keeps a long send that failed part way until every part is there', () => {
    const first = 'a'.repeat(4081);
    const rest = 'b'.repeat(100);
    const long = entry({ text: first + rest, state: 'failed', retryable: false });
    const partial = mergeOutbox([own('p1', first, 2000)], [long]);
    expect(partial.landed).toEqual([]);
    expect(partial.messages.map((m) => [m.id, m.outbox])).toEqual([
      ['p1', undefined],
      ['local:1', 'failed-edit'],
    ]);
    // Its bubble holds only what did not go out.
    expect(partial.messages.at(-1)?.text).toBe(rest);

    // Both parts there (in any order): the send went out after all.
    const whole = mergeOutbox([own('p2', rest, 2001), own('p1', first, 2001)], [long]);
    expect(whole.landed).toEqual([{ id: 'local:1', messageIds: ['p1', 'p2'] }]);
    expect(whole.messages.map((m) => m.id)).toEqual(['p2', 'p1']);
  });
});

describe('queryKeys.dm', () => {
  it('nests every DM query under one prefix', () => {
    expect(queryKeys.dm.messages('k').slice(0, 3)).toEqual(queryKeys.dm.all);
    expect(queryKeys.dm.people(['a', 'b']).slice(0, 3)).toEqual(queryKeys.dm.all);
    expect(queryKeys.dm.people(['a', 'b']).slice(0, 4)).toEqual(queryKeys.dm.peopleAll);
  });
});

describe('usePeople (group sender names)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const CAROL_ID = 'CarolId11111111111111111111111111111111111111';
  const person = (id: string, displayName: string, resolved: boolean) => ({
    id,
    username: displayName.toLowerCase(),
    displayName,
    avatar: { uri: null, dicebear: null },
    resolved,
  });
  const nameOf = (ids: string[], id: string) => {
    const { result, unmount } = renderHook(() => usePeople(ids), { wrapper });
    return { name: () => result.current.byId.get(id)?.displayName, unmount };
  };

  it('shows a fallback name once, reads it again next time, and keeps a loaded name over a later fallback (QA rc17 D-010)', async () => {
    const batch = fakeEngine.method('profiles.batch');
    // The profile read failed: the handle stands in for the display name.
    batch.mockResolvedValueOnce([person(BOB_ID, 'bob', false)]);
    const first = nameOf([BOB_ID], BOB_ID);
    await act(async () => {});
    expect(first.name()).toBe('bob');
    first.unmount();

    // Not kept as final: the next screen reads Bob again and gets his name.
    batch.mockResolvedValueOnce([person(BOB_ID, 'Bob Builder', true)]);
    const second = nameOf([BOB_ID], BOB_ID);
    await act(async () => {});
    expect(second.name()).toBe('Bob Builder');
    second.unmount();
    expect(batch).toHaveBeenCalledTimes(2);

    // Loaded, it is kept: no read on the next screen.
    const third = nameOf([BOB_ID], BOB_ID);
    await act(async () => {});
    expect(third.name()).toBe('Bob Builder');
    third.unmount();
    expect(batch).toHaveBeenCalledTimes(2);

    // Another group's read falls back for Bob: the name loaded earlier stays.
    batch.mockResolvedValueOnce([person(BOB_ID, 'bob', false), person(CAROL_ID, 'Carol', true)]);
    const group = nameOf([BOB_ID, CAROL_ID], BOB_ID);
    await act(async () => {});
    expect(group.name()).toBe('Bob Builder');
    group.unmount();
    expect(batch).toHaveBeenCalledTimes(3);

    // The kept name still counts as a failed read: reopening the group reads again, and uses what it gets.
    batch.mockResolvedValueOnce([person(BOB_ID, 'Robert Builder', true), person(CAROL_ID, 'Carol', true)]);
    const reopened = nameOf([BOB_ID, CAROL_ID], BOB_ID);
    await act(async () => {});
    expect(batch).toHaveBeenCalledTimes(4);
    expect(reopened.name()).toBe('Robert Builder');
    reopened.unmount();
  });

  it('keeps a loaded name through failed reads in a row, and still reads again each time (QA rc17 D-010)', async () => {
    // Dave, so no other test's read holds a loaded copy of him.
    const DAVE_ID = 'DaveId111111111111111111111111111111111111111';
    const batch = fakeEngine.method('profiles.batch');
    batch.mockResolvedValueOnce([person(DAVE_ID, 'Dave Diver', true)]);
    const loaded = nameOf([DAVE_ID], DAVE_ID);
    await act(async () => {});
    expect(loaded.name()).toBe('Dave Diver');
    loaded.unmount();

    // His name is kept for ten minutes; a refresh reads it again, and that read fails.
    queryClient.invalidateQueries({ queryKey: queryKeys.dm.people([DAVE_ID]) }).catch(() => undefined);
    // Two failed reads in a row: the second is read again on its own (a failed read is never final), and his name stays.
    for (const reads of [2, 3]) {
      batch.mockResolvedValueOnce([person(DAVE_ID, 'dave', false)]);
      const failed = nameOf([DAVE_ID], DAVE_ID);
      await act(async () => {});
      expect(batch).toHaveBeenCalledTimes(reads);
      expect(failed.name()).toBe('Dave Diver');
      failed.unmount();
    }

    // The last failed read stays stale: the next open reads again.
    batch.mockResolvedValueOnce([person(DAVE_ID, 'Dave Diver', true)]);
    const recovered = nameOf([DAVE_ID], DAVE_ID);
    await act(async () => {});
    expect(batch).toHaveBeenCalledTimes(4);
    recovered.unmount();
  });
});

const BOB = { id: BOB_ID, username: 'bob', displayName: 'Bob Builder', avatar: { uri: null, dicebear: null }, resolved: true };
const busy = () => Object.assign(new Error('Messages are still loading'), { code: 'ENGINE_BUSY' });

describe('New message (DM-05)', () => {
  beforeEach(() => {
    signIn();
    fakeEngine.method('explore.searchUsers').mockResolvedValue([BOB]);
    fakeEngine.method('graph.followers').mockResolvedValue({ items: [BOB], cursor: null, hasMore: false });
  });

  it('?with= waits out ENGINE_BUSY (a cold start) and opens the conversation', async () => {
    fakeEngine.method('dm.startDirect').mockRejectedValueOnce(busy()).mockResolvedValue('d:alice-bob');
    await renderAt(`/messages/new?with=${BOB_ID}`);
    expect(screen.getByTestId('new-message-opening')).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();
    // renderRouter runs Jest's fake timers.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
    }
    expect(fakeEngine.method('dm.startDirect')).toHaveBeenCalledTimes(2);
    expect(pathname()).toBe('/messages/d:alice-bob');
  });

  it('?with= an unknown id leaves the picker showing that search, with the reason', async () => {
    fakeEngine.method('dm.startDirect').mockRejectedValue(Object.assign(new Error('not found'), { code: 'BAD_REQUEST' }));
    await renderAt(`/messages/new?with=${BOB_ID}`);
    expect(fakeEngine.method('dm.startDirect')).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().current?.message).toBe('No user found with this identity ID');
    expect(screen.queryByTestId('new-message-opening')).toBeNull();
    expect(screen.getByTestId('picker-search')).toHaveDisplayValue(BOB_ID);
  });

  it('says why when the person has no encryption key, not that nobody was found (SR-40)', async () => {
    const reason = 'This account has no encryption key yet, so it cannot receive encrypted messages.';
    fakeEngine.method('dm.startDirect').mockRejectedValue(Object.assign(new Error(reason), { code: 'BAD_REQUEST' }));
    await renderAt(`/messages/new?with=${BOB_ID}`);
    expect(useToastStore.getState().current?.message).toBe(reason);
  });

  it('says a pasted id that is not one is invalid, without looking it up or blaming the connection (QA D-L4a-007)', async () => {
    await renderAt('/messages/new');
    fireEvent.changeText(screen.getByTestId('picker-search'), '1'.repeat(44));
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('picker-invalid')).toHaveTextContent('Invalid identity ID');
    expect(screen.queryByText(/Check your connection/)).toBeNull();
    expect(fakeEngine.method('profiles.get')).not.toHaveBeenCalled();
  });

  it('leaves the search text to the input while typing, and Clear still empties it (QA rc7 D-2)', async () => {
    // A `value` search pushed each keystroke's text back, and under the searches' renders that
    // echo dropped the keys typed meanwhile ('lucia' searched as 'luc').
    await renderAt('/messages/new');
    for (const text of ['l', 'lu', 'luc', 'luci', 'lucia']) fireEvent.changeText(screen.getByTestId('picker-search'), text);
    expect(screen.getByTestId('picker-search').props.value).toBeUndefined();
    fireEvent.press(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('picker-search')).toHaveDisplayValue('');
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it("refuses to message yourself without asking the engine", async () => {
    fakeEngine.method('explore.searchUsers').mockResolvedValue([{ ...BOB, id: VIEWER }]);
    await renderAt(`/messages/new?with=${VIEWER}`);
    expect(fakeEngine.method('dm.startDirect')).not.toHaveBeenCalled();
    expect(useToastStore.getState().current?.message).toBe("You can't message yourself");
  });
});

describe('New group (DM-06)', () => {
  async function fillForm() {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('graph.followers').mockResolvedValue({ items: [BOB], cursor: null, hasMore: false });
    await renderAt('/messages/new-group');
    fireEvent.changeText(screen.getByTestId('new-group-name'), 'Builders');
    fireEvent.press(screen.getByTestId(`picker-user-${BOB_ID}`));
    expect(screen.getByTestId('new-group-chips')).toBeTruthy();
  }

  it('opens the group once confirmed, and resends the key to a member it missed by itself (#8)', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.createGroup').mockResolvedValue(created);
    fakeEngine.method('dm.createdGroup').mockResolvedValue({ key: 'g:builders', failed: [BOB_ID] });
    const resent = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.resendKeys').mockResolvedValue(resent);
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledWith('Builders', [BOB_ID]);
    expect(screen.getByTestId('new-group-progress')).toHaveTextContent('Creating group…');

    await act(async () => {
      fakeEngine.emit('write.status', advance(created, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(fakeEngine.method('dm.createdGroup')).toHaveBeenCalledWith(created.id);
    expect(pathname()).toBe('/messages/g:builders');
    // No chore for the owner: the key goes out again by itself, and a success says nothing.
    expect(fakeEngine.method('dm.resendKeys')).toHaveBeenCalledWith('g:builders', BOB_ID);
    expect(useToastStore.getState().current?.message ?? '').not.toMatch(/key|member/i);
    await act(async () => {
      fakeEngine.emit('write.status', advance(resent, { state: 'confirmed' }));
    });
    expect(useToastStore.getState().current?.message ?? '').not.toMatch(/key|member/i);
    expect(fakeEngine.method('dm.resendKeys')).toHaveBeenCalledTimes(1);
  });

  it('keeps "Create group" above the keyboard on Android while members are searched for (QA keyboard-overlaps)', async () => {
    await onAndroid(async () => {
      await fillForm();
      const avoider = screen.UNSAFE_getByType(KeyboardAvoidingView);
      expect(within(avoider).getByTestId('new-group-create')).toBeTruthy();
      expect(within(avoider).getByTestId('picker-search')).toBeTruthy();
    });
  });

  it('waits out the first load (a cold start) instead of failing the creation', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.status').mockResolvedValueOnce(status({ ready: false }));
    fakeEngine.method('dm.createGroup').mockRejectedValueOnce(busy()).mockResolvedValue(created);
    fireEvent.press(screen.getByTestId('new-group-create'));
    // renderRouter runs Jest's fake timers.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
    }
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('new-group-progress')).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();
  });

  it('never retries a creation the engine refuses because another one is running', async () => {
    await fillForm();
    fakeEngine.method('dm.createGroup').mockRejectedValue(Object.assign(new Error('A group is still being created'), { code: 'ENGINE_BUSY' }));
    fireEvent.press(screen.getByTestId('new-group-create'));
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
    }
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().current?.message).toBe("Couldn't create the group. Try again.");
  });

  it('says a name over the byte limit is too long instead of letting the engine refuse it (SR-38)', async () => {
    await fillForm();
    // 70 characters pass the 100-character cap, but are 210 UTF-8 bytes.
    fireEvent.changeText(screen.getByTestId('new-group-name'), '中文测试中'.repeat(14));
    expect(screen.getByText(/too long for the network/)).toBeTruthy();
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    expect(fakeEngine.method('dm.createGroup')).not.toHaveBeenCalled();
  });

  it('creates once when Create is tapped again before the engine answers', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    let answer: (t: typeof created) => void = () => undefined;
    fakeEngine.method('dm.createGroup').mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    // The handler itself, twice in one tick, then a tap after the re-render.
    const onCreate = screen.UNSAFE_getAllByProps({ testID: 'new-group-create' })[0].props.onPress as () => void;
    await act(async () => {
      onCreate();
      onCreate();
    });
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {
      answer(created);
    });
    await act(async () => {
      fakeEngine.emit('write.status', advance(created, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledTimes(1);
  });

  it('goes to the inbox, read again, when the outcome is unknown, never offering a second creation (#8)', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.createGroup').mockResolvedValue(created);
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    fakeEngine.method('dm.conversations').mockClear();
    await act(async () => {
      fakeEngine.emit('write.status', advance(created, { state: 'unconfirmed', retryable: false }));
    });
    await act(async () => {});
    expect(pathname()).toBe('/messages');
    expect(fakeEngine.method('dm.conversations')).toHaveBeenCalled();
    expect(screen.queryByText(/Not confirmed|may (still )?have/)).toBeNull();
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledTimes(1);
  });

  it('stays locked once confirmed, and goes to the inbox when finding the new group fails', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.createGroup').mockResolvedValue(created);
    let fail: (error: Error) => void = () => undefined;
    fakeEngine.method('dm.createdGroup').mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    await act(async () => {
      fakeEngine.emit('write.status', advance(created, { state: 'confirmed' }));
    });
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledTimes(1);

    await act(async () => {
      fail(new Error('gone'));
    });
    await act(async () => {});
    expect(useToastStore.getState().current?.message).toBe('Group created');
    expect(pathname()).toBe('/messages');
  });

  it('goes back to the inbox when the engine no longer knows the new group', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.createGroup').mockResolvedValue(created);
    fakeEngine.method('dm.createdGroup').mockResolvedValue(null);
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    await act(async () => {
      fakeEngine.emit('write.status', advance(created, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(useToastStore.getState().current?.message).toBe('Group created');
    expect(pathname()).toBe('/messages');
  });
});

describe('Group info (DM-07, DM-08)', () => {
  const GROUP = 'g:builders';
  const group = (overrides: Partial<ConversationDTO> = {}) =>
    conversation({ key: GROUP, kind: 'group', peer: null, name: 'Builders', members: [VIEWER, BOB_ID], ownerId: BOB_ID, ...overrides });

  async function openInfo(row: ConversationDTO) {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([row]);
    await renderAt(`/messages/${encodeURIComponent(GROUP)}/info`);
  }

  it('gives the owner rename and End group, and a member Leave group', async () => {
    await openInfo(group({ ownerId: VIEWER, isOwner: true }));
    expect(screen.getByTestId('group-rename')).toBeTruthy();
    expect(screen.getByTestId('group-end')).toBeTruthy();
    expect(screen.queryByTestId('group-leave')).toBeNull();
  });

  it('leaves after the confirm: back in the inbox at once, the group out of it unless the leave fails (#8)', async () => {
    await openInfo(group());
    expect(screen.queryByTestId('group-rename')).toBeNull();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => buttons?.[1]?.onPress?.());
    const left = ticket({ op: 'dm.group', target: { conversationKey: GROUP } });
    fakeEngine.method('dm.leaveGroup').mockResolvedValue(left);
    fireEvent.press(screen.getByTestId('group-leave'));
    await act(async () => {});
    expect(alert).toHaveBeenCalledWith('Leave group?', "You'll stop getting messages from this group.", expect.anything(), expect.anything());
    expect(fakeEngine.method('dm.leaveGroup')).toHaveBeenCalledWith(GROUP);
    expect(pathname()).toBe('/messages');
    expect(screen.queryByText('Builders')).toBeNull();

    // A leave that fails brings it back (the tracker says why).
    await act(async () => {
      fakeEngine.emit('write.status', advance(left, { state: 'failed', retryable: true }));
    });
    expect(screen.getByText('Builders')).toBeTruthy();
    alert.mockRestore();
  });

  it('offers the owner Re-invite, not "Resend keys", and asks before removing in plain words (#8)', async () => {
    await openInfo(group({ ownerId: VIEWER, isOwner: true }));
    const menu = () => screen.getByTestId(`group-member-menu-${BOB_ID}`);
    expect((menu().props.actions as { title: string }[]).map((a) => a.title)).toEqual(['Re-invite', 'Remove member']);

    const invited = ticket({ op: 'dm.group', target: { conversationKey: GROUP } });
    fakeEngine.method('dm.resendKeys').mockResolvedValue(invited);
    await act(async () => fireEvent(menu(), 'pressAction', { nativeEvent: { event: 'resend' } }));
    expect(fakeEngine.method('dm.resendKeys')).toHaveBeenCalledWith(GROUP, BOB_ID);
    await act(async () => {
      fakeEngine.emit('write.status', advance(invited, { state: 'confirmed' }));
    });
    expect(useToastStore.getState().current?.message).toBe('Invite sent');

    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await act(async () => fireEvent(menu(), 'pressAction', { nativeEvent: { event: 'remove' } }));
    expect(alert).toHaveBeenCalledWith(
      expect.stringMatching(/^Remove .+ from the group\?$/),
      "They won't see new messages.",
      expect.anything(),
      expect.anything(),
    );
    alert.mockRestore();
  });

  it('sends a link to a legacy account\'s group info to the inbox (#23)', async () => {
    fakeEngine.setStatus({ info: { capabilities: { dm: 'legacy' } as never } });
    await openInfo(group());
    expect(pathname()).toBe('/messages');
    expect(screen.queryByText(/available on this network/)).toBeNull();
  });

  it('adds a member, and the row says busy only while the write runs (QA D-RVa-dc-01)', async () => {
    const CAROL = 'CarolId11111111111111111111111111111111111';
    const owned = group({ ownerId: VIEWER, isOwner: true });
    fakeEngine
      .method('graph.followers')
      .mockResolvedValue({ items: [{ ...BOB, id: CAROL, username: 'carol', displayName: 'Carol' }], cursor: null, hasMore: false });
    await openInfo(owned);
    fireEvent.press(screen.getByTestId('group-add'));
    await act(async () => {});
    const added = ticket({ op: 'dm.group', target: { conversationKey: GROUP } });
    fakeEngine.method('dm.addMember').mockResolvedValue(added);
    fireEvent.press(screen.getByTestId(`picker-user-${CAROL}`));
    await act(async () => {});
    expect(fakeEngine.method('dm.addMember')).toHaveBeenCalledWith(GROUP, CAROL);
    // Labelled in every state: Android keeps a "busy" description on an unlabelled view after the write is done.
    expect(screen.getByTestId('group-add').props).toMatchObject({
      accessibilityLabel: 'Done adding',
      accessibilityState: { busy: true },
    });

    fakeEngine.method('dm.conversations').mockResolvedValue([{ ...owned, members: [VIEWER, BOB_ID, CAROL] }]);
    await act(async () => {
      fakeEngine.emit('write.status', advance(added, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(screen.getByTestId('group-add').props).toMatchObject({
      accessibilityLabel: 'Done adding',
      accessibilityState: { busy: false },
    });
    expect(useToastStore.getState().current?.message).toBe('Member added');
    expect(screen.getByTestId(`group-member-${CAROL}`)).toBeTruthy();
  });

  /** Group info with the add-members picker open, laid out 700 high with its section at 540. */
  async function openAddMembers() {
    // Before the screen mounts: it listens for the keyboard from the start.
    const listen = jest.spyOn(Keyboard, 'addListener');
    await openInfo(group({ ownerId: VIEWER, isOwner: true }));
    const view = screen.UNSAFE_getByType(ScrollView);
    const layout = (height: number, y = 0) => ({ nativeEvent: { layout: { x: 0, y, width: 390, height } } });
    fireEvent(screen.getByTestId('group-info'), 'layout', layout(700));
    fireEvent(screen.getByTestId('group-add-section'), 'layout', layout(120, 540));
    fireEvent.press(screen.getByTestId('group-add'));
    await act(async () => {});
    /** A keyboard event, `height` high (the software keyboard by default). */
    const keyboard = (name: 'keyboardWillShow' | 'keyboardDidShow' | 'keyboardDidHide', height = 336) =>
      listen.mock.calls
        .filter(([event]) => event === name)
        .forEach(([, listener]) => listener({ endCoordinates: { height, screenX: 0, screenY: 0, width: 390 } } as KeyboardEvent));
    const pickerMinHeight = () => StyleSheet.flatten(screen.getByTestId('group-add-picker').props.style).minHeight;
    const scrollTo = jest.spyOn(view.instance as ScrollView, 'scrollTo');
    return { view, listen, keyboard, pickerMinHeight, scrollTo };
  }

  it('scrolls the add-members picker above the keyboard while searching (NEW-ios-picker-keyboard)', async () => {
    const { view, listen, keyboard, pickerMinHeight, scrollTo } = await openAddMembers();
    expect(view.props.automaticallyAdjustKeyboardInsets).toBe(true);
    // No blank space under the picker before searching.
    expect(pickerMinHeight()).toBeUndefined();

    fireEvent(screen.getByTestId('picker-search'), 'focus');
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 540, animated: true });
    // With the keyboard on its way up the picker is at least as tall as the view, so the section can always reach the top.
    act(() => keyboard('keyboardWillShow'));
    expect(pickerMinHeight()).toBe(700);
    // Again once the keyboard is up (Android lays out for it only then), but not after the field lets go.
    scrollTo.mockClear();
    act(() => keyboard('keyboardDidShow'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    fireEvent(screen.getByTestId('picker-search'), 'blur');
    // Still grown while the keyboard goes down under it.
    expect(pickerMinHeight()).toBe(700);
    act(() => keyboard('keyboardDidShow'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The keyboard down, the picker takes its own height again.
    act(() => keyboard('keyboardDidHide'));
    expect(pickerMinHeight()).toBeUndefined();
    listen.mockRestore();
  });

  it('leaves no blank space under the add-members picker with a hardware keyboard (iOS)', async () => {
    const { listen, keyboard, pickerMinHeight, scrollTo } = await openAddMembers();
    fireEvent(screen.getByTestId('picker-search'), 'focus');
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 540, animated: true });
    // No software keyboard comes up, only the shortcuts bar: nothing covers the results.
    act(() => keyboard('keyboardWillShow', 55));
    act(() => keyboard('keyboardDidShow', 55));
    expect(pickerMinHeight()).toBeUndefined();

    // A software keyboard brought up, then put away while the field keeps focus: grown, then not.
    act(() => keyboard('keyboardDidShow'));
    expect(pickerMinHeight()).toBe(700);
    act(() => keyboard('keyboardDidHide'));
    expect(pickerMinHeight()).toBeUndefined();
    // Searching again with no keyboard, then the field lets go: nothing to wait for.
    fireEvent(screen.getByTestId('picker-search'), 'focus');
    fireEvent(screen.getByTestId('picker-search'), 'blur');
    act(() => keyboard('keyboardDidShow'));
    expect(pickerMinHeight()).toBeUndefined();
    listen.mockRestore();
  });

  it('grows the add-members picker as the search starts on Android, which reports the keyboard only once it is up', async () => {
    await onAndroid(async () => {
      const { listen, keyboard, pickerMinHeight, scrollTo } = await openAddMembers();
      fireEvent(screen.getByTestId('picker-search'), 'focus');
      expect(pickerMinHeight()).toBe(700);
      expect(scrollTo).toHaveBeenLastCalledWith({ y: 540, animated: true });
      act(() => keyboard('keyboardDidShow'));
      fireEvent(screen.getByTestId('picker-search'), 'blur');
      // Still grown while the keyboard goes down under it.
      expect(pickerMinHeight()).toBe(700);
      act(() => keyboard('keyboardDidHide'));
      expect(pickerMinHeight()).toBeUndefined();
      listen.mockRestore();
    });
  });

  it('shows an error with Retry when the status read fails', async () => {
    signIn();
    fakeEngine.method('dm.status').mockRejectedValue(Object.assign(new Error('offline'), { code: 'NETWORK' }));
    await renderAt(`/messages/${encodeURIComponent(GROUP)}/info`);
    // renderRouter runs Jest's fake timers.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });
    }
    expect(screen.getByTestId('group-info-error')).toBeTruthy();
  });
});

describe('Message settings (DM-12)', () => {
  it('puts the retention back when saving it fails', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ retention: 'never' }));
    fakeEngine.method('dm.setRetention').mockRejectedValue(new Error('quorum'));
    await renderAt('/settings/messages');
    fireEvent.press(screen.getByTestId('dm-retention-30d'));
    await act(async () => {});
    expect(fakeEngine.method('dm.setRetention')).toHaveBeenCalledWith('30d');
    expect(queryClient.getQueryData<DmStatusDTO>(queryKeys.dm.status)?.retention).toBe('never');
    expect(useToastStore.getState().current?.message).toBe("Couldn't save the setting. Try again.");
  });

  it('says to unlock, instead of loading forever, while messages are locked (SR-42)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true, ready: false, retention: null }));
    await renderAt('/settings/messages');
    expect(screen.getByText('Unlock your messages to change this setting.')).toBeTruthy();
    expect(screen.getByTestId('dm-blocked-locked')).toBeTruthy();
  });

  it('says the saved state failed to load, instead of loading forever', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ ready: false, retention: null, error: 'Failed to fetch' }));
    await renderAt('/settings/messages');
    expect(screen.getByTestId('dm-settings-error')).toBeTruthy();
    fakeEngine.method('dm.status').mockResolvedValue(status({ retention: 'never' }));
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId('dm-retention')).toBeTruthy();
  });

  it('has nothing to set on legacy: a link here goes to the inbox (DM-11, #23)', async () => {
    signIn();
    fakeEngine.setStatus({ info: { capabilities: { dm: 'legacy' } as never } });
    fakeEngine.method('dm.status').mockResolvedValue(status({ backend: 'legacy' }));
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    await renderAt('/settings/messages');
    expect(pathname()).toBe('/messages');
    expect(screen.queryByTestId('dm-retention')).toBeNull();
    expect(screen.queryByText(/available on this network/)).toBeNull();
  });

  // Pushed on any tab now (Settings on Profile, the inbox gear on Messages): leaving
  // goes back down this stack, never a jump to the Messages tab that leaves it on top.
  it('goes back to the screen underneath on legacy, instead of jumping to the inbox', async () => {
    signIn();
    fakeEngine.setStatus({ info: { capabilities: { dm: 'legacy' } as never } });
    fakeEngine.method('dm.status').mockResolvedValue(status({ backend: 'legacy' }));
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    await renderAt('/block/someone');
    await act(async () => router.push('/settings/messages'));
    expect(pathname()).toBe('/block/someone');
    expect(screen.queryByTestId('dm-retention')).toBeNull();
  });

  // Signing in keeps every tab's stack, so the screen can turn legacy while another
  // screen covers it: it must leave once it is shown again, not stay blank.
  it('leaves on legacy once it is shown again, when it turned legacy in the background', async () => {
    fakeEngine.setStatus({ info: { capabilities: { dm: 'legacy' } as never } });
    fakeEngine.method('dm.status').mockResolvedValue(status({ backend: 'legacy' }));
    fakeEngine.method('dm.conversations').mockResolvedValue([]);
    await renderAt('/settings/messages');
    expect(pathname()).toBe('/settings/messages');
    await act(async () => router.push('/block/someone'));

    await act(async () => signIn());
    expect(pathname()).toBe('/block/someone');

    await act(async () => router.back());
    expect(pathname()).toBe('/messages');
  });

  it('offers plain retention choices with the privacy caveat, never fee accounting (#14)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ retention: '30d' }));
    await renderAt('/settings/messages');
    expect(screen.getByText('Delete old sent messages')).toBeTruthy();
    for (const option of ['Never', 'After 30 days', 'After 90 days', 'After 1 year']) expect(screen.getByText(option)).toBeTruthy();
    expect(screen.getByTestId('dm-retention-body')).toHaveTextContent(
      "Deleting old sent messages refunds most of their storage fee. It doesn't make them private: people you messaged keep their copies, and Dash Platform keeps a history.",
    );
    expect(screen.queryByText(/Reclaim|keep paying|Disappearing/i)).toBeNull();
    // Nobody blocked: an empty state, not "Nobody."
    expect(screen.getByTestId('dm-blocked-empty')).toHaveTextContent(
      'No blocked accountsMessages and group invites from people you block are ignored.',
    );
  });
});
