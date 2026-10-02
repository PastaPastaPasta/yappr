import type { ConversationDTO, DmStatusDTO, MessageDTO, Page, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen } from '@testing-library/react-native';
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
import { useMessagesBadge } from './dm-data';
import { useDrafts } from './drafts';
import { InboxScreen } from './InboxScreen';
import { mergeOutbox, useOutbox, type OutboxEntry } from './outbox';
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

async function renderAt(initialUrl: string) {
  renderRouter(
    {
      _layout: Layout,
      'messages/index': InboxScreen,
      'messages/[conversationId]/index': ConversationScreen,
    },
    { initialUrl },
  );
  await act(async () => {});
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

    fireEvent.press(screen.getByText('Enter encryption key'));
    await act(async () => {});
    expect(fakeEngine.method('dm.unlock')).toHaveBeenCalledWith({});

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

  it('replaces the composer when the user blocked the peer (DM-10)', async () => {
    await openConversation([theirs], { flags: { ...FLAGS, blocked: true } });
    expect(screen.getByText('You blocked this person. Unblock them to send messages.')).toBeTruthy();
    expect(screen.queryByTestId('dm-composer')).toBeNull();
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
    expect(merged.landed).toEqual(['local:1']);
    expect(merged.messages.map((m) => [m.id, m.outbox])).toEqual([
      ['old', undefined],
      ['new', undefined],
      ['local:2', 'failed-retry'],
    ]);
  });
});

describe('queryKeys.dm', () => {
  it('nests every DM query under one prefix', () => {
    expect(queryKeys.dm.messages('k').slice(0, 3)).toEqual(queryKeys.dm.all);
    expect(queryKeys.dm.people(['a', 'b']).slice(0, 3)).toEqual(queryKeys.dm.all);
  });
});
