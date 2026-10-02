import type { CapabilitiesDTO, Page, PostDTO, SessionDTO } from '@engine/api';
import NetInfo from '@react-native-community/netinfo';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { RefreshControl } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { engineModule, fakeEngine } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { AUTHORS, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { useHomePrefsStore } from './home-prefs';
import { HomeScreen, RESTORE_WAIT_MS } from './HomeScreen';
import { resetOwnPosts, useOwnPosts } from './own-posts';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

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

const CAPABILITIES = {
  rankings: true,
  windowedRankings: true,
  repostsAreQuotes: true,
  repostable: { post: true, reply: true },
  bookmarkable: { post: true, reply: false },
} as CapabilitiesDTO;

const viewer: SessionDTO = {
  identityId: AUTHORS.alice.id,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
const post = (id: string, content: string, minutesAgo: number) =>
  fixturePost({ id, content, createdAt: at(minutesAgo) }) as PostDTO;
const page = (items: PostDTO[], hasMore = false): Page<PostDTO> => ({
  items,
  cursor: hasMore ? 'next' : null,
  hasMore,
});

// The fake supervisor has no restart; Home's engine-down state calls it.
const restart = jest.fn();
Object.assign(engineModule.engineSupervisor, { restart });

const home = () => fakeEngine.method('feed.home');
const checkNew = () => fakeEngine.method('feed.checkNew');

function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack />
    </QueryClientProvider>
  );
}

async function renderHome() {
  renderRouter({ _layout: Layout, index: HomeScreen }, { initialUrl: '/' });
  // The pager lays out, then its pages mount.
  act(() => {
    fireEvent(screen.getByTestId('home-pager'), 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } });
  });
  await act(async () => {});
}

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  // No UI-level retry, so a failed read shows at once.
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterAll(() => queryClient.clear());
// After the tree unmounts: a read left pending (the skeleton test) otherwise keeps Jest from exiting.
afterEach(() => {
  queryClient.clear();
  resetOwnPosts();
  fakeEngine.setStatus({ state: 'ready' });
});

beforeEach(() => {
  jest.useRealTimers();
  fakeEngine.reset();
  queryClient.clear();
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: CAPABILITIES } });
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
  useHomePrefsStore.setState({ accounts: {} });
  restart.mockClear();
  useToastStore.setState({ current: null });
  checkNew().mockResolvedValue({ count: 0, posts: [] });
  jest.mocked(NetInfo.useNetInfo).mockReturnValue({ isConnected: true } as ReturnType<typeof NetInfo.useNetInfo>);
});

