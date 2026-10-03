import type { ConversationDTO, DmStatusDTO, MessageDTO, Page, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen } from '@testing-library/react-native';
import { Alert, AppState, Platform, type AppStateStatus } from 'react-native';
import { Stack } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { resetWriteTracking } from '~/data/writes';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { useToastStore } from '~/ui/toast';

import { ConversationScreen } from './ConversationScreen';
import { GroupInfoScreen } from './GroupInfoScreen';
import { MessageSettingsScreen } from './MessageSettingsScreen';
import { NewGroupScreen } from './NewGroupScreen';
import { NewMessageScreen } from './NewMessageScreen';
import { useMessagesBadge } from './dm-data';
import { useDraft, useDrafts } from './drafts';
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
      'messages/settings': MessageSettingsScreen,
      'messages/[conversationId]/index': ConversationScreen,
      'messages/[conversationId]/info': GroupInfoScreen,
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
  useOutbox.setState({ entries: [] });
  useDrafts.getState().clearAll();
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

  it('locked, offers the unlock sheet, which falls back to entering the key', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true }));
    fakeEngine.method('dm.unlock').mockResolvedValueOnce({ unlocked: false, reason: 'not-derivable' });
    await renderAt('/messages');
    expect(screen.getByText('Unlock your messages')).toBeTruthy();
    expect(fakeEngine.method('dm.conversations')).not.toHaveBeenCalled();
    // The inbox itself is Android-only private; on iOS only the key sheet blocks screenshots.
    expect(nativeCapture.isCaptureBlocked()).toBe(false);

    fireEvent.press(screen.getByText('Enter encryption key'));
    await act(async () => {});
    expect(fakeEngine.method('dm.unlock')).toHaveBeenCalledWith({});
    expect(nativeCapture.isCaptureBlocked()).toBe(true);

    fakeEngine.method('dm.unlock').mockResolvedValueOnce({ unlocked: true, status: status() });
    fireEvent.changeText(screen.getByTestId('dm-unlock-key'), 'cWIFkey');
    fireEvent.press(screen.getByTestId('dm-unlock-save'));
    await act(async () => {});
    expect(fakeEngine.method('dm.unlock')).toHaveBeenLastCalledWith({ key: 'cWIFkey' });
    expect(useToastStore.getState().current?.message).toBe('Encryption key saved');
  });

  it('says "Invalid key" when the key does not match', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true }));
    fakeEngine.method('dm.unlock').mockResolvedValueOnce({ unlocked: false, reason: 'not-derivable' });
    await renderAt('/messages');
    fireEvent.press(screen.getByText('Enter encryption key'));
    await act(async () => {});
    fakeEngine.method('dm.unlock').mockRejectedValueOnce(Object.assign(new Error('Invalid key'), { code: 'KEY_INVALID' }));
    fireEvent.changeText(screen.getByTestId('dm-unlock-key'), 'nope');
    fireEvent.press(screen.getByTestId('dm-unlock-save'));
    await act(async () => {});
    expect(screen.getByTestId('dm-unlock-error').props.children).toBe('Invalid key');
  });

  it('lists conversations with previews, filters by search, and keeps deleted ones behind the footer', async () => {
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

    fireEvent.press(screen.getByText('Show 1 deleted conversation'));
    expect(screen.getByText('Old Chat')).toBeTruthy();

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

  it('when every conversation is deleted, says so instead of welcoming a first visit (SR-41)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status());
    fakeEngine.method('dm.conversations').mockResolvedValue([conversation({ key: 'd:gone', flags: { ...FLAGS, hidden: true } })]);
    await renderAt('/messages');
    expect(screen.queryByText('Welcome to Messages')).toBeNull();
    expect(screen.getByTestId('messages-all-deleted')).toBeTruthy();
    expect(screen.getByText('Show 1 deleted conversation')).toBeTruthy();
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

  it('keeps the conversation out of Android Recents and screenshots while it is open', async () => {
    await onAndroid(async () => {
      await openConversation();
      expect(nativeCapture.isCaptureBlocked()).toBe(true);
      rendered?.unmount();
      rendered = null;
      expect(nativeCapture.isCaptureBlocked()).toBe(false);
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
    expect(screen.getByTestId('dm-composer').props.value).toBe('');

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
    expect(screen.getByText('Failed · Tap to retry')).toBeTruthy();

    // The engine reports every transition as `write.status` before it answers the call.
    fakeEngine.method('writes.retry').mockImplementation(async () => {
      const retried = advance(sent, { state: 'pending', retryable: false, updatedAt: new Date(Date.now() + 5000) });
      fakeEngine.emit('write.status', retried);
      return retried;
    });
    fireEvent.press(screen.getByText('Failed · Tap to retry'));
    await act(async () => {});
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(sent.id);
    expect(screen.getByText('Sending…')).toBeTruthy();
  });

  it('a send whose call hangs reads "Not confirmed · Tap to check", never Retry, then "Sent" once it answers (QA D-L4a-002)', async () => {
    await openConversation();
    const sent = ticket({ op: 'dm.send', target: { conversationKey: KEY } });
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
    expect(screen.queryByText('Sending…')).toBeNull();
    expect(screen.queryByText('Failed · Tap to retry')).toBeNull();
    fakeEngine.method('writes.check').mockResolvedValue(advance(stalled, { lastCheckedAt: new Date() }));
    fireEvent.press(screen.getByText('Not confirmed · Tap to check'));
    await act(async () => {});
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(sent.id);
    expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
    expect(screen.getByText('Not confirmed · Tap to check')).toBeTruthy();
    expect(useToastStore.getState().current?.message).toBe('Still sending. Tap again in a moment.');

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

  it('puts the text back in the composer when the engine refuses the send', async () => {
    await openConversation();
    fakeEngine
      .method('dm.send')
      .mockRejectedValue(Object.assign(new Error('Unblock this person to message them.'), { code: 'BAD_REQUEST' }));
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'hello?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    expect(screen.getByTestId('dm-composer').props.value).toBe('hello?');
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
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'still there?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    expect(screen.getByText('Not confirmed · Tap to check')).toBeTruthy();
    expect(useOutbox.getState().entries[0].ticketId).toBeNull();

    // The next engine restores it; the bubble now checks that ticket.
    const restored = ticket({ op: 'dm.send', state: 'unconfirmed', target: { conversationKey: KEY } });
    await act(async () => {
      fakeEngine.emit('write.status', restored);
    });
    expect(useOutbox.getState().entries[0].ticketId).toBe(restored.id);
    fakeEngine.method('writes.check').mockResolvedValue(restored);
    fireEvent.press(screen.getByText('Not confirmed · Tap to check'));
    await act(async () => {});
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(restored.id);
  });

  it('puts the text of a send the engine never took back in the composer, once it has no ticket for it (SR-16)', async () => {
    await openConversation();
    fakeEngine.method('dm.send').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENGINE_RESTARTED' }));
    fireEvent.changeText(screen.getByTestId('dm-composer'), 'did it go?');
    fireEvent.press(screen.getByTestId('dm-send'));
    await act(async () => {});
    fakeEngine.method('writes.list').mockResolvedValue([]);

    // Just cut short: the engine may still make its ticket.
    fireEvent.press(screen.getByText('Not confirmed · Tap to check'));
    await act(async () => {});
    expect(useToastStore.getState().current?.message).toBe('Still checking. Tap again in a moment.');
    expect(screen.getByTestId('dm-composer').props.value).toBe('');

    // Later, still no ticket: it never went out.
    jest.setSystemTime(Date.now() + 61_000);
    fireEvent.press(screen.getByText('Not confirmed · Tap to check'));
    await act(async () => {});
    expect(screen.getByTestId('dm-composer').props.value).toBe('did it go?');
    expect(screen.queryByText('Not confirmed · Tap to check')).toBeNull();
    expect(useToastStore.getState().current?.message).toBe("This message wasn't sent. It's back in the message box.");
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
    jest.setSystemTime(Date.now() + 61_000);
    fireEvent.press(screen.getByText('Not confirmed · Tap to check'));
    await act(async () => {});
    expect(screen.getByTestId('dm-composer').props.value).toBe('did it go?');
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
    fireEvent.press(screen.getByText('Failed · Tap to edit'));
    await act(async () => {});
    expect(screen.getByTestId('dm-composer').props.value).toBe(rest);
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
    expect(screen.getByTestId('picker-search').props.value).toBe(BOB_ID);
  });

  it('says why when the person has no encryption key, not that nobody was found (SR-40)', async () => {
    const reason = 'This account has no encryption key yet, so it cannot receive encrypted messages.';
    fakeEngine.method('dm.startDirect').mockRejectedValue(Object.assign(new Error(reason), { code: 'BAD_REQUEST' }));
    await renderAt(`/messages/new?with=${BOB_ID}`);
    expect(useToastStore.getState().current?.message).toBe(reason);
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

  it('opens the group once confirmed, offering to resend keys to members it missed', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.createGroup').mockResolvedValue(created);
    fakeEngine.method('dm.createdGroup').mockResolvedValue({ key: 'g:builders', failed: [BOB_ID] });
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledWith('Builders', [BOB_ID]);
    expect(screen.getByTestId('new-group-progress')).toBeTruthy();

    await act(async () => {
      fakeEngine.emit('write.status', advance(created, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(fakeEngine.method('dm.createdGroup')).toHaveBeenCalledWith(created.id);
    expect(pathname()).toBe('/messages/g:builders');
    expect(useToastStore.getState().current?.message).toBe('1 member(s) did not get the group key yet.');
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

  it('keeps Create locked while the creation is unconfirmed, until a check finds the group', async () => {
    await fillForm();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.createGroup').mockResolvedValue(created);
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    await act(async () => {
      fakeEngine.emit('write.status', advance(created, { state: 'unconfirmed', retryable: false }));
    });
    expect(screen.getByTestId('new-group-unconfirmed')).toBeTruthy();
    fireEvent.press(screen.getByTestId('new-group-create'));
    await act(async () => {});
    expect(fakeEngine.method('dm.createGroup')).toHaveBeenCalledTimes(1);

    const found = advance(created, { state: 'confirmed', updatedAt: new Date(Date.now() + 5000) });
    // The engine reports the transition as `write.status` before it answers the call.
    fakeEngine.method('writes.check').mockImplementation(async () => {
      fakeEngine.emit('write.status', found);
      return found;
    });
    fakeEngine.method('dm.createdGroup').mockResolvedValue({ key: 'g:builders', failed: [] });
    fireEvent.press(screen.getByTestId('new-group-check'));
    await act(async () => {});
    await act(async () => {});
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(created.id);
    expect(pathname()).toBe('/messages/g:builders');
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

  it('leaves after the confirm, then returns to the inbox', async () => {
    await openInfo(group());
    expect(screen.queryByTestId('group-rename')).toBeNull();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => buttons?.[1]?.onPress?.());
    const left = ticket({ op: 'dm.group', target: { conversationKey: GROUP } });
    fakeEngine.method('dm.leaveGroup').mockResolvedValue(left);
    fireEvent.press(screen.getByTestId('group-leave'));
    await act(async () => {});
    expect(fakeEngine.method('dm.leaveGroup')).toHaveBeenCalledWith(GROUP);
    await act(async () => {
      fakeEngine.emit('write.status', advance(left, { state: 'confirmed' }));
    });
    await act(async () => {});
    expect(pathname()).toBe('/messages');
    alert.mockRestore();
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
    await renderAt('/messages/settings');
    fireEvent.press(screen.getByTestId('dm-retention-30d'));
    await act(async () => {});
    expect(fakeEngine.method('dm.setRetention')).toHaveBeenCalledWith('30d');
    expect(queryClient.getQueryData<DmStatusDTO>(queryKeys.dm.status)?.retention).toBe('never');
    expect(useToastStore.getState().current?.message).toBe("Couldn't save the setting. Try again.");
  });

  it('says to unlock, instead of loading forever, while messages are locked (SR-42)', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ locked: true, ready: false, retention: null }));
    await renderAt('/messages/settings');
    expect(screen.getByText('Unlock your messages to change this setting.')).toBeTruthy();
    expect(screen.getByTestId('dm-blocked-locked')).toBeTruthy();
  });

  it('says the saved state failed to load, instead of loading forever', async () => {
    signIn();
    fakeEngine.method('dm.status').mockResolvedValue(status({ ready: false, retention: null, error: 'Failed to fetch' }));
    await renderAt('/messages/settings');
    expect(screen.getByTestId('dm-settings-error')).toBeTruthy();
    fakeEngine.method('dm.status').mockResolvedValue(status({ retention: 'never' }));
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId('dm-retention')).toBeTruthy();
  });

  it('has nothing to set on legacy (DM-11)', async () => {
    signIn();
    fakeEngine.setStatus({ info: { capabilities: { dm: 'legacy' } as never } });
    fakeEngine.method('dm.status').mockResolvedValue(status({ backend: 'legacy' }));
    await renderAt('/messages/settings');
    expect(screen.getByTestId('dm-settings-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('dm-retention')).toBeNull();
  });
});
