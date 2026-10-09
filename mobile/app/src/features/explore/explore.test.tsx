import type { CapabilitiesDTO, Page, PostDTO, RankedUserDTO, SessionDTO, TagDTO, UserSummaryDTO } from '@engine/api';
import NetInfo from '@react-native-community/netinfo';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { render } from '@testing-library/react-native';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { useState } from 'react';
import { ActionSheetIOS, RefreshControl, Text } from 'react-native';

import HashtagRoute from '~/app/(tabs)/(home,explore,notifications,messages,profile)/hashtag/[tag]';
import SearchResultsRoute from '~/app/(tabs)/(explore)/explore/search/[kind]';
import SearchRoute from '~/app/(tabs)/(explore)/explore/search/index';
import { queryKeys } from '~/data/keys';
import { UNAVAILABLE_MESSAGE } from '~/data/read-error';
import { startReadRetry } from '~/data/read-retry';
import { useSignInPrompt } from '~/data/require-auth';
import { useSessionStore } from '~/data/session';
import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { waitOutRetry, withoutRetry, withProductionRetry } from '~/data/testing/production-retry';
import { queryClient } from '~/state/query-client';
import { AUTHORS, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { ExploreScreen } from './ExploreScreen';
import { useExplorePrefs } from './explore-prefs';
import { SearchField } from './SearchField';
import { addRecent, clearRecent, getRecent, startRecentSearchCleanup } from './recent-searches';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

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

const DEV = {
  rankings: true,
  windowedRankings: true,
  prefixRankings: true,
  repostsAreQuotes: true,
  repostable: { post: true, reply: true },
  bookmarkable: { post: true, reply: false },
} as CapabilitiesDTO;
const V2 = { ...DEV, rankings: false, windowedRankings: false, prefixRankings: false } as CapabilitiesDTO;

const viewer: SessionDTO = {
  identityId: AUTHORS.alice.id,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const tag = (name: string, count: number, countKind: TagDTO['countKind'] = 'likes'): TagDTO => ({
  tag: name,
  kind: name.endsWith('_cashtag') ? 'cashtag' : 'hashtag',
  display: name.endsWith('_cashtag') ? `$${name.replace('_cashtag', '').toUpperCase()}` : `#${name}`,
  count,
  countKind,
});
const user = (key: keyof typeof AUTHORS, extra: Partial<UserSummaryDTO> = {}): UserSummaryDTO => ({
  ...AUTHORS[key],
  ...extra,
});
const post = (id: string, content: string) => fixturePost({ id, content }) as PostDTO;
const page = (items: PostDTO[], hasMore = false): Page<PostDTO> => ({ items, cursor: hasMore ? 'next' : null, hasMore });

function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack />
    </QueryClientProvider>
  );
}

const Blank = () => null;

async function renderAt(url: string) {
  const app = renderRouter(
    {
      _layout: Layout,
      'explore/index': ExploreScreen,
      'explore/search/index': SearchRoute,
      'explore/search/[kind]': SearchResultsRoute,
      'hashtag/[tag]': HashtagRoute,
      'user/[id]': Blank,
      'post/[id]': Blank,
    },
    { initialUrl: url },
  );
  await act(async () => {});
  return app;
}

/** Waits out the search debounce (300 ms) and the reads it starts. */
async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
  await act(async () => {});
}

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterEach(() => {
  queryClient.clear();
  withoutRetry();
  jest.useRealTimers();
});

beforeEach(() => {
  fakeEngine.reset();
  queryClient.clear();
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: DEV } });
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
  useExplorePrefs.setState({ segment: 'trending', trendingWindow: 'today', topWindow: 'all' });
  useSignInPrompt.setState({ open: false });
  useToastStore.setState({ current: null });
  clearRecent('signed-out');
  clearRecent(viewer.identityId);
  jest.mocked(NetInfo.useNetInfo).mockReturnValue({ isConnected: true } as ReturnType<typeof NetInfo.useNetInfo>);
});