describe('Home', () => {
  it('shows For You, with the header chip and the end of the list (FEED-01)', async () => {
    home().mockResolvedValue(page([post('p1', 'first post', 1), post('p2', 'second post', 2)]));
    await renderHome();

    expect(home()).toHaveBeenCalledWith({ tab: 'forYou', sort: 'recent', window: 'all', cursor: null });
    expect(screen.getByText('first post')).toBeTruthy();
    expect(screen.getByText('second post')).toBeTruthy();
    expect(screen.getByTestId('network-chip')).toBeTruthy();
    expect(screen.getByText("You've reached the end.")).toBeTruthy();
    expect(screen.getByTestId('compose-fab')).toBeTruthy();
  });

  it('asks a signed-out reader to sign in for Following (AUTH-02)', async () => {
    home().mockResolvedValue(page([post('p1', 'first post', 1)]));
    await renderHome();

    fireEvent.press(screen.getByTestId('home-tabs-following'));
    await act(async () => {});

    expect(screen.getByText('See posts from people you follow')).toBeTruthy();
    expect(screen.getByTestId('following-sign-in')).toBeTruthy();
    expect(useHomePrefsStore.getState().accounts['signed-out']?.tab).toBe('following');
    expect(home()).not.toHaveBeenCalledWith(expect.objectContaining({ tab: 'following' }));
  });

  it('reads Following when signed in, with its empty state (FEED-02)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    useHomePrefsStore.setState({ accounts: { [viewer.identityId]: { tab: 'following', sort: 'recent', window: 'all' } } });
    home().mockResolvedValue(page([]));
    await renderHome();

    expect(home()).toHaveBeenCalledWith(expect.objectContaining({ tab: 'following', sort: 'recent' }));
    expect(screen.getByText('Your following feed is empty')).toBeTruthy();
    expect(screen.getByText('Explore')).toBeTruthy();
  });

  it('shows post skeletons and "Connecting…" while the engine boots with nothing cached (FEED-01)', async () => {
    fakeEngine.setStatus({ state: 'booting' });
    home().mockReturnValue(new Promise(() => undefined));
    await renderHome();

    expect(screen.getAllByTestId('post-skeleton')).toHaveLength(4);
    expect(screen.getByText('Connecting to Dash Platform…')).toBeTruthy();
  });

  it('shows the empty For You state', async () => {
    home().mockResolvedValue(page([]));
    await renderHome();

    expect(screen.getByText('No posts yet')).toBeTruthy();
    expect(screen.getByText('Be the first to share something!')).toBeTruthy();
  });

  it('shows the error state with nothing cached, and retries (G-11)', async () => {
    home().mockRejectedValue(Object.assign(new Error('down'), { code: 'ENGINE_UNAVAILABLE' }));
    await renderHome();

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();

    home().mockResolvedValue(page([post('p1', 'back again', 1)]));
    await act(async () => fireEvent.press(screen.getByText('Try again')));
    expect(screen.getByText('back again')).toBeTruthy();
  });

  it('switches to Top and its window where the contract ranks likes (FEED-04)', async () => {
    home().mockResolvedValue(page([post('p1', 'first post', 1)]));
    await renderHome();

    // Jest renders iOS: the native segmented control.
    const segment = (id: string, index: number) =>
      fireEvent(screen.getByTestId(id), 'change', { nativeEvent: { selectedSegmentIndex: index } });
    segment('home-sort', 1);
    await act(async () => {});
    expect(home()).toHaveBeenLastCalledWith({ tab: 'forYou', sort: 'top', window: 'all', cursor: null });

    segment('home-window', 0);
    await act(async () => {});
    expect(home()).toHaveBeenLastCalledWith({ tab: 'forYou', sort: 'top', window: 'today', cursor: null });
  });

  it('has no sort control on a contract without rankings (v2)', async () => {
    fakeEngine.setStatus({ info: { capabilities: { ...CAPABILITIES, rankings: false } } });
    useHomePrefsStore.setState({ accounts: { 'signed-out': { tab: 'forYou', sort: 'top', window: 'all' } } });
    home().mockResolvedValue(page([post('p1', 'first post', 1)]));
    await renderHome();

    expect(screen.queryByTestId('home-sort')).toBeNull();
    expect(home()).toHaveBeenCalledWith(expect.objectContaining({ sort: 'recent' }));
  });

  it('shows the new-posts pill and inserts the posts on tap (FEED-05)', async () => {
    const first = post('p1', 'first post', 5);
    home().mockResolvedValue(page([first]));
    checkNew().mockResolvedValue({ count: 2, posts: [post('n1', 'newest', 0), post('n2', 'newer', 1)] });
    await renderHome();

    expect(checkNew()).toHaveBeenCalledWith({ tab: 'forYou', since: first.createdAt, knownIds: ['p1'] });
    expect(screen.getByText('Show 2 new posts')).toBeTruthy();
    expect(screen.queryByText('newest')).toBeNull();

    checkNew().mockResolvedValue({ count: 0, posts: [] });
    await act(async () => fireEvent.press(screen.getByTestId('new-posts-pill')));

    expect(screen.getByText('newest')).toBeTruthy();
    expect(screen.getByText('newer')).toBeTruthy();
    expect(screen.queryByTestId('new-posts-pill')).toBeNull();
  });

  it('puts the viewer’s new post on top of For You (PD-3)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    home().mockResolvedValue(page([post('p1', 'first post', 5)]));
    await renderHome();

    const mine = fixturePost({ id: 'mine', content: 'my new post', author: AUTHORS.alice, createdAt: at(0) });
    await act(async () => {
      // The data layer seeds the detail the pin renders from (sync.ts).
      queryClient.setQueryData(queryKeys.post.detail('mine'), mine);
      fakeEngine.emit('content.created', { kind: 'post', id: 'mine', confirmed: false, post: mine });
    });

    expect(screen.getByText('my new post')).toBeTruthy();
    expect(useOwnPosts.getState().ids).toEqual(['mine']);
  });

  it('polls for new posts from the feed’s newest post, not the viewer’s pinned one', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    const first = post('p1', 'first post', 5);
    home().mockResolvedValue(page([first]));
    await renderHome();

    const mine = fixturePost({ id: 'mine', content: 'my new post', author: AUTHORS.alice, createdAt: at(0) });
    checkNew().mockResolvedValue({ count: 1, posts: [mine] });
    await act(async () => {
      queryClient.setQueryData(queryKeys.post.detail('mine'), mine);
      fakeEngine.emit('content.created', { kind: 'post', id: 'mine', confirmed: false, post: mine });
    });

    expect(checkNew()).toHaveBeenLastCalledWith({ tab: 'forYou', since: first.createdAt, knownIds: ['p1'] });
    // The viewer's own post is already on screen: no pill for it.
    expect(screen.queryByTestId('new-posts-pill')).toBeNull();
  });

  it('renders the restored tab when the account changes to one saved on Following (FEED-03)', async () => {
    useHomePrefsStore.setState({ accounts: { [viewer.identityId]: { tab: 'following', sort: 'recent', window: 'all' } } });
    home().mockResolvedValue(page([post('p1', 'a followed post', 1)]));
    await renderHome();

    await act(async () => {
      useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    });

    expect(home()).toHaveBeenCalledWith(expect.objectContaining({ tab: 'following' }));
    expect(screen.getByTestId('feed-following')).toBeTruthy();
  });

  it('keeps the pages read after a failed refresh (FEED-06)', async () => {
    home().mockResolvedValueOnce(page([post('p1', 'first post', 5)], true));
    home().mockResolvedValueOnce(page([post('p2', 'second page post', 6)]));
    await renderHome();
    await act(async () => {
      fireEvent(screen.getByTestId('feed-list-forYou'), 'endReached');
    });
    expect(screen.getByText('second page post')).toBeTruthy();

    home().mockRejectedValue(Object.assign(new Error('down'), { code: 'TIMEOUT' }));
    await act(async () => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());

    expect(screen.getByText('second page post')).toBeTruthy();
    expect(useToastStore.getState().current?.message).toMatch(/temporarily unavailable/);
  });

  it('keeps polling for new posts after a failed next page (FEED-05, FEED-07)', async () => {
    const first = post('p1', 'first post', 5);
    home().mockResolvedValueOnce(page([first], true));
    home().mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'TIMEOUT' }));
    await renderHome();
    await act(async () => {
      fireEvent(screen.getByTestId('feed-list-forYou'), 'endReached');
    });

    expect(screen.getByTestId('feed-load-more')).toBeTruthy();
    // The feed is in status `error` with its pages kept; the polling stays on.
    const poll = queryClient.getQueryCache().find({ queryKey: queryKeys.feed.newPosts('forYou', first.createdAt.getTime()) });
    expect(poll?.isDisabled()).toBe(false);
  });

  it('offers a restart when the engine has failed with nothing cached (G-11)', async () => {
    fakeEngine.setStatus({ state: 'failed' });
    useSessionStore.setState({ status: 'unknown', session: null, accounts: [] });
    await renderHome();

    expect(screen.getByTestId('feed-engine-down')).toBeTruthy();
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
    fireEvent.press(screen.getByText('Try again'));
    expect(restart).toHaveBeenCalled();
  });

  it('reads For You signed out when the session restore stalls with the engine up', async () => {
    jest.useFakeTimers();
    useSessionStore.setState({ status: 'unknown', session: null, accounts: [] });
    home().mockResolvedValue(page([post('p1', 'first post', 1)]));
    await renderHome();
    expect(home()).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(RESTORE_WAIT_MS);
    });
    expect(home()).toHaveBeenCalledWith(expect.objectContaining({ tab: 'forYou' }));
    expect(screen.getByText('first post')).toBeTruthy();

    // The session arriving late refetches, for the viewer's marks.
    await act(async () => {
      useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    });
    expect(home()).toHaveBeenCalledTimes(2);
  });

  it('shows the offline banner, and a refresh offline ends at once (G-1, FEED-06)', async () => {
    jest.mocked(NetInfo.useNetInfo).mockReturnValue({ isConnected: false } as ReturnType<typeof NetInfo.useNetInfo>);
    home().mockResolvedValue(page([post('p1', 'first post', 1)]));
    await renderHome();

    expect(screen.getByTestId('offline-banner')).toBeTruthy();
    expect(checkNew()).not.toHaveBeenCalled();

    act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());
    expect(useToastStore.getState().current?.message).toBe("You're offline. Showing saved posts.");
    expect(home()).toHaveBeenCalledTimes(1);
  });
});
