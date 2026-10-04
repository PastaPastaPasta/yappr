import { parse, stringify } from '@engine/protocol/codec';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { hashKey, QueryCache, QueryClient, type Query, type QueryKey } from '@tanstack/react-query';
import type { PersistedClient, Persister, PersistQueryClientProviderProps } from '@tanstack/react-query-persist-client';

import { config } from '~/config';
import { ENGINE_BUNDLE_HASH } from '~/engine/bundle-hash';
import { appendLog, errorMessage } from '~/engine/logs';

import { installQueryBudget, isPagedData } from './query-budget';
import { syncStorage } from './storage';

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      /** Opt this query into the on-disk cache. Use `persistedQuery` rather than setting it directly. */
      persist?: boolean;
      /** `false` keeps NET-03's backoff away from this read (`data/read-retry.ts`). Use `NO_READ_RETRY`. */
      readRetry?: boolean;
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
 * every change to a persisted query ({@link persistOnChange}), so keeping it
 * this small is what keeps that cheap.
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

/** Bumped by every write or removal of the on-disk cache, so its size is measured once per change. */
let cacheGeneration = 0;
let measured: { generation: number; bytes: number } | null = null;

const storagePersister = createAsyncStoragePersister({
  key: PERSIST_KEY,
  storage: {
    getItem: syncStorage.getItem,
    setItem: (key: string, value: string) => {
      syncStorage.setItem(key, value);
      cacheGeneration += 1;
    },
    removeItem: (key: string) => {
      syncStorage.removeItem(key);
      cacheGeneration += 1;
    },
  },
  // The engine's codec, so a restored post keeps its Dates (and bigints, Maps...).
  serialize: (client) => stringify(forDisk(client)),
  deserialize: (cache) => parse(cache) as PersistedClient,
});

/** Ids for data values, so a signature tells a replaced value from the same one without holding on to it. */
const dataIds = new WeakMap<object, number>();
let lastDataId = 0;

function dataId(data: unknown): number | string {
  if (typeof data !== 'object' || data === null) return typeof data;
  let id = dataIds.get(data);
  if (id === undefined) {
    lastDataId += 1;
    id = lastDataId;
    dataIds.set(data, id);
  }
  return id;
}

/**
 * What the disk copy of `client` depends on: each persisted query's hash,
 * data (by identity: TanStack replaces it on every change), age, status and
 * invalidation, and the paused mutations. Its timestamp is left out.
 */
export function diskSignature(client: PersistedClient): string {
  const { queries, mutations } = client.clientState;
  const parts = queries.map(
    ({ queryHash, state }) =>
      `${queryHash}\u0000${dataId(state.data)}:${state.dataUpdatedAt}:${state.status}:${state.isInvalidated ? 1 : 0}`,
  );
  for (const { mutationKey, state } of mutations) parts.push(`m:${String(mutationKey)}:${state.submittedAt}:${state.status}`);
  return `${client.buster}\u0001${parts.join('\u0001')}`;
}

/**
 * `persister` writing only when the disk copy would change (D-L3a-011). The
 * persist client dehydrates and saves on every cache event, of any query,
 * and the save (throttled to once a second) deep-copies every persisted
 * query through the codec and re-serializes it whole: megabytes of garbage a
 * second while a feed scrolls, though most events are a card's own reads (a
 * poll, a link preview, a repost's marks) that are never persisted. Now an
 * event that leaves every persisted query as it was costs a short signature.
 */
export function persistOnChange(persister: Persister): Persister {
  let last: string | null = null;
  return {
    persistClient: (client) => {
      const signature = diskSignature(client);
      if (signature === last) return undefined;
      last = signature;
      return persister.persistClient(client);
    },
    restoreClient: () => persister.restoreClient(),
    removeClient: () => {
      last = null;
      return persister.removeClient();
    },
  };
}

const persister = persistOnChange(storagePersister);

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

/** Which failed reads to read again; every one by default. */
export type FailedReadFilter = (query: Query) => boolean;

/**
 * The error each failed read showed when NET-03's backoff started reading it
 * again (`refetchFailedReads` with `holdErrors`), by query hash, until that
 * read settles. TanStack puts a read with no data back to `pending` for every
 * refetch, error cleared, so without this a screen would trade G-11's error
 * for its loading spinner for each 30-60 s attempt of an outage
 * (NEW-R-A-02). The data hooks show it instead (`withRetriedError`).
 */
const retriedErrors = new Map<string, Error>();

queryClient.getQueryCache().subscribe((event) => {
  if (retriedErrors.size === 0) return;
  // Settled (an answer, a failure, a cancel's revert, a reset) or gone: the error is the read's own again.
  if (event.type === 'removed' || (event.type === 'updated' && event.query.state.fetchStatus === 'idle')) {
    retriedErrors.delete(event.query.queryHash);
  }
});

/** The error a read showed before NET-03's backoff began reading it again, while that retry runs. */
export function retriedReadError(key: QueryKey): Error | undefined {
  return retriedErrors.size === 0 ? undefined : retriedErrors.get(hashKey(key));
}

/** Failed reads a screen is showing, other than a list whose next page failed ({@link nextPageFailed}). */
const failedReads = (only: FailedReadFilter) => ({
  type: 'active' as const,
  predicate: (query: Query) => query.state.status === 'error' && !nextPageFailed(query) && only(query),
});

const anyFailure: FailedReadFilter = () => true;

/** How many reads a screen is showing failed (those {@link refetchFailedReads} would read again). */
export function failedReadCount(only: FailedReadFilter = anyFailure): number {
  return queryClient.getQueryCache().findAll(failedReads(only)).length;
}

/**
 * Reads a screen is showing that failed, read again once (PRD G-1, NET-04):
 * after connectivity returns, the engine comes up, or an account switch
 * settles; and with backoff while Dash Platform is unavailable (NET-03,
 * `data/read-retry.ts`, with `only` the inline errors of that category).
 * The home feeds never refetch by themselves otherwise. A list whose next
 * page failed is left to its "Load More" ({@link nextPageFailed}). `why`
 * goes to the diagnostics log. `holdErrors` (the backoff) keeps each read's
 * error on screen while it is read again ({@link retriedReadError}).
 */
export async function refetchFailedReads(
  why: string,
  only: FailedReadFilter = anyFailure,
  { holdErrors = false }: { holdErrors?: boolean } = {},
): Promise<void> {
  const failed = queryClient.getQueryCache().findAll(failedReads(only));
  const count = failed.length;
  if (count === 0) return;
  if (holdErrors) {
    for (const query of failed) {
      if (query.state.error && !query.isDisabled()) retriedErrors.set(query.queryHash, query.state.error);
    }
  }
  appendLog('info', 'host', `${why}: retrying ${count} failed ${count === 1 ? 'read' : 'reads'}`);
  // A read already in flight again (TanStack's own reconnect refetch) is joined, not restarted.
  await queryClient.refetchQueries(failedReads(only), { cancelRefetch: false });
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
 * diagnostics, PRD SET-08). MMKV stores the string as UTF-8. Reading it back
 * decodes megabytes, so it is measured only after the persister wrote or
 * removed it, not on every 2 s refresh.
 */
export function persistedCacheBytes(): number {
  if (measured?.generation !== cacheGeneration) {
    measured = { generation: cacheGeneration, bytes: utf8Bytes(syncStorage.getItem(PERSIST_KEY) ?? '') };
  }
  return measured.bytes;
}
