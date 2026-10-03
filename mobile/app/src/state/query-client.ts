import { parse, stringify } from '@engine/protocol/codec';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, type Query } from '@tanstack/react-query';
import type { PersistedClient, PersistQueryClientProviderProps } from '@tanstack/react-query-persist-client';

import { config } from '~/config';
import { ENGINE_BUNDLE_HASH } from '~/engine/bundle-hash';

import { installQueryBudget, isPagedData } from './query-budget';
import { syncStorage } from './storage';

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      /** Opt this query into the on-disk cache. Use `persistedQuery` rather than setting it directly. */
      persist?: boolean;
    };
  }
}

/** How long persisted data may be shown on the next launch. */
const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Spread into the options of a query whose data should survive restarts
 * (feeds, profiles), so the UI can paint before the engine boots:
 *
 *   useQuery({ queryKey, queryFn, ...persistedQuery })
 *
 * Never use it for decrypted DMs, notifications or balances: MMKV is not
 * encrypted. The long gcTime keeps the entry alive as long as the persisted copy;
 * `installQueryBudget` bounds what such entries keep once no screen shows them.
 */
export const persistedQuery = {
  meta: { persist: true },
  gcTime: PERSIST_MAX_AGE_MS,
} as const;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 5 * 60_000,
      staleTime: 30_000,
      // DAPI flakiness is handled inside the engine; one UI-level retry is enough.
      retry: 1,
    },
  },
});
installQueryBudget(queryClient);

/** PRD FEED-11: a persisted list holds at most this many items. */
const PERSISTED_LIST_MAX = 200;

/** A paged list keeps its first page only (a restored infinite query refetches every page it holds), capped. */
function firstPageOnly(data: unknown): unknown {
  if (!isPagedData(data) || data.pages.length === 0) return data;
  const [first] = data.pages;
  const items = (first as { items?: unknown } | null)?.items;
  const page =
    Array.isArray(items) && items.length > PERSISTED_LIST_MAX
      ? { ...(first as object), items: items.slice(0, PERSISTED_LIST_MAX) }
      : first;
  if (data.pages.length === 1 && page === first) return data;
  return { pages: [page], pageParams: data.pageParams.slice(0, 1) };
}

/**
 * What goes to disk (PRD FEED-11): each list's first page, at most
 * {@link PERSISTED_LIST_MAX} items, and a query whose last refetch failed as
 * the data it still shows. The persister re-serializes the whole cache on
 * every cache event, so keeping it this small is what keeps that cheap.
 */
export function forDisk(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries.map((query) => {
    const data = firstPageOnly(query.state.data);
    const failed = query.state.status === 'error';
    if (data === query.state.data && !failed) return query;
    const state = failed
      ? { ...query.state, data, status: 'success' as const, error: null, fetchFailureCount: 0, fetchFailureReason: null }
      : { ...query.state, data };
    return { ...query, state };
  });
  return { ...client, clientState: { ...client.clientState, queries } };
}

const persister = createAsyncStoragePersister({
  key: 'yappr-query-cache',
  storage: syncStorage,
  // The engine's codec, so a restored post keeps its Dates (and bigints, Maps...).
  serialize: (client) => stringify(forDisk(client)),
  deserialize: (cache) => parse(cache) as PersistedClient,
});

/**
 * Opted-in queries with data. A failed refetch or next page keeps the data
 * on screen (status `error`), and that data is what the next launch should
 * paint, so it is kept too (TanStack's default keeps `success` only).
 */
const shouldPersistQuery = (query: Query): boolean =>
  query.meta?.persist === true &&
  (query.state.status === 'success' || (query.state.status === 'error' && query.state.data !== undefined));

/**
 * A cache written by another app version, engine build or network is
 * discarded instead of restored.
 */
export const cacheBuster = `${config.appVersion}:${ENGINE_BUNDLE_HASH}:${config.network}`;

export const persistOptions: PersistQueryClientProviderProps['persistOptions'] = {
  persister,
  maxAge: PERSIST_MAX_AGE_MS,
  buster: cacheBuster,
  dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
};

/**
 * Drops every cached query, in memory and on disk. Call on sign-out and
 * account switch. Queries a screen is showing are reset rather than
 * removed, so they refetch for the new account.
 */
export async function clearAccountCache(): Promise<void> {
  queryClient.removeQueries({ type: 'inactive' });
  await Promise.all([persister.removeClient(), queryClient.resetQueries()]);
}
