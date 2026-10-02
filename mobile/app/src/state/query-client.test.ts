import { dehydrate, InfiniteQueryObserver, QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

import { cacheBuster, forDisk, persistedQuery, persistOptions } from './query-client';

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
