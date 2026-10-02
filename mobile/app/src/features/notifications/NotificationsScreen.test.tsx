import type { NotificationDTO, Page, SessionDTO, SettingsDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen } from '@testing-library/react-native';
import { router, Stack } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { AppState, RefreshControl, type AppStateStatus } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';
import { engineSupervisor } from '~/engine';
import { openPost, openUser } from '~/features/post/post-navigation';
import { queryClient } from '~/state/query-client';
import { AUTHORS, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { NotificationSettingsScreen } from './NotificationSettingsScreen';
import { NotificationsScreen, WINDOWED_FOOTER } from './NotificationsScreen';
import { POLL_INTERVAL_MS, useNotificationBadge, useNotificationsBadge } from './notifications-data';

jest.mock('~/engine', () => {
  const { engineModule } = jest.requireActual('~/data/testing/fake-engine');
  return { ...engineModule, engineSupervisor: { ...engineModule.engineSupervisor, restart: jest.fn() } };
});
jest.mock('~/features/post/post-navigation', () => ({
  openPost: jest.fn(),
  openUser: jest.fn(),
  openExternal: jest.fn(),
}));

// FlashList's own Jest setup (@shopify/flash-list/jestSetup): fixed layouts, so cells render.
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => {
  const layout = { x: 0, y: 0, width: 400, height: 900 };
  return {
    ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
    measureParentSize: () => layout,
    measureFirstChildLayout: () => layout,
    measureItemLayout: () => ({ x: 0, y: 0, width: 400, height: 100 }),
  };
});

const viewer: SessionDTO = {
  identityId: AUTHORS.alice.id,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const TOGGLES = { likes: true, reposts: true, replies: true, follows: true, mentions: true, messages: true, blogPosts: true };
const settings = (overrides: Partial<SettingsDTO['notificationSettings']> = {}): SettingsDTO => ({
  linkPreviewsEnabled: true,
  gateMediaFromNonFollowed: false,
  sendReadReceipts: true,
  sensitiveContentMode: 'blur',
  notificationSettings: { ...TOGGLES, ...overrides },
  payWith: 'credits',
  feedLanguage: 'en',
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const myPost = fixturePost({ id: 'my-post', author: AUTHORS.alice, content: 'gm from my post' });
const theirReply = fixturePost({ id: 'their-reply', kind: 'reply', author: AUTHORS.carol, content: 'nice one!' });

const NOTIFICATIONS: NotificationDTO[] = [
  {
    id: 'like-1',
    type: 'like',
    actor: AUTHORS.bob,
    at: minutesAgo(1),
    read: false,
    target: { id: 'my-post', kind: 'post' },
    preview: myPost,
  },
  {
    id: 'reply-1',
    type: 'reply',
    actor: AUTHORS.carol,
    at: minutesAgo(2),
    read: true,
    target: { id: 'their-reply', kind: 'reply' },
    preview: theirReply,
  },
  {
    id: 'like-2',
    type: 'like',
    actor: AUTHORS.carol,
    at: minutesAgo(3),
    read: false,
    target: { id: 'my-post', kind: 'post' },
    preview: myPost,
  },
  { id: 'follow-1', type: 'follow', actor: AUTHORS.nameless, at: minutesAgo(4), read: false, target: null, preview: null },
];

const page = (items: NotificationDTO[], hasMore = false): Page<NotificationDTO> => ({
  items,
  cursor: hasMore ? 'next' : null,
  hasMore,
});

const list = () => fakeEngine.method('notifications.list');

function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack />
    </QueryClientProvider>
  );
}

async function renderScreen(initialUrl = '/') {
  renderRouter({ _layout: Layout, index: NotificationsScreen }, { initialUrl });
  await act(async () => {});
}

const signIn = () => useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterEach(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  fakeEngine.setStatus({ state: 'ready', info: {} });
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
  useNotificationBadge.setState({ unread: 0 });
  useToastStore.setState({ current: null });
  fakeEngine.method('settings.get').mockResolvedValue(settings());
  fakeEngine.method('notifications.markRead').mockResolvedValue(undefined);
  fakeEngine.method('notifications.markVisibleRead').mockResolvedValue(undefined);
  fakeEngine.method('notifications.poll').mockResolvedValue({ added: 0, unread: 0 });
});

