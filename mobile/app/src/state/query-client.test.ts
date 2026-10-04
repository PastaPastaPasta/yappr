import { dehydrate, InfiniteQueryObserver, onlineManager, QueryClient, QueryObserver, type InfiniteData } from '@tanstack/react-query';
import { persistQueryClientSubscribe, type PersistedClient, type Persister } from '@tanstack/react-query-persist-client';

import { getLogs } from '~/engine/logs';

import {
  cacheBuster,
  clearAccountCache,
  describeQueryKey,
  forDisk,
  persistedCacheBytes,
  persistedQuery,
  persistOnChange,
  persistOptions,
  queryClient,
  refetchFailedReads,
} from './query-client';
import { syncStorage } from './storage';

type Feed = InfiniteData<{ items: number[] }, number>;

const persisted = (client: QueryClient): PersistedClient =>
  forDisk({ buster: '', timestamp: 0, clientState: dehydrate(client, persistOptions.dehydrateOptions) });

describe('query persistence', () => {
  it('persists only queries that opt in', async () => {
    const client = new QueryClient();
    await client.prefetchQuery({ queryKey: ['feed'], queryFn: () => 'posts', ...persistedQuery });
    await client.prefetchQuery({ queryKey: ['dm'], queryFn: () => 'secret' });

    const state = dehydrate(client, persistOptions.dehydrateOptions);
    expect(state.queries.map((q) => q.queryKey)).toEqual([['feed']]);
    client.clear();
  });

  it('keeps a list whose next page failed, as the data it still shows (SR-24)', async () => {
    const client = new QueryClient();
    client.setQueryDefaults(['feed'], { ...persistedQuery, retry: false });
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['feed'],
      queryFn: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam > 0) throw new Error('DAPI 504');
        return { items: [pageParam] };
      },
      initialPageParam: 0,
      getNextPageParam: (last: { items: number[] }) => last.items[0] + 1,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().status).toBe('error');

    const [query] = persisted(client).clientState.queries;
    expect(query.state).toMatchObject({ status: 'success', error: null, data: { pages: [{ items: [0] }] } });
    unsubscribe();
    client.clear();
  });

  it('writes the first page of each list only, at most 200 items (SR-26)', () => {
    const client = new QueryClient();
    client.setQueryDefaults(['feed'], persistedQuery);
    client.setQueryDefaults(['profile'], persistedQuery);
    const big: Feed = {
      pages: [{ items: Array.from({ length: 250 }, (_, i) => i) }, { items: [250] }, { items: [251] }],
      pageParams: [0, 1, 2],
    };
    client.setQueryData(['feed'], big);
    client.setQueryData(['profile'], { id: 'p' });

    const [feed, profile] = persisted(client).clientState.queries;
    const data = feed.state.data as Feed;
    expect(data.pages).toHaveLength(1);
    expect(data.pageParams).toEqual([0]);
    expect(data.pages[0].items).toHaveLength(200);
    expect(profile.state.data).toEqual({ id: 'p' });
    // The list on screen keeps every page.
    expect(client.getQueryData<Feed>(['feed'])!.pages).toHaveLength(3);
    client.clear();
  });

  it('busts the cache per app version, engine build and network', () => {
    expect(cacheBuster).toBe('1.0.0:no-engine:devnet');
    expect(persistOptions.buster).toBe(cacheBuster);
  });
});

describe('persistOnChange (D-L3a-011)', () => {
  /** The persist client over `client`, saving through `persistOnChange` into a counting persister. */
  function persisting(client: QueryClient) {
    const inner = { persistClient: jest.fn(), restoreClient: jest.fn(), removeClient: jest.fn() } satisfies Persister;
    const gated = persistOnChange(inner);
    const stop = persistQueryClientSubscribe({
      queryClient: client,
      persister: gated,
      buster: 'b',
      dehydrateOptions: persistOptions.dehydrateOptions,
    });
    return { inner, gated, stop };
  }

  it("saves when a persisted query changes, not for every other query's events", async () => {
    const client = new QueryClient();
    const { inner, gated, stop } = persisting(client);
    await client.prefetchQuery({ queryKey: ['feed'], queryFn: () => ({ items: [1] }), ...persistedQuery });
    const saves = inner.persistClient.mock.calls.length;
    expect(saves).toBeGreaterThan(0);

    // A feed's cards read their polls, previews and marks: dozens of events, nothing on disk changes.
    for (let i = 0; i < 50; i += 1) {
      await client.prefetchQuery({ queryKey: ['poll', i], queryFn: () => ({ votes: i }) });
    }
    client.setQueryData(['poll', 0], { votes: 100 });
    expect(inner.persistClient).toHaveBeenCalledTimes(saves);

    // The feed itself: a new value, a refresh with the same value (newer age), an invalidation.
    client.setQueryData(['feed'], { items: [2, 1] });
    expect(inner.persistClient).toHaveBeenCalledTimes(saves + 1);
    await client.refetchQueries({ queryKey: ['feed'] });
    expect(inner.persistClient).toHaveBeenCalledTimes(saves + 2);
    await client.invalidateQueries({ queryKey: ['feed'] }, { cancelRefetch: false });
    expect(inner.persistClient.mock.calls.length).toBeGreaterThan(saves + 2);
    const before = inner.persistClient.mock.calls.length;

    // Same data, written through setState (the budget's trim keeps its age): a new value all the same.
    const query = client.getQueryCache().find({ queryKey: ['feed'] })!;
    query.setState({ data: { items: [2] } });
    client.setQueryData(['poll', 1], { votes: 7 });
    expect(inner.persistClient).toHaveBeenCalledTimes(before + 1);
    // The last save's state is what gets written: the newest feed.
    expect(inner.persistClient.mock.lastCall?.[0].clientState.queries[0].state.data).toEqual({ items: [2] });

    // After "Clear cache" the next event writes again, even with nothing changed.
    await gated.removeClient();
    client.setQueryData(['poll', 2], { votes: 1 });
    expect(inner.persistClient).toHaveBeenCalledTimes(before + 2);
    stop();
    client.clear();
  });
});