describe('SearchField', () => {
  it('hands the focus on at the first Clear after it opened, before its focus was reported (QA rc12 c9)', () => {
    function Search() {
      const [text, setText] = useState('');
      return (
        <>
          <SearchField value={text} onChangeText={setText} autoFocus />
          <Text testID="held">{text}</Text>
        </>
      );
    }
    render(<Search />);
    const input = () => screen.getByTestId('search-input');
    // Typed straight away, fast: abc, three deletes, abc, rendered once; no focus event yet.
    const late = input().props.onChangeText as (text: string) => void;
    act(() => {
      for (const text of ['a', 'ab', 'abc', 'ab', 'a', '', 'a', 'ab', 'abc']) fireEvent.changeText(input(), text);
    });
    fireEvent.press(screen.getByTestId('search-clear'));
    // A fresh input (the old one's text can't survive a native clear it drops), taking the focus.
    expect(input()).toHaveDisplayValue('');
    expect(input().props.autoFocus).toBe(true);
    expect(screen.queryByTestId('search-clear')).toBeNull();
    act(() => late('abcz'));
    expect(screen.getByTestId('held')).toHaveTextContent('');
    fireEvent.changeText(input(), 'z');
    expect(screen.getByTestId('held')).toHaveTextContent('z');
  });

  it('ignores a late event of the input Clear replaced, and keeps what is typed or pasted after (QA rc7 review)', () => {
    function Search() {
      const [text, setText] = useState('');
      return (
        <>
          <SearchField value={text} onChangeText={setText} />
          <Text testID="held">{text}</Text>
        </>
      );
    }
    render(<Search />);
    const input = () => screen.getByTestId('search-input');
    fireEvent(input(), 'focus');
    fireEvent.changeText(input(), 'abc');
    const late = input().props.onChangeText as (text: string) => void;
    fireEvent.press(screen.getByTestId('search-clear'));
    // A keystroke the old input reports after Clear (or after a native clear it dropped).
    act(() => late('abcx'));
    expect(screen.getByTestId('held')).toHaveTextContent('');
    expect(input()).toHaveDisplayValue('');
    expect(screen.queryByTestId('search-clear')).toBeNull();
    // The fresh input took over: kept hidden only until it has the focus.
    expect(screen.getByTestId('search-input').props.autoFocus).toBe(true);
    fireEvent(input(), 'focus');
    fireEvent.changeText(input(), 'd');
    expect(screen.getByTestId('held')).toHaveTextContent('d');
    fireEvent.changeText(input(), 'abc pasted');
    expect(screen.getByTestId('held')).toHaveTextContent('abc pasted');
    expect(input()).toHaveDisplayValue('abc pasted');
  });

  it('clears on Clear even right after a delete and retype that rendered once (QA rc7 review)', () => {
    // a, '', a reach the field before the search's one render with "a": a Clear's '' is not a late echo.
    function Search() {
      const [text, setText] = useState('');
      return (
        <>
          <SearchField value={text} onChangeText={setText} />
          <Text testID="held">{text}</Text>
        </>
      );
    }
    render(<Search />);
    const input = () => screen.getByTestId('search-input');
    fireEvent(input(), 'focus');
    act(() => {
      for (const text of ['a', '', 'a']) fireEvent.changeText(input(), text);
    });
    expect(input()).toHaveDisplayValue('a');
    fireEvent.press(screen.getByTestId('search-clear'));
    expect(input()).toHaveDisplayValue('');
    expect(screen.getByTestId('held')).toHaveTextContent('');
    expect(screen.queryByTestId('search-clear')).toBeNull();
  });
});