describe('Notifications', () => {
  it('asks a signed-out visitor to sign in, and reads nothing (NOTIF-09)', async () => {
    await renderScreen();

    expect(screen.getByText('Sign in to see your notifications')).toBeTruthy();
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(list()).not.toHaveBeenCalled();
    expect(screen.queryByTestId('notifications-settings')).toBeNull();
  });

  it('lists notifications with grouped likes, phrases, snippets and unread marks (NOTIF-01)', async () => {
    signIn();
    list().mockResolvedValue(page(NOTIFICATIONS));
    await renderScreen();

    expect(list()).toHaveBeenCalledWith({ filter: 'all', cursor: null });
    expect(screen.getByText(/and 1 other liked your post$/)).toBeTruthy();
    expect(screen.getByText(/replied to your reply$/)).toBeTruthy();
    expect(screen.getByText(/started following you$/)).toBeTruthy();
    expect(screen.getByText('gm from my post')).toBeTruthy();
    expect(screen.getByText('nice one!')).toBeTruthy();
    expect(screen.getByTestId('stacked-avatars')).toBeTruthy();
    // The grouped likes and the follow are unread; the reply was read.
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(2);
    expect(screen.getByTestId('notification-likes:my-post')).toHaveAccessibleName(
      /^Unread\. Bob Builder and 1 other liked your post\. gm from my post\./,
    );
    // The dev contract's windowed history (NOTIF-07).
    expect(screen.getByText(WINDOWED_FOOTER)).toBeTruthy();
  });

  it('marks a row read and opens its target (NOTIF-01)', async () => {
    signIn();
    useNotificationBadge.setState({ unread: 3 });
    list().mockResolvedValue(page(NOTIFICATIONS));
    await renderScreen();

    await act(async () => fireEvent.press(screen.getByTestId('notification-likes:my-post')));
    expect(fakeEngine.method('notifications.markRead')).toHaveBeenCalledWith(['like-1', 'like-2']);
    // By id: the preview's stats and viewer marks are placeholders, never seeded as the post.
    expect(openPost).toHaveBeenCalledWith('my-post');
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(1);
    expect(useNotificationBadge.getState().unread).toBe(1);

    await act(async () => fireEvent.press(screen.getByTestId('notification-reply-1')));
    expect(openPost).toHaveBeenLastCalledWith('their-reply');
    // Already read: nothing to mark.
    expect(fakeEngine.method('notifications.markRead')).toHaveBeenCalledTimes(1);

    await act(async () => fireEvent.press(screen.getByTestId('notification-follow-1')));
    expect(openUser).toHaveBeenCalledWith(AUTHORS.nameless.id);
  });

  it('puts the row and the badge back when a read mark is refused', async () => {
    signIn();
    useNotificationBadge.setState({ unread: 3 });
    list().mockResolvedValue(page(NOTIFICATIONS));
    fakeEngine.method('notifications.markRead').mockRejectedValue(new Error('nope'));
    fakeEngine.method('notifications.unreadCount').mockResolvedValue(3);
    await renderScreen();

    await act(async () => fireEvent.press(screen.getByTestId('notification-likes:my-post')));
    expect(openPost).toHaveBeenCalledWith('my-post');
    expect(useNotificationBadge.getState().unread).toBe(3);
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(2);
  });

  it('opens the actor from the avatar', async () => {
    signIn();
    list().mockResolvedValue(page(NOTIFICATIONS));
    await renderScreen();

    fireEvent.press(screen.getByTestId('notification-actor-reply-1'));
    expect(openUser).toHaveBeenCalledWith(AUTHORS.carol.id);
    expect(fakeEngine.method('notifications.markRead')).not.toHaveBeenCalled();
  });

  it('marks all as read (NOTIF-04)', async () => {
    signIn();
    useNotificationBadge.setState({ unread: 3 });
    list().mockResolvedValue(page(NOTIFICATIONS));
    await renderScreen();

    await act(async () => fireEvent.press(screen.getByTestId('notifications-mark-all')));
    expect(fakeEngine.method('notifications.markVisibleRead')).toHaveBeenCalled();
    expect(screen.queryAllByTestId('unread-dot')).toHaveLength(0);
    expect(useNotificationBadge.getState().unread).toBe(0);
    expect(screen.queryByTestId('notifications-mark-all')).toBeNull();
  });

  it('says so and restores the badge when mark all as read is refused', async () => {
    signIn();
    useNotificationBadge.setState({ unread: 3 });
    list().mockResolvedValue(page(NOTIFICATIONS));
    fakeEngine.method('notifications.markVisibleRead').mockRejectedValue(new Error('nope'));
    fakeEngine.method('notifications.unreadCount').mockResolvedValue(3);
    await renderScreen();

    await act(async () => fireEvent.press(screen.getByTestId('notifications-mark-all')));
    expect(useToastStore.getState().current?.message).toBe("Couldn't mark notifications as read. Try again.");
    expect(useNotificationBadge.getState().unread).toBe(3);
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(2);
  });

  it('falls back to All when the selected filter\'s type is turned off (NOTIF-02)', async () => {
    signIn();
    list().mockImplementation(({ filter }: { filter: string }) => Promise.resolve(page(filter === 'all' ? NOTIFICATIONS : [])));
    await renderScreen();

    await act(async () => fireEvent.press(screen.getByTestId('notifications-filters-like')));
    expect(list()).toHaveBeenLastCalledWith({ filter: 'like', cursor: null });
    expect(screen.getByText('No notifications yet')).toBeTruthy();
    await act(async () => queryClient.setQueryData(queryKeys.settings, settings({ likes: false })));
    expect(screen.queryByTestId('notifications-filters-like')).toBeNull();
    expect(screen.getByText(/started following you$/)).toBeTruthy();
  });

  it('filters, hiding the types turned off, with the empty copy (NOTIF-02)', async () => {
    signIn();
    fakeEngine.method('settings.get').mockResolvedValue(settings({ likes: false }));
    list().mockImplementation(({ filter }: { filter: string }) =>
      Promise.resolve(page(filter === 'all' ? NOTIFICATIONS.filter((n) => n.type !== 'like') : [])),
    );
    await renderScreen();

    expect(screen.queryByTestId('notifications-filters-like')).toBeNull();
    await act(async () => fireEvent.press(screen.getByTestId('notifications-filters-mention')));
    expect(list()).toHaveBeenLastCalledWith({ filter: 'mention', cursor: null });
    expect(screen.getByText('No notifications yet')).toBeTruthy();
    expect(screen.getByText("When someone mentions you, you'll see it here")).toBeTruthy();
  });

  it('opens on the filter a link names', async () => {
    signIn();
    list().mockResolvedValue(page([]));
    await renderScreen('/?filter=follow');

    expect(list()).toHaveBeenCalledWith({ filter: 'follow', cursor: null });

    // The tab stays mounted: a later link changes the filter.
    await act(async () => router.setParams({ filter: 'reply' }));
    expect(list()).toHaveBeenLastCalledWith({ filter: 'reply', cursor: null });
  });

  describe('pull to refresh', () => {
    const pull = () => act(async () => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());

    it('polls, then refetches the list once', async () => {
      signIn();
      list().mockResolvedValue(page(NOTIFICATIONS));
      await renderScreen();
      expect(list()).toHaveBeenCalledTimes(1);

      await pull();
      expect(fakeEngine.method('notifications.poll')).toHaveBeenCalledTimes(1);
      expect(list()).toHaveBeenCalledTimes(2);

      // A poll that brought something refetched the lists itself: no second fetch.
      fakeEngine.method('notifications.poll').mockResolvedValue({ added: 1, unread: 1 });
      await pull();
      expect(list()).toHaveBeenCalledTimes(3);
      expect(useToastStore.getState().current).toBeNull();
    });

    it('says so when the refresh fails', async () => {
      signIn();
      list()
        .mockResolvedValueOnce(page(NOTIFICATIONS))
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }));
      await renderScreen();

      await pull();
      expect(useToastStore.getState().current?.message).toBe("Couldn't refresh notifications. Try again.");
      // What was shown stays.
      expect(screen.getByText(/started following you$/)).toBeTruthy();
    });
  });

  it('offers a restart when the engine is down', async () => {
    signIn();
    fakeEngine.setStatus({ state: 'failed' });
    list().mockReturnValue(new Promise(() => undefined));
    await renderScreen();

    expect(screen.getByTestId('notifications-engine-down')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Try again')));
    expect(engineSupervisor.restart).toHaveBeenCalled();
  });

  it('pages, and offers Load More after a failed page', async () => {
    signIn();
    list()
      .mockResolvedValueOnce(page(NOTIFICATIONS.slice(0, 2), true))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }))
      .mockResolvedValueOnce(page(NOTIFICATIONS.slice(3)));
    await renderScreen();

    await act(async () => fireEvent(screen.getByTestId('notifications-list'), 'onEndReached'));
    expect(list()).toHaveBeenLastCalledWith({ filter: 'all', cursor: 'next' });
    await act(async () => fireEvent.press(screen.getByTestId('notifications-load-more')));
    expect(screen.getByText(/started following you$/)).toBeTruthy();
  });

  it('shows a categorized error with Try again', async () => {
    signIn();
    list()
      .mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'UNAVAILABLE' }))
      .mockResolvedValueOnce(page(NOTIFICATIONS));
    await renderScreen();

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Try again')));
    expect(screen.getByText(/started following you$/)).toBeTruthy();
  });

  it('gates a flagged post from someone else (G-14)', async () => {
    signIn();
    const flagged = fixturePost({ id: 'flagged', author: AUTHORS.bob, sensitive: true, content: 'spicy' });
    list().mockResolvedValue(
      page([{ id: 'm1', type: 'mention', actor: AUTHORS.bob, at: minutesAgo(1), read: true, target: { id: 'flagged', kind: 'post' }, preview: flagged }]),
    );
    await renderScreen();

    expect(screen.getByText('NSFW content')).toBeTruthy();
    expect(screen.queryByText('spicy')).toBeNull();
  });
});

