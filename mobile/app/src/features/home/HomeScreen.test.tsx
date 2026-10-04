import type { CapabilitiesDTO, Page, PostDTO, SessionDTO } from '@engine/api';
import NetInfo from '@react-native-community/netinfo';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Alert, RefreshControl, ScrollView } from 'react-native';

import { config } from '~/config';
import { queryKeys } from '~/data/keys';
import { useSignInPrompt } from '~/data/require-auth';
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

/** Holds `requestAnimationFrame` callbacks until {@link frames}`.run()`: the next frame, on demand. */
function holdFrames() {
  const pending = new Map<number, FrameRequestCallback>();
  let next = 0;
  const request = jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    next += 1;
    pending.set(next, callback);
    return next;
  });
  const cancel = jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    if (typeof id === 'number') pending.delete(id);
  });
  return {
    run: () =>
      act(() => {
        const due = [...pending.values()];
        pending.clear();
        due.forEach((callback) => callback(0));
      }),
    restore: () => {
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

async function renderHome() {
  const app = renderRouter({ _layout: Layout, index: HomeScreen, compose: () => null }, { initialUrl: '/' });
  // The pager lays out, then its pages mount.
  act(() => {
    fireEvent(screen.getByTestId('home-pager'), 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } });
  });
  await act(async () => {});
  return app;
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
    // Not on devnet: the older posts are testnet's (agent-isms #17).
    expect(screen.queryByTestId('legacy-link')).toBeNull();
  });

  it('links the older posts at the end of a testnet feed only (agent-isms #17)', async () => {
    const testnet = jest.replaceProperty(config, 'network', 'testnet');
    try {
      home().mockResolvedValue(page([post('p1', 'first post', 1)]));
      await renderHome();

      expect(screen.getByTestId('legacy-link')).toHaveTextContent('Looking for older posts? Open Yappr classic');
      expect(within(screen.getByTestId('feed-end')).getByTestId('legacy-link')).toBeTruthy();
    } finally {
      testnet.restore();
    }
  });

  it('opens the network sheet from the header chip, not an alert (NET-07)', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    home().mockResolvedValue(page([post('p1', 'first post', 1)]));
    await renderHome();

    fireEvent.press(screen.getByTestId('network-chip'));
    expect(alert).not.toHaveBeenCalled();
    expect(screen.getByTestId('network-sheet-status')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('network-sheet-diagnostics')).toBeNull();
  });

  it('asks a signed-out reader to sign in for Following (AUTH-02)', async () => {
    home().mockResolvedValue(page([post('p1', 'first post', 1)]));
    await renderHome();

    fireEvent.press(screen.getByTestId('home-tabs-following'));
    await act(async () => {});

    expect(screen.getByTestId('signed-out-following')).toBeTruthy();
    expect(screen.getByText('See posts from people you follow')).toBeTruthy();
    // "Sign in", as everywhere else in the app (agent-isms #26).
    expect(screen.getByText('Sign in to see posts from people you follow.')).toBeTruthy();
    expect(screen.queryByText(/Log in/)).toBeNull();
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(useHomePrefsStore.getState().accounts['signed-out']?.tab).toBe('following');
    expect(home()).not.toHaveBeenCalledWith(expect.objectContaining({ tab: 'following' }));
  });

  it('opens the sign-in sheet, not the composer, from the FAB signed out (G-8)', async () => {
    useSignInPrompt.setState({ open: false });
    home().mockResolvedValue(page([]));
    const app = await renderHome();

    fireEvent.press(screen.getByTestId('compose-fab'));

    expect(useSignInPrompt.getState().open).toBe(true);
    expect(app.getPathname()).toBe('/');
  });

  it('opens the composer from the FAB signed in', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    home().mockResolvedValue(page([]));
    const app = await renderHome();

    act(() => fireEvent.press(screen.getByTestId('compose-fab')));

    expect(app.getPathname()).toBe('/compose');
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
    expect(screen.queryByTestId('legacy-link')).toBeNull();
  });

  it('never links the older posts from an empty state, testnet included', async () => {
    const testnet = jest.replaceProperty(config, 'network', 'testnet');
    try {
      home().mockResolvedValue(page([]));
      await renderHome();

      expect(screen.getByText('No posts yet')).toBeTruthy();
      expect(screen.queryByTestId('legacy-link')).toBeNull();
    } finally {
      testnet.restore();
    }
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

  it('polls an empty feed for its first posts, from when it was read (FEED-05)', async () => {
    home().mockResolvedValue(page([]));
    checkNew().mockResolvedValue({ count: 1, posts: [post('n1', 'the first post', 0)] });
    await renderHome();

    expect(checkNew()).toHaveBeenCalledWith({ tab: 'forYou', since: expect.any(Date), knownIds: [] });
    expect(screen.getByTestId('new-posts-pill')).toBeTruthy();
  });

  it('reloads the first page for a full new-posts answer, the viewer’s pinned post included (FEED-05)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    home().mockResolvedValue(page([post('p1', 'first post', 60)]));
    const mine = fixturePost({ id: 'mine', content: 'my new post', author: AUTHORS.alice, createdAt: at(0) });
    const others = Array.from({ length: 49 }, (_, i) => post(`n${i}`, `new ${i}`, 1));
    checkNew().mockResolvedValue({ count: 50, posts: [mine, ...others] });
    await renderHome();
    await act(async () => {
      queryClient.setQueryData(queryKeys.post.detail('mine'), mine);
      fakeEngine.emit('content.created', { kind: 'post', id: 'mine', confirmed: false, post: mine });
    });
    expect(home()).toHaveBeenCalledTimes(1);

    await act(async () => fireEvent.press(screen.getByTestId('new-posts-pill')));

    // Not prepended: 49 shown, but the engine's answer was full, so there may be a gap behind it.
    expect(home()).toHaveBeenCalledTimes(2);
  });

  it('never shows Recent’s new posts on Top (FEED-04, FEED-05)', async () => {
    const first = post('p1', 'first post', 5);
    home().mockResolvedValue(page([first]));
    checkNew().mockResolvedValue({ count: 1, posts: [post('n1', 'newest', 0)] });
    await renderHome();
    expect(screen.getByTestId('new-posts-pill')).toBeTruthy();

    // Top's newest is the same post, so the cached Recent answer has the same key.
    fireEvent(screen.getByTestId('home-sort'), 'change', { nativeEvent: { selectedSegmentIndex: 1 } });
    await act(async () => {});

    expect(home()).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'top' }));
    expect(screen.queryByTestId('new-posts-pill')).toBeNull();
  });

  it('pages on when the pages read so far show nothing (FEED-07)', async () => {
    home().mockResolvedValueOnce(page([], true));
    home().mockResolvedValueOnce(page([post('p2', 'deeper post', 6)]));
    await renderHome();

    expect(screen.queryByTestId('feed-empty')).toBeNull();
    await act(async () => fireEvent.press(screen.getByTestId('feed-load-more')));

    expect(screen.getByText('deeper post')).toBeTruthy();
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

  it('never shows another account’s pinned post after a switch (PD-3)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    home().mockResolvedValue(page([post('p1', 'first post', 5)]));
    await renderHome();

    const mine = fixturePost({ id: 'mine', content: 'my new post', author: AUTHORS.alice, createdAt: at(0) });
    await act(async () => {
      queryClient.setQueryData(queryKeys.post.detail('mine'), mine);
      fakeEngine.emit('content.created', { kind: 'post', id: 'mine', confirmed: false, post: mine });
    });
    expect(screen.getByText('my new post')).toBeTruthy();

    // Switch to Bob; the old account's post comes back into the cache (opened, or a late event).
    await act(async () => {
      useSessionStore.setState({ status: 'signed-in', session: { ...viewer, identityId: AUTHORS.bob.id }, accounts: [] });
    });
    const late = fixturePost({ id: 'late', content: 'alice late post', author: AUTHORS.alice, createdAt: at(0) });
    await act(async () => {
      queryClient.setQueryData(queryKeys.post.detail('mine'), mine);
      queryClient.setQueryData(queryKeys.post.detail('late'), late);
      fakeEngine.emit('content.created', { kind: 'post', id: 'late', confirmed: false, post: late });
    });

    expect(screen.queryByText('my new post')).toBeNull();
    expect(screen.queryByText('alice late post')).toBeNull();
    expect(screen.getByText('first post')).toBeTruthy();
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

  it('opens on Following when a cold launch restores it, though the pager could not scroll before its pages had their width (FEED-03, D-L2a-004)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    useHomePrefsStore.setState({ accounts: { [viewer.identityId]: { tab: 'following', sort: 'recent', window: 'all' } } });
    home().mockResolvedValue(page([post('p1', 'a followed post', 1)]));
    // Android's pager: a scroll goes no further than the content laid out when it runs.
    let laidOut = 0;
    let offset = 0;
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(function (
      this: ScrollView,
      options?: { x?: number } | number,
    ) {
      if (this.props.testID !== 'home-pager' || typeof options !== 'object') return;
      offset = Math.min(options.x ?? 0, Math.max(laidOut - 400, 0));
    });
    const frames = holdFrames();
    try {
      await renderHome();
      // The pages got their width with the scroll to Following, before the content had it.
      expect(offset).toBe(0);

      laidOut = 800;
      act(() => {
        fireEvent(screen.getByTestId('home-pager'), 'contentSizeChange', 800, 800);
      });
      frames.run();
      expect(offset).toBe(400);
      expect(screen.getByText('a followed post')).toBeTruthy();
      // A height change alone (a banner) leaves the reader's page alone.
      offset = 123;
      act(() => {
        fireEvent(screen.getByTestId('home-pager'), 'contentSizeChange', 800, 760);
      });
      frames.run();
      expect(offset).toBe(123);
    } finally {
      scrollTo.mockRestore();
      frames.restore();
    }
  });

  it('settles on the restored tab on the next frame when the first scroll reached the pager before its content mounted (D-L2a-004)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    useHomePrefsStore.setState({ accounts: { [viewer.identityId]: { tab: 'following', sort: 'recent', window: 'all' } } });
    home().mockResolvedValue(page([post('p1', 'a followed post', 1)]));
    let laidOut = 0;
    let offset = 0;
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(function (
      this: ScrollView,
      options?: { x?: number } | number,
    ) {
      if (this.props.testID !== 'home-pager' || typeof options !== 'object') return;
      offset = Math.min(options.x ?? 0, Math.max(laidOut - 400, 0));
    });
    const frames = holdFrames();
    try {
      await renderHome();
      // Android (Fabric): the commit's layout event reaches JS, whose scroll runs before that commit is mounted.
      act(() => {
        fireEvent(screen.getByTestId('home-pager'), 'contentSizeChange', 800, 800);
      });
      expect(offset).toBe(0);

      // The next frame comes after the mount.
      laidOut = 800;
      frames.run();
      expect(offset).toBe(400);
    } finally {
      scrollTo.mockRestore();
      frames.restore();
    }
  });

  it('leaves the pager to the reader who starts swiping before the next frame', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    useHomePrefsStore.setState({ accounts: { [viewer.identityId]: { tab: 'following', sort: 'recent', window: 'all' } } });
    home().mockResolvedValue(page([post('p1', 'a followed post', 1)]));
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
    const frames = holdFrames();
    try {
      await renderHome();
      act(() => {
        fireEvent(screen.getByTestId('home-pager'), 'contentSizeChange', 800, 800);
      });
      const calls = scrollTo.mock.calls.length;
      fireEvent(screen.getByTestId('home-pager'), 'scrollBeginDrag');
      frames.run();
      expect(scrollTo).toHaveBeenCalledTimes(calls);
    } finally {
      scrollTo.mockRestore();
      frames.restore();
    }
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

  it('shows the fresh first page when the list reaches its end during a refresh (FEED-06, D-L1a-003)', async () => {
    home().mockResolvedValueOnce(page([post('p1', 'old first post', 5)], true));
    home().mockResolvedValueOnce(page([post('p2', 'second page post', 6)], true));
    await renderHome();
    await act(async () => {
      fireEvent(screen.getByTestId('feed-list-forYou'), 'endReached');
    });
    expect(screen.getByText('second page post')).toBeTruthy();

    // The refresh trims the list to its first page, which brings the end near: the list asks for more mid-refresh.
    let answer!: (value: Page<PostDTO>) => void;
    home().mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    home().mockResolvedValue(page([post('p3', 'later page post', 7)]));
    let refreshed!: Promise<void>;
    act(() => {
      refreshed = screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
    });
    await act(async () => {});
    await act(async () => {
      fireEvent(screen.getByTestId('feed-list-forYou'), 'endReached');
    });
    await act(async () => {
      answer(page([post('p0', 'brand new post', 0), post('p1', 'old first post', 5)], true));
      await refreshed;
    });

    expect(screen.getByText('brand new post')).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();
  });

  it('says a read that failed without a code on the way to Dash Platform is unavailable (G-11)', async () => {
    home().mockRejectedValue(new Error('Failed to prefetch quorums: HTTP request error: error sending request'));
    await renderHome();

    expect(screen.getByTestId('feed-error')).toBeTruthy();
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
  });

  it('says a read that failed offline is a network error (G-1, G-11)', async () => {
    jest.mocked(NetInfo.useNetInfo).mockReturnValue({ isConnected: false } as ReturnType<typeof NetInfo.useNetInfo>);
    home().mockRejectedValue(new Error('boom'));
    await renderHome();

    expect(screen.getByTestId('feed-error')).toBeTruthy();
    expect(screen.getByText(/^Network error/)).toBeTruthy();
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
    // The "Couldn't connect" banner offers the same (NET-01).
    expect(screen.getByTestId('engine-banner')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('feed-engine-down')).getByText('Try again'));
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
