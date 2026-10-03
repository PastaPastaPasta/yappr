import { parse, stringify } from '@engine/protocol/codec';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryCache, QueryClient, type Query, type QueryKey } from '@tanstack/react-query';
import type { PersistedClient, PersistQueryClientProviderProps } from '@tanstack/react-query-persist-client';

import { config } from '~/config';
import { ENGINE_BUNDLE_HASH } from '~/engine/bundle-hash';
import { appendLog, errorMessage } from '~/engine/logs';

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
 * encrypted. The long gcTime keeps the entry alive as long as the persisted copy.
 */
export const persistedQuery = {
  meta: { persist: true },
  gcTime: PERSIST_MAX_AGE_MS,
} as const;

/**
 * How many leading parts of a key's path may be logged: what the viewer typed
 * (a search, an @-prefix) and who they message stay out of the diagnostics
 * text, which the user can copy into a bug report.
 */
function loggablePartCount(parts: readonly (string | number)[]): number {
  const [family, kind] = parts;
  if (family === 'dm') return 2;
  if (family === 'explore' && kind === 'search') return 3;
  if (family === 'explore' && kind === 'mentions') return 2;
  return parts.length;
}

/**
 * A query key as a diagnostics label: its path after `['engine', <network>]`,
 * public ids included, objects, search text and DM members left out.
 */
export function describeQueryKey(key: QueryKey): string {
  const parts = key
    .slice(2)
    .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number');
  return parts.slice(0, loggablePartCount(parts)).join('.');
}

/**
 * An infinite list whose last failure was a next page: it keeps the pages it
 * shows behind a "Load More" footer (PRD G-11), and re-reading it whole would
 * read every loaded page again, one after another, and could reorder a
 * ranked feed under the reader's finger.
 */
function nextPageFailed(query: Query): boolean {
  return query.state.status === 'error' && query.state.data !== undefined && query.state.fetchMeta?.fetchMore !== undefined;
}

/**
 * Every failed read goes to the diagnostics log (PRD SET-08: the engine's
 * recent errors) with its code, so a read that fails in a way the screen can
 * only call "Something went wrong" can still be told apart. The message is
 * redacted by `appendLog`.
 */
function logReadFailure(error: unknown, query: Query<unknown, unknown, unknown>): void {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const what = describeQueryKey(query.queryKey) || 'query';
  appendLog('warn', 'host', `Read ${what} failed${typeof code === 'string' ? ` (${code})` : ''}: ${errorMessage(error)}`);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: logReadFailure }),
  defaultOptions: {
    queries: {
      gcTime: 5 * 60_000,
      staleTime: 30_000,
      // DAPI flakiness is handled inside the engine; one UI-level retry is enough.
      retry: 1,
      // Reads go to the engine, which answers offline too (its local state, a categorized
      // failure); TanStack's online state (NetInfo, `data/connectivity.ts`) only drives the
      // refetch when connectivity returns, it never parks a read.
      networkMode: 'always',
      // A list whose next page failed waits for its "Load More" instead (G-11).
      refetchOnReconnect: (query) => !nextPageFailed(query),
    },
  },
});

/** PRD FEED-11: a persisted list holds at most this many items. */
const PERSISTED_LIST_MAX = 200;

const isPagedData = (data: unknown): data is { pages: unknown[]; pageParams: unknown[] } =>
  typeof data === 'object' &&
  data !== null &&
  Array.isArray((data as { pages?: unknown }).pages) &&
  Array.isArray((data as { pageParams?: unknown }).pageParams);

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

const PERSIST_KEY = 'yappr-query-cache';

const persister = createAsyncStoragePersister({
  key: PERSIST_KEY,
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

/**
 * Reads a screen is showing that failed, read again once (PRD G-1, NET-04):
 * after connectivity returns, the engine comes up, or an account switch
 * settles. A failed read is otherwise only retried by its "Try again" (the
 * home feeds never refetch by themselves). A list whose next page failed is
 * left to its "Load More" ({@link nextPageFailed}). `why` goes to the
 * diagnostics log.
 */
export async function refetchFailedReads(why: string): Promise<void> {
  const failed = (query: Query) => query.state.status === 'error' && !nextPageFailed(query);
  const count = queryClient.getQueryCache().findAll({ type: 'active', predicate: failed }).length;
  if (count === 0) return;
  appendLog('info', 'host', `${why}: retrying ${count} failed ${count === 1 ? 'read' : 'reads'}`);
  // A read already in flight again (TanStack's own reconnect refetch) is joined, not restarted.
  await queryClient.refetchQueries({ type: 'active', predicate: failed }, { cancelRefetch: false });
}

/** UTF-8 length without encoding a copy (the cache can run to megabytes). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      // A surrogate pair: one 4-byte code point.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The on-disk cache's size in bytes: what "Clear cache" deletes (Engine
 * diagnostics, PRD SET-08). MMKV stores the string as UTF-8.
 */
export function persistedCacheBytes(): number {
  return utf8Bytes(syncStorage.getItem(PERSIST_KEY) ?? '');
}