describe('Explore', () => {
  it('ranks trending tags with their like counts, on the 24h window (EXPL-02)', async () => {
    fakeEngine.method('explore.trending').mockResolvedValue([tag('mobile', 6), tag('dash_cashtag', 1)]);
    const app = await renderAt('/explore');

    expect(fakeEngine.method('explore.trending')).toHaveBeenCalledWith({ window: 'today' });
    expect(screen.getByText('#mobile')).toBeTruthy();
    expect(screen.getByText('6 likes')).toBeTruthy();
    expect(screen.getByText('$DASH')).toBeTruthy();
    expect(screen.getByText('1 like')).toBeTruthy();
    expect(screen.getByTestId('compose-fab')).toBeTruthy();

    fireEvent.press(screen.getByTestId('trending-dash_cashtag'));
    await act(async () => {});
    expect(app.getPathname()).toBe('/hashtag/dash_cashtag');
  });

  it('shows only Trending, counting posts, on v2 (EXPL-01)', async () => {
    fakeEngine.setStatus({ info: { capabilities: V2 } });
    fakeEngine.method('explore.trending').mockResolvedValue([tag('dash', 12, 'posts')]);
    await renderAt('/explore');

    expect(fakeEngine.method('explore.trending')).toHaveBeenCalledWith({ window: 'all' });
    expect(screen.queryByTestId('explore-segments')).toBeNull();
    expect(screen.queryByTestId('explore-trending-window')).toBeNull();
    expect(screen.getByText('12 posts')).toBeTruthy();
  });

  it('says when nothing is trending, and offers a retry when the read fails', async () => {
    fakeEngine.method('explore.trending').mockResolvedValueOnce([]);
    await renderAt('/explore');
    expect(screen.getByText('No trending tags yet')).toBeTruthy();
    expect(screen.getByText('Post with #hashtags or $cashtags to see them here!')).toBeTruthy();

    fakeEngine.method('explore.trending').mockRejectedValue(Object.assign(new Error('down'), { code: 'UNAVAILABLE' }));
    act(() => useExplorePrefs.setState({ trendingWindow: 'all' }));
    await act(async () => {});
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('lists Top posts on the post window (EXPL-03)', async () => {
    useExplorePrefs.setState({ segment: 'top' });
    fakeEngine.method('explore.topPosts').mockResolvedValue([post('t1', 'most liked post')]);
    await renderAt('/explore');

    expect(fakeEngine.method('explore.topPosts')).toHaveBeenCalledWith({ window: 'all' });
    expect(screen.getByText('most liked post')).toBeTruthy();
  });

  // A post deleted on another device must show as deleted after a pull to refresh,
  // not wait out the engine's minute-long Top posts page (RC16-I-04).
  it('reads Top posts afresh on a pull to refresh, retry included, and only then', async () => {
    withProductionRetry();
    useExplorePrefs.setState({ segment: 'top' });
    const topPosts = fakeEngine.method('explore.topPosts');
    topPosts.mockResolvedValue([post('t1', 'stale post')]);
    await renderAt('/explore');
    expect(topPosts).toHaveBeenLastCalledWith({ window: 'all' });

    // The refresh's first read fails; TanStack's retry must read afresh too.
    topPosts.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'TIMEOUT' }));
    topPosts.mockResolvedValue([post('t2', 'fresh post')]);
    const calls = topPosts.mock.calls.length;
    await act(async () => {
      screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
    });
    await waitOutRetry();
    expect(topPosts.mock.calls.slice(calls)).toEqual([[{ window: 'all', refresh: true }], [{ window: 'all', refresh: true }]]);
    expect(screen.getByText('fresh post')).toBeTruthy();

    // Any other read after it (here a plain refetch) keeps the engine's page.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.explore.topPosts('all') });
    });
    expect(fakeEngine.method('explore.topPosts')).toHaveBeenLastCalledWith({ window: 'all' });
  });

  it('ranks creators with follow buttons; signed out, Follow asks to sign in (EXPL-04, G-8)', async () => {
    useExplorePrefs.setState({ segment: 'creators' });
    const ranked: RankedUserDTO[] = [
      { user: user('bob'), count: 2400, by: 'likes' },
      { user: user('carol'), count: 3, by: 'followers' },
    ];
    fakeEngine.method('explore.topCreators').mockResolvedValue(ranked);
    await renderAt('/explore');

    expect(screen.getByText('Top creators by likes received')).toBeTruthy();
    expect(screen.getByText('Most followed')).toBeTruthy();
    expect(screen.getByText('2.4K likes')).toBeTruthy();
    expect(screen.getByText('3 followers')).toBeTruthy();
    expect(fakeEngine.method('graph.status')).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('creator-likes-bob-follow'));
    expect(useSignInPrompt.getState().open).toBe(true);
  });

  it('reads the viewer’s follows for the leaderboard and follows optimistically', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    useExplorePrefs.setState({ segment: 'creators' });
    fakeEngine.method('explore.topCreators').mockResolvedValue([
      { user: user('alice'), count: 9, by: 'likes' },
      { user: user('bob'), count: 5, by: 'likes' },
      { user: user('carol'), count: 4, by: 'likes' },
    ]);
    fakeEngine.method('graph.status').mockResolvedValue({ [AUTHORS.bob.id]: false, [AUTHORS.carol.id]: true });
    fakeEngine.method('graph.follow').mockResolvedValue(ticket({ op: 'follow' }));
    await renderAt('/explore');

    // The viewer's own row has no button; the others show what the viewer does.
    expect(fakeEngine.method('graph.status')).toHaveBeenCalledWith([AUTHORS.bob.id, AUTHORS.carol.id]);
    expect(screen.queryByTestId('creator-likes-alice-follow')).toBeNull();
    expect(screen.getByLabelText('Following Carol')).toBeTruthy();

    fireEvent.press(screen.getByTestId('creator-likes-bob-follow'));
    await act(async () => {});
    expect(fakeEngine.method('graph.follow')).toHaveBeenCalledWith(AUTHORS.bob.id);
    expect(screen.getByLabelText('Following Bob Builder')).toBeTruthy();
  });

  it('asks before unfollowing (PD-6)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    useExplorePrefs.setState({ segment: 'creators' });
    fakeEngine.method('explore.topCreators').mockResolvedValue([{ user: user('carol'), count: 4, by: 'likes' }]);
    fakeEngine.method('graph.status').mockResolvedValue({ [AUTHORS.carol.id]: true });
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => undefined);
    await renderAt('/explore');

    fireEvent.press(screen.getByTestId('creator-likes-carol-follow'));
    expect(sheet).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Unfollow @carol?', options: ['Unfollow', 'Cancel'] }),
      expect.any(Function),
    );
    expect(fakeEngine.method('graph.unfollow')).not.toHaveBeenCalled();
    sheet.mockRestore();
  });

  it('opens search from the field', async () => {
    fakeEngine.method('explore.trending').mockResolvedValue([]);
    const app = await renderAt('/explore');

    fireEvent.press(screen.getByTestId('explore-search'));
    await act(async () => {});
    expect(app.getPathname()).toBe('/explore/search');
    expect(screen.getByText('Find people, hashtags and recent posts.')).toBeTruthy();
  });
});