describe('the tab badge (NOTIF-03)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  let appStateListener: ((state: AppStateStatus) => void) | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    appStateListener = undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as (state: AppStateStatus) => void;
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
  });
  afterEach(() => jest.useRealTimers());

  it('is hidden and never polls when signed out', async () => {
    const { result } = renderHook(useNotificationsBadge, { wrapper });
    await act(async () => {});
    expect(result.current).toBe(0);
    expect(fakeEngine.method('notifications.poll')).not.toHaveBeenCalled();
  });

  it('polls at once and every 30 s in the foreground, and follows notifications.count', async () => {
    signIn();
    fakeEngine.method('notifications.poll').mockResolvedValue({ added: 0, unread: 4 });
    const { result } = renderHook(useNotificationsBadge, { wrapper });
    await act(async () => {});
    expect(fakeEngine.method('notifications.poll')).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(4);

    await act(async () => jest.advanceTimersByTime(POLL_INTERVAL_MS));
    expect(fakeEngine.method('notifications.poll')).toHaveBeenCalledTimes(2);

    act(() => fakeEngine.emit('notifications.count', { unread: 120 }));
    expect(result.current).toBe(120);

    // In the background nothing runs; back in the foreground it polls at once.
    act(() => appStateListener?.('background'));
    await act(async () => jest.advanceTimersByTime(POLL_INTERVAL_MS * 3));
    expect(fakeEngine.method('notifications.poll')).toHaveBeenCalledTimes(2);
    await act(async () => appStateListener?.('active'));
    expect(fakeEngine.method('notifications.poll')).toHaveBeenCalledTimes(3);
  });

  it('polls the next account at once, even while the last one’s poll is running', async () => {
    signIn();
    let finish: (value: { added: number; unread: number }) => void = () => undefined;
    fakeEngine
      .method('notifications.poll')
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue({ added: 0, unread: 7 });
    const { result } = renderHook(useNotificationsBadge, { wrapper });
    await act(async () => {});

    act(() => useSessionStore.setState({ session: { ...viewer, identityId: AUTHORS.bob.id } }));
    await act(async () => {});
    expect(fakeEngine.method('notifications.poll')).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(7);
    // The old account's answer lands late and changes nothing.
    await act(async () => finish({ added: 0, unread: 0 }));
    expect(result.current).toBe(7);
  });

  it('refetches the lists when a poll brings something new', async () => {
    signIn();
    queryClient.setQueryData(queryKeys.notifications('all'), { pages: [page([])], pageParams: [null] });
    fakeEngine.method('notifications.poll').mockResolvedValue({ added: 2, unread: 2 });
    renderHook(useNotificationsBadge, { wrapper });
    await act(async () => {});
    expect(queryClient.getQueryState(queryKeys.notifications('all'))?.isInvalidated).toBe(true);
  });
});

