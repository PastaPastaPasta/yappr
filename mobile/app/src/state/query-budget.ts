import type { Query, QueryCache, QueryClient } from '@tanstack/react-query';

/** How many persisted queries no screen shows are kept, the most recently updated. */
export const INACTIVE_PERSISTED_MAX = 50;

export const isPagedData = (data: unknown): data is { pages: unknown[]; pageParams: unknown[] } =>
  typeof data === 'object' &&
  data !== null &&
  Array.isArray((data as { pages?: unknown }).pages) &&
  Array.isArray((data as { pageParams?: unknown }).pageParams);

/** Opted into the disk cache, holding data, and on no screen. */
const isInactivePersisted = (query: Query): boolean =>
  query.meta?.persist === true && query.state.data !== undefined && query.getObserversCount() === 0;

/** An infinite query goes back to its first page, as the disk copy already is. */
function trimToFirstPage(client: QueryClient, query: Query) {
  const { data, dataUpdatedAt } = query.state;
  if (!isPagedData(data) || data.pages.length <= 1) return;
  client.setQueryData(
    query.queryKey,
    { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
    { updatedAt: dataUpdatedAt },
  );
}

/** Drops the least recently updated inactive persisted queries past `max`. */
function evictBeyond(cache: QueryCache, max: number) {
  const inactive = cache.getAll().filter((query) => isInactivePersisted(query) && query.state.fetchStatus === 'idle');
  if (inactive.length <= max) return;
  inactive
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(max)
    .forEach((query) => cache.remove(query));
}

/**
 * Bounds what persisted queries cost once their screen is gone (D-L3a-011).
 * They live for the persister's 7-day max age, so that their disk copy does
 * too, which without a bound means every profile, thread and list visited
 * stays in the JS heap all session, and in the snapshot the persister
 * re-serializes on every cache change. So, once no screen observes one:
 *
 * - an infinite query keeps only its first page, which is all the disk copy
 *   holds and all a returning screen shows before it scrolls (it opens at
 *   the top, and refetches only that page);
 * - at most `max` of them are kept, the most recently updated. The rest are
 *   dropped from memory and so from disk; opening one again reads afresh.
 *
 * Queries a screen shows are never touched. Returns the unsubscribe.
 */
export function installQueryBudget(client: QueryClient, max = INACTIVE_PERSISTED_MAX): () => void {
  const cache = client.getQueryCache();
  return cache.subscribe((event) => {
    const settled =
      event.type === 'observerRemoved' || (event.type === 'updated' && event.action.type === 'success');
    if (!settled || !isInactivePersisted(event.query)) return;
    trimToFirstPage(client, event.query);
    evictBeyond(cache, max);
  });
}