describe('Search', () => {
  beforeEach(() => jest.useFakeTimers());

  it('below 3 characters searches posts and the trending tags, not people (EXPL-05)', async () => {
    fakeEngine.method('explore.searchPosts').mockResolvedValue([post('s1', 'about dash')]);
    fakeEngine.method('explore.trending').mockResolvedValue([tag('dash', 5), tag('mobile', 3), tag('dash_cashtag', 2)]);
    await renderAt('/explore/search');

    fireEvent.changeText(screen.getByTestId('search-input'), 'da');
    expect(fakeEngine.method('explore.searchPosts')).not.toHaveBeenCalled();
    await settle();

    expect(fakeEngine.method('explore.searchPosts')).toHaveBeenCalledWith('da');
    expect(fakeEngine.method('explore.searchUsers')).not.toHaveBeenCalled();
    // The engine's tag search starts at 3 characters; shorter queries match the all-time trending tags.
    expect(fakeEngine.method('explore.searchHashtags')).not.toHaveBeenCalled();
    expect(fakeEngine.method('explore.trending')).toHaveBeenCalledWith({ window: 'all' });
    expect(screen.getByText('#dash')).toBeTruthy();
    expect(screen.getByText('$DASH')).toBeTruthy();
    expect(screen.queryByText('#mobile')).toBeNull();
    expect(screen.getByText('Type at least 3 characters to search for people')).toBeTruthy();
    expect(screen.getByText('about dash')).toBeTruthy();
  });

  it('resolves a pasted identity id, skipping an id nothing is known about', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    const bob = user('bob', { username: null });
    const id = bob.id.padEnd(44, 'x').slice(0, 44).replace(/[0OIl]/g, 'x');
    fakeEngine.method('explore.searchUsers').mockResolvedValue([]);
    fakeEngine.method('explore.searchHashtags').mockResolvedValue([]);
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    fakeEngine.method('graph.status').mockResolvedValue({});
    fakeEngine
      .method('profiles.batch')
      .mockResolvedValueOnce([{ ...bob, id }])
      .mockResolvedValueOnce([{ ...bob, id, displayName: `User ${id.slice(-6)}` }]);
    await renderAt(`/explore/search?q=${id}`);
    await settle();

    expect(fakeEngine.method('profiles.batch')).toHaveBeenCalledWith([id]);
    expect(screen.getByText('Bob Builder')).toBeTruthy();

    // An id with no name, profile name or bio (a typo) finds no one.
    queryClient.clear();
    fireEvent.changeText(screen.getByTestId('search-input'), `${id} `);
    await settle();
    expect(screen.queryByText(`User ${id.slice(-6)}`)).toBeNull();
    expect(screen.getByText(`No results for "${id}"`)).toBeTruthy();
  });

  it('keeps the name results when the identity lookup fails', async () => {
    const id = AUTHORS.carol.id.padEnd(44, 'x').slice(0, 44).replace(/[0OIl]/g, 'x');
    fakeEngine.method('explore.searchUsers').mockResolvedValue([user('carol')]);
    fakeEngine.method('explore.searchHashtags').mockResolvedValue([]);
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    fakeEngine.method('profiles.batch').mockRejectedValue(new Error('DAPI timeout'));
    await renderAt(`/explore/search?q=${id}`);
    await settle();

    expect(screen.getByText(AUTHORS.carol.displayName)).toBeTruthy();
    expect(screen.queryByTestId('search-retry-people')).toBeNull();
  });

  it('reads follows once a cold start has restored the session', async () => {
    useSessionStore.setState({ status: 'unknown', session: null, accounts: [] });
    fakeEngine.method('explore.searchUsers').mockResolvedValue([user('bob')]);
    fakeEngine.method('explore.searchHashtags').mockResolvedValue([]);
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    fakeEngine.method('graph.status').mockResolvedValue({ [AUTHORS.bob.id]: true });
    await renderAt('/explore/search/people?q=bob');
    await settle();
    expect(fakeEngine.method('graph.status')).not.toHaveBeenCalled();

    await act(async () => {
      useSessionStore.setState({ status: 'signed-in', session: viewer });
    });
    await act(async () => {});
    expect(fakeEngine.method('graph.status')).toHaveBeenCalledWith([AUTHORS.bob.id]);
    expect(screen.getByLabelText('Following Bob Builder')).toBeTruthy();
  });

  it('offers a retry when the follow read fails, instead of rows with no follow button', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    fakeEngine.method('explore.searchUsers').mockResolvedValue([user('bob')]);
    fakeEngine.method('explore.searchHashtags').mockResolvedValue([]);
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    fakeEngine.method('graph.status').mockRejectedValueOnce(new Error('RPC deadline'));
    await renderAt('/explore/search/people?q=bob');
    await settle();
    expect(screen.getByTestId('search-results-error')).toBeTruthy();

    fakeEngine.method('graph.status').mockResolvedValue({ [AUTHORS.bob.id]: true });
    fireEvent.press(screen.getByText('Try again'));
    await settle();
    expect(screen.getByLabelText('Following Bob Builder')).toBeTruthy();
  });

  it('groups people, hashtags and recent posts, three each with See all (EXPL-05, EXPL-06)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
    const people = [user('bob'), user('carol'), user('nameless'), user('alice')];
    fakeEngine.method('explore.searchUsers').mockResolvedValue(people);
    fakeEngine.method('graph.status').mockResolvedValue({ [AUTHORS.bob.id]: true });
    fakeEngine.method('explore.searchHashtags').mockResolvedValue([tag('bobsburgers', 12, 'posts')]);
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    const app = await renderAt('/explore/search?q=bob');
    await settle();

    expect(fakeEngine.method('explore.searchUsers')).toHaveBeenCalledWith('bob');
    expect(screen.getByText('People')).toBeTruthy();
    expect(screen.getByText('Bob Builder')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull(); // the 4th row waits for See all
    expect(screen.getByText('#bobsburgers')).toBeTruthy();
    expect(screen.getByText('12 posts')).toBeTruthy();
    expect(screen.queryByText('Recent posts')).toBeNull();
    // Previews carry no follow button.
    expect(screen.queryByTestId('search-user-bob-follow')).toBeNull();

    fireEvent.press(screen.getByTestId('search-see-all-people'));
    await act(async () => {});
    expect(app.getPathname()).toBe('/explore/search/people');
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByLabelText('Following Bob Builder')).toBeTruthy();
    expect(screen.queryByTestId('search-user-alice-follow')).toBeNull();
  });

  it('finds a cashtag by its ticker and remembers opened tags (EXPL-08)', async () => {
    fakeEngine.method('explore.searchUsers').mockResolvedValue([]);
    // Not trending: only the exact storage-form lookup finds it; the ticker finds #dash.
    fakeEngine
      .method('explore.searchHashtags')
      .mockImplementation(async (q: string) => (q === 'dash_cashtag' ? [tag('dash_cashtag', 2, 'posts')] : [tag('dash', 7)]));
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    const app = await renderAt('/explore/search');

    fireEvent.changeText(screen.getByTestId('search-input'), '$DASH');
    await settle();
    expect(fakeEngine.method('explore.searchHashtags')).toHaveBeenCalledWith('DASH');
    expect(fakeEngine.method('explore.searchHashtags')).toHaveBeenCalledWith('dash_cashtag');
    expect(screen.getByText('$DASH')).toBeTruthy();
    expect(screen.getByText('#dash')).toBeTruthy();

    fireEvent.press(screen.getByTestId('search-tag-dash_cashtag'));
    await act(async () => {});
    expect(app.getPathname()).toBe('/hashtag/dash_cashtag');
    expect(getRecent('signed-out')).toEqual([{ kind: 'tag', tag: 'dash_cashtag' }]);
  });

  it('says when nothing matches', async () => {
    fakeEngine.method('explore.searchUsers').mockResolvedValue([]);
    fakeEngine.method('explore.searchHashtags').mockResolvedValue([]);
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    await renderAt('/explore/search?q=zzqx');
    await settle();

    expect(screen.getByText('No results for "zzqx"')).toBeTruthy();
    expect(screen.getByText('Try searching for something else')).toBeTruthy();
  });

  it('keeps submitted queries as recent searches, removable and clearable (EXPL-08)', async () => {
    fakeEngine.method('explore.searchUsers').mockResolvedValue([]);
    fakeEngine.method('explore.searchHashtags').mockResolvedValue([]);
    fakeEngine.method('explore.searchPosts').mockResolvedValue([]);
    await renderAt('/explore/search');

    for (const q of ['first', 'second']) {
      fireEvent.changeText(screen.getByTestId('search-input'), q);
      fireEvent(screen.getByTestId('search-input'), 'submitEditing');
      await settle();
    }
    fireEvent.press(screen.getByTestId('search-clear'));
    await act(async () => {});

    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Remove second'));
    expect(screen.queryByText('second')).toBeNull();
    expect(screen.getByText('first')).toBeTruthy();

    // Tapping a recent query searches it again.
    fireEvent.press(screen.getByTestId('recent-first'));
    await settle();
    expect(screen.getByTestId('search-input')).toHaveDisplayValue('first');

    fireEvent.press(screen.getByTestId('search-clear'));
    fireEvent.press(screen.getByTestId('recent-clear'));
    expect(screen.getByText('Find people, hashtags and recent posts.')).toBeTruthy();
  });
});