describe('Settings → Notifications (NOTIF-05)', () => {
  const renderSettings = () =>
    renderRouter({ _layout: Layout, index: NotificationSettingsScreen }, { initialUrl: '/' });

  it('shows the five switches and saves a change', async () => {
    fakeEngine.method('settings.set').mockResolvedValue(settings({ likes: false }));
    renderSettings();
    await act(async () => {});

    expect(screen.getByText('In-app notifications')).toBeTruthy();
    expect(screen.getByText('Yappr checks for new activity while the app is open.')).toBeTruthy();
    for (const label of ['Likes', 'Reposts', 'Replies', 'Follows', 'Mentions']) {
      expect(screen.getByLabelText(label)).toBeChecked();
    }

    await act(async () => fireEvent.press(screen.getByTestId('notification-toggle-likes')));
    expect(fakeEngine.method('settings.set')).toHaveBeenCalledWith({ notificationSettings: { likes: false } });
    expect(screen.getByLabelText('Likes')).not.toBeChecked();
  });

  it('undoes a refused change', async () => {
    fakeEngine.method('settings.set').mockRejectedValue(new Error('nope'));
    renderSettings();
    await act(async () => {});

    await act(async () => fireEvent.press(screen.getByTestId('notification-toggle-follows')));
    expect(screen.getByLabelText('Follows')).toBeChecked();
    expect(useToastStore.getState().current?.message).toBe("Couldn't save the setting. Try again.");
  });
});
