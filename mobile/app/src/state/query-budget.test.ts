import { InfiniteQueryObserver, QueryClient, QueryObserver, type InfiniteData } from '@tanstack/react-query';

import { INACTIVE_PERSISTED_MAX, installQueryBudget } from './query-budget';
import { persistedQuery, queryClient } from './query-client';

type Feed = InfiniteData<{ items: number[] }, number>;

/** A persisted feed whose screen loaded three pages. */
async function threePageFeed(client: QueryClient, key: string, persist = true) {
  const observer = new InfiniteQueryObserver(client, {
    queryKey: [key],
    queryFn: async ({ pageParam }: { pageParam: number }) => ({ items: [pageParam] }),
    initialPageParam: 0,
    getNextPageParam: (last: { items: number[] }) => last.items[0] + 1,
    ...(persist ? persistedQuery : {}),
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  await observer.fetchNextPage();
  await observer.fetchNextPage();
  return unsubscribe;
}

const pagesOf = (client: QueryClient, key: string) => client.getQueryData<Feed>([key])?.pages.length;

describe('query budget (D-L3a-011)', () => {
  let client: QueryClient;
  let uninstall: () => void;
  beforeEach(() => {
    client = new QueryClient();
    uninstall = installQueryBudget(client, 3);
  });
  afterEach(() => {
    uninstall();
    client.clear();
  });

  it('keeps every page while a screen shows the list, and only the first once none does', async () => {
    const leave = await threePageFeed(client, 'feed');
    expect(pagesOf(client, 'feed')).toBe(3);
    const updatedAt = client.getQueryState(['feed'])?.dataUpdatedAt;

    leave();
    expect(client.getQueryData<Feed>(['feed'])).toEqual({ pages: [{ items: [0] }], pageParams: [0] });
    // Trimming is not news: the data keeps its age, so staleness is unchanged.
    expect(client.getQueryState(['feed'])?.dataUpdatedAt).toBe(updatedAt);
  });

  it('keeps an invalidation still due, so the list refetches when its screen returns', async () => {
    const leave = await threePageFeed(client, 'top');
    // A post landed while the list was on screen: refresh it on its next mount.
    await client.invalidateQueries({ queryKey: ['top'], refetchType: 'none' });
    leave();

    const query = client.getQueryCache().find({ queryKey: ['top'] });
    expect(pagesOf(client, 'top')).toBe(1);
    expect(query?.state.isInvalidated).toBe(true);
    expect(query?.isStale()).toBe(true);
    expect(query?.state.status).toBe('success');
  });

  it('keeps a failed next page an error, with the pages it had trimmed', async () => {
    let fail = false;
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['flaky'],
      queryFn: async ({ pageParam }: { pageParam: number }) => {
        if (fail) throw new Error('DAPI timeout');
        return { items: [pageParam] };
      },
      initialPageParam: 0,
      getNextPageParam: (last: { items: number[] }) => last.items[0] + 1,
      retry: false,
      ...persistedQuery,
    });
    const leave = observer.subscribe(() => undefined);
    await observer.refetch();
    await observer.fetchNextPage();
    fail = true;
    await observer.fetchNextPage();
    leave();

    const state = client.getQueryState(['flaky']);
    expect(pagesOf(client, 'flaky')).toBe(1);
    expect(state?.status).toBe('error');
    expect(state?.isInvalidated).toBe(true);
  });

  it('leaves queries that are not persisted to their gcTime', async () => {
    const leave = await threePageFeed(client, 'dm', false);
    leave();
    expect(pagesOf(client, 'dm')).toBe(3);
  });

  it('trims a page that lands after the screen has gone', async () => {
    let release: () => void = () => undefined;
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['slow'],
      queryFn: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam > 0) await new Promise<void>((resolve) => (release = resolve));
        return { items: [pageParam] };
      },
      initialPageParam: 0,
      getNextPageParam: (last: { items: number[] }) => last.items[0] + 1,
      ...persistedQuery,
    });
    const leave = observer.subscribe(() => undefined);
    await observer.refetch();
    const next = observer.fetchNextPage();
    leave();
    release();
    await next;
    expect(pagesOf(client, 'slow')).toBe(1);
  });

  it('keeps at most `max` off-screen persisted queries, the most recently updated', async () => {
    for (const key of ['a', 'b', 'c', 'd']) {
      jest.spyOn(Date, 'now').mockReturnValue({ a: 1, b: 2, c: 3, d: 4 }[key] ?? 0);
      await client.prefetchQuery({ queryKey: [key], queryFn: () => key, ...persistedQuery });
    }
    jest.restoreAllMocks();
    expect(client.getQueryCache().getAll().map((q) => q.queryKey[0])).toEqual(['b', 'c', 'd']);

    // One a screen shows never counts, and is never dropped.
    const shown = new QueryObserver(client, { queryKey: ['b'], queryFn: () => 'b', ...persistedQuery });
    const hide = shown.subscribe(() => undefined);
    await client.prefetchQuery({ queryKey: ['e'], queryFn: () => 'e', ...persistedQuery });
    expect(client.getQueryCache().getAll().map((q) => q.queryKey[0]).sort()).toEqual(['b', 'c', 'd', 'e']);
    // Shown, `b` refetched, so leaving it drops `c`, now the oldest.
    hide();
    expect(client.getQueryCache().getAll().map((q) => q.queryKey[0]).sort()).toEqual(['b', 'd', 'e']);
  });

  it('is installed on the app client with a budget of 50', () => {
    expect(INACTIVE_PERSISTED_MAX).toBe(50);
    queryClient.setQueryDefaults(['budget-probe'], persistedQuery);
    queryClient.setQueryData<Feed>(['budget-probe'], { pages: [{ items: [0] }, { items: [1] }], pageParams: [0, 1] });
    expect(queryClient.getQueryData<Feed>(['budget-probe'])?.pages).toHaveLength(1);
    queryClient.clear();
  });
});