const scrolledTo = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } });

describe('Hashtag page', () => {
  it('lists the tag’s latest posts under its title, with Top where supported (EXPL-07)', async () => {
    fakeEngine.method('feed.hashtag').mockResolvedValue(page([post('h1', 'tagged #mobile')]));
    await renderAt('/hashtag/mobile');

    expect(fakeEngine.method('feed.hashtag')).toHaveBeenCalledWith({
      tag: 'mobile',
      sort: 'recent',
      window: 'all',
      cursor: null,
    });
    expect(screen.getByText('tagged #mobile')).toBeTruthy();

    fireEvent(screen.getByTestId('hashtag-sort'), 'change', { nativeEvent: { selectedSegmentIndex: 1 } });
    await act(async () => {});
    expect(fakeEngine.method('feed.hashtag')).toHaveBeenLastCalledWith({
      tag: 'mobile',
      sort: 'top',
      window: 'all',
      cursor: null,
    });
    expect(screen.getByTestId('hashtag-window')).toBeTruthy();
  });

  it('reads the tag’s Top afresh on a pull to refresh, retry included, and only then (RC16-I-04)', async () => {
    withProductionRetry();
    const hashtag = fakeEngine.method('feed.hashtag');
    hashtag.mockResolvedValue(page([post('h1', 'stale post')]));
    await renderAt('/hashtag/mobile');
    fireEvent(screen.getByTestId('hashtag-sort'), 'change', { nativeEvent: { selectedSegmentIndex: 1 } });
    await act(async () => {});
    const top = { tag: 'mobile', sort: 'top', window: 'all', cursor: null };
    expect(hashtag).toHaveBeenLastCalledWith(top);

    hashtag.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'TIMEOUT' }));
    hashtag.mockResolvedValue(page([post('h2', 'fresh post')]));
    const calls = hashtag.mock.calls.length;
    await act(async () => {
      screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
    });
    await waitOutRetry();
    expect(hashtag.mock.calls.slice(calls)).toEqual([[{ ...top, refresh: true }], [{ ...top, refresh: true }]]);
    expect(screen.getByText('fresh post')).toBeTruthy();

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.feed.hashtag({ tag: 'mobile', sort: 'top', window: 'all' }) });
    });
    expect(fakeEngine.method('feed.hashtag')).toHaveBeenLastCalledWith(top);
  });

  it('does not read the tag’s Latest afresh on a pull to refresh', async () => {
    fakeEngine.method('feed.hashtag').mockResolvedValue(page([post('h1', 'tagged #mobile')]));
    await renderAt('/hashtag/mobile');
    await act(async () => {
      screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
    });
    await act(async () => {});
    expect(fakeEngine.method('feed.hashtag')).toHaveBeenCalledTimes(2);
    expect(fakeEngine.method('feed.hashtag')).toHaveBeenLastCalledWith({ tag: 'mobile', sort: 'recent', window: 'all', cursor: null });
  });

  it("keeps G-11's error up, with Retrying…, while NET-03's backoff reads the tag again (NEW-R-A-02)", async () => {
    jest.useFakeTimers();
    const stopRetry = startReadRetry();
    try {
      const timedOut = () => Object.assign(new Error('Engine call feed.hashtag timed out'), { code: 'RPC_TIMEOUT' });
      // A stalled DAPI: each read hangs until it times out.
      let fail: (error: Error) => void = () => undefined;
      const stalled = () =>
        new Promise<Page<PostDTO>>((_, reject) => {
          fail = reject;
        });
      fakeEngine.method('feed.hashtag').mockRejectedValueOnce(timedOut()).mockImplementation(stalled);
      await renderAt('/hashtag/stall');
      expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
      expect(screen.queryByTestId('hashtag-posts-error-retrying')).toBeNull();

      // The backoff's first retry, 2 s on: the error stays, with "Retrying…", not "Loading posts…".
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_000);
      });
      expect(fakeEngine.method('feed.hashtag')).toHaveBeenCalledTimes(2);
      expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
      expect(screen.getByTestId('hashtag-posts-error-retrying')).toHaveAccessibleName('Retrying…');
      expect(screen.queryByTestId('hashtag-posts-loading')).toBeNull();

      // It times out too: the error, without the note.
      await act(async () => fail(timedOut()));
      expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
      expect(screen.queryByTestId('hashtag-posts-error-retrying')).toBeNull();

      // "Try again" while the next retry stalls: it reads afresh, with the loading state, rather than joining it.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_000);
      });
      expect(fakeEngine.method('feed.hashtag')).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId('hashtag-posts-error-retrying')).toBeTruthy();
      fireEvent.press(screen.getByTestId('hashtag-posts-error-action'));
      await act(async () => {});
      expect(fakeEngine.method('feed.hashtag')).toHaveBeenCalledTimes(4);
      expect(screen.getByTestId('hashtag-posts-loading')).toBeTruthy();
      await act(async () => fail(timedOut()));
      expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
      expect(screen.queryByTestId('hashtag-posts-error-retrying')).toBeNull();

      // "Try again" is the reader's own read: it shows the loading state as before.
      fireEvent.press(screen.getByTestId('hashtag-posts-error-action'));
      await act(async () => {});
      expect(screen.getByTestId('hashtag-posts-loading')).toBeTruthy();
      expect(screen.queryByTestId('hashtag-posts-error')).toBeNull();
      await act(async () => fail(timedOut()));
    } finally {
      stopRetry();
      jest.useRealTimers();
    }
  });

  it('reads a cashtag link in storage form and shows the empty state', async () => {
    fakeEngine.method('feed.hashtag').mockResolvedValue(page([]));
    await renderAt('/hashtag/$dash');

    expect(fakeEngine.method('feed.hashtag')).toHaveBeenCalledWith(expect.objectContaining({ tag: 'dash_cashtag' }));
    expect(screen.getByText('No posts yet')).toBeTruthy();
  });

  it('has no sort control on v2', async () => {
    fakeEngine.setStatus({ info: { capabilities: V2 } });
    fakeEngine.method('feed.hashtag').mockResolvedValue(page([post('h1', 'v2 post')]));
    await renderAt('/hashtag/dash');

    expect(screen.queryByTestId('hashtag-sort')).toBeNull();
    expect(screen.getByText('v2 post')).toBeTruthy();
  });

  it('pauses after three automatic pages until the reader scrolls again; a refresh starts over (FEED-07)', async () => {
    let n = 0;
    fakeEngine.method('feed.hashtag').mockImplementation(() => {
      n += 1;
      return Promise.resolve(page([post(`p${n}`, `post ${n}`)], true));
    });
    await renderAt('/hashtag/mobile');
    await act(async () => {});
    const calls = () => fakeEngine.method('feed.hashtag').mock.calls.length;

    // The short list keeps reaching its end: the first page, three automatic ones, then the pill.
    expect(calls()).toBe(4);
    expect(screen.getByTestId('hashtag-posts-load-more')).toBeTruthy();
    await act(async () => {
      fireEvent(screen.getByTestId('hashtag-posts'), 'endReached');
    });
    expect(calls()).toBe(4);

    // A pull to refresh starts as a drag too, but one toward the top is no ask for more.
    await act(async () => {
      fireEvent(screen.getByTestId('hashtag-posts'), 'scrollBeginDrag', scrolledTo(0));
      fireEvent(screen.getByTestId('hashtag-posts'), 'scrollEndDrag', scrolledTo(-80));
    });
    await act(async () => {});
    expect(calls()).toBe(4);

    // A new drag toward the end is a new ask: paging resumes (one page, then three automatic ones again).
    await act(async () => {
      fireEvent(screen.getByTestId('hashtag-posts'), 'scrollBeginDrag', scrolledTo(100));
      fireEvent(screen.getByTestId('hashtag-posts'), 'scrollEndDrag', scrolledTo(300));
    });
    await act(async () => {});
    expect(calls()).toBe(8);
    expect(screen.getByText('post 8')).toBeTruthy();
    expect(screen.getByTestId('hashtag-posts-load-more')).toBeTruthy();

    // Pull to refresh reads the first page only, and the three-page budget starts over.
    await act(async () => {
      screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
    });
    await act(async () => {});
    expect(fakeEngine.method('feed.hashtag').mock.calls[8]?.[0]).toEqual(expect.objectContaining({ cursor: null }));
    expect(calls()).toBe(12);
    expect(screen.queryByText('post 2')).toBeNull();
    expect(screen.getByTestId('hashtag-posts-load-more')).toBeTruthy();
  });

  it('reopens a saved tag from its first page, still due a refresh', async () => {
    const key = queryKeys.feed.hashtag({ tag: 'mobile', sort: 'recent', window: 'all' });
    queryClient.setQueryData(
      key,
      { pages: [page([post('a', 'saved a')], true), page([post('b', 'saved b')], true)], pageParams: [null, 'next'] },
      { updatedAt: 1 },
    );
    // What the refetch starts from: it re-reads every page the cache holds then.
    const heldPages: number[] = [];
    fakeEngine.method('feed.hashtag').mockImplementation(() => {
      heldPages.push(queryClient.getQueryData<{ pages: unknown[] }>(key)?.pages.length ?? 0);
      return new Promise<never>(() => undefined);
    });
    await renderAt('/hashtag/mobile');

    // One read, of the first page, over the one saved page left.
    expect(heldPages).toEqual([1]);
    expect(fakeEngine.method('feed.hashtag')).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }));
    expect(queryClient.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(1);
    expect(queryClient.getQueryState(key)?.dataUpdatedAt).toBe(1);
    expect(screen.getByText('saved a')).toBeTruthy();
    expect(screen.queryByText('saved b')).toBeNull();
  });

  it('rejects a link that is not a tag', async () => {
    await renderAt('/hashtag/not%20a%20tag');

    expect(screen.getByText('Not a hashtag')).toBeTruthy();
    expect(fakeEngine.method('feed.hashtag')).not.toHaveBeenCalled();
  });
});

describe('Recent searches on sign-out (AUTH-11)', () => {
  it('drop the bucket of an account that leaves the device', () => {
    const account = (identityId: string) => ({ identityId, username: null, method: 'key' as const, lastUsedAt: new Date(0), active: false });
    const stop = startRecentSearchCleanup();
    useSessionStore.setState({ accounts: [account('A'), account('B')] });
    addRecent('A', { kind: 'query', q: 'from a' });
    addRecent('B', { kind: 'query', q: 'from b' });

    useSessionStore.setState({ accounts: [account('B')] });
    expect(getRecent('A')).toEqual([]);
    expect(getRecent('B')).toEqual([{ kind: 'query', q: 'from b' }]);

    stop();
    clearRecent('B');
  });
});