describe('failed reads', () => {
  afterEach(() => queryClient.clear());

  it('go to the diagnostics log with their code (SET-08)', async () => {
    const error = Object.assign(new Error('SDK not configured. Call initialize() first.'), { code: 'X_CODE' });
    await queryClient
      .fetchQuery({ queryKey: ['engine', 'devnet', 'feed', 'home', { tab: 'forYou' }], queryFn: () => Promise.reject(error), retry: false })
      .catch(() => undefined);
    expect(getLogs().at(-1)).toMatchObject({
      level: 'warn',
      source: 'host',
      message: 'Read feed.home failed (X_CODE): SDK not configured. Call initialize() first.',
    });
    expect(describeQueryKey(['engine', 'devnet', 'post', 'abc', 'thread'])).toBe('post.abc.thread');
  });

  it('are labelled without what the viewer typed or who they message', () => {
    expect(describeQueryKey(['engine', 'devnet', 'explore', 'search', 'posts', 'my secret'])).toBe('explore.search.posts');
    expect(describeQueryKey(['engine', 'devnet', 'explore', 'mentions', 'ali'])).toBe('explore.mentions');
    expect(describeQueryKey(['engine', 'devnet', 'explore', 'trending', 'day'])).toBe('explore.trending.day');
    expect(describeQueryKey(['engine', 'devnet', 'dm', 'messages', 'conv-key'])).toBe('dm.messages');
    expect(describeQueryKey(['engine', 'devnet', 'dm', 'people', 'id1,id2'])).toBe('dm.people');
  });

  it('leave a list whose next page failed to its "Load More", on retry and on reconnect (G-11)', async () => {
    const read = jest.fn(async ({ pageParam }: { pageParam: number }) => {
      if (pageParam > 0) throw new Error('DAPI 504');
      return { items: [pageParam] };
    });
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: ['engine', 'devnet', 'feed'],
      queryFn: read,
      initialPageParam: 0,
      getNextPageParam: (_last: { items: number[] }, pages: { items: number[] }[]) => pages.length,
      retry: false,
      staleTime: Infinity,
    });
    const stop = observer.subscribe(() => undefined);
    queryClient.mount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().isFetchNextPageError).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);

    await refetchFailedReads('Test');
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data?.pages).toEqual([{ items: [0] }]);

    queryClient.unmount();
    stop();
    queryClient.clear();
  });

  it('are read again when a screen shows them, and only those', async () => {
    const shown = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('back');
    const hidden = jest.fn().mockRejectedValue(new Error('down'));
    const fine = jest.fn().mockResolvedValue('ok');
    const observe = (key: string, queryFn: jest.Mock) =>
      new QueryObserver(queryClient, { queryKey: ['engine', 'devnet', key], queryFn, retry: false }).subscribe(() => undefined);
    const stops = [observe('shown', shown), observe('fine', fine)];
    await queryClient.fetchQuery({ queryKey: ['engine', 'devnet', 'hidden'], queryFn: hidden, retry: false }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await refetchFailedReads('Test');
    expect(shown).toHaveBeenCalledTimes(2);
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(fine).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['engine', 'devnet', 'shown'])).toBe('back');
    expect(getLogs().some((line) => line.message === 'Test: retrying 1 failed read')).toBe(true);
    stops.forEach((stop) => stop());
  });
});

describe('persistedCacheBytes (Engine diagnostics, SET-08)', () => {
  it('is the on-disk cache\'s UTF-8 size, and zero once "Clear cache" deleted it', async () => {
    syncStorage.setItem('yappr-query-cache', 'aé€😀');
    expect(persistedCacheBytes()).toBe(1 + 2 + 3 + 4);
    // Measured once per change of the cache, not re-read on every diagnostics refresh.
    const read = jest.spyOn(syncStorage, 'getItem');
    expect(persistedCacheBytes()).toBe(10);
    expect(read).not.toHaveBeenCalled();
    await clearAccountCache();
    expect(persistedCacheBytes()).toBe(0);
    read.mockRestore();
  });
});
