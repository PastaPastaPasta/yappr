import type { EngineApi } from '@engine/api';
import type { Page } from '@engine/api/dto';
import type { Remote } from '@engine/rpc/client';
import {
  hashKey,
  queryOptions,
  useInfiniteQuery,
  type FetchNextPageOptions,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
  type RefetchOptions,
  type UseInfiniteQueryOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { engine } from '~/engine';
import { cancelRetriedRead, persistedQuery, retriedReadError } from '~/state/query-client';

/** `engine.api`, as reads receive it. */
export type EngineRemote = Remote<EngineApi>;

export interface EngineQueryOptions<T, S = T>
  extends Omit<UseQueryOptions<T, Error, S>, 'queryKey' | 'queryFn'> {
  /**
   * Keep this query on disk (MMKV) so the next launch paints it before the
   * engine boots. Never for decrypted DMs, notifications or balances.
   */
  persist?: boolean;
}

/**
 * Query options for an engine read, for `useQuery`, `prefetchQuery` or
 * `ensureQueryData`. Take the key from `queryKeys`:
 *
 *   engineQueryOptions(queryKeys.post.detail(id), (api) => api.posts.get(id))
 *
 * Calls made before the engine is ready wait in the supervisor's queue; a
 * read interrupted by an engine restart is replayed once.
 */
export function engineQueryOptions<T, S = T>(
  key: QueryKey,
  read: (api: EngineRemote) => Promise<T>,
  { persist = false, ...options }: EngineQueryOptions<T, S> = {},
) {
  return queryOptions<T, Error, S>({
    ...(persist ? persistedQuery : {}),
    ...options,
    queryKey: key,
    queryFn: () => read(engine.api),
  });
}

/**
 * A query result as its screen should show it while NET-03's backoff reads a
 * failed read again (PRD NET-03, `read-retry.ts`). TanStack puts a read with
 * no data back to `pending` for every refetch, so the screen would swap
 * G-11's inline error for its loading state for each 30-60 s attempt of an
 * outage (NEW-R-A-02). Instead the result stays the error it was, with
 * `isRetrying` set for a "Retrying…" under it. Its `refetch` (a "Try again"
 * tap, a pull to refresh) ends that retry first and reads afresh, showing the
 * loading state as before: left alone, TanStack would join the stalled retry
 * and the tap would change nothing ({@link cancelRetriedRead}). Any other
 * refetch shows the loading state too. Reads `status` only while such a
 * retry runs, so other results keep their tracked props.
 */
export function withRetriedError<
  R extends { status: string; fetchStatus: string; refetch: (options?: RefetchOptions) => Promise<unknown> },
>(key: QueryKey, result: R): R & { isRetrying?: true } {
  const error = retriedReadError(key);
  if (!error || result.status !== 'pending' || result.fetchStatus !== 'fetching') return result;
  const refetch = (options?: RefetchOptions) => cancelRetriedRead(key).then(() => result.refetch(options));
  return Object.assign({}, result, {
    refetch: refetch as R['refetch'],
    status: 'error' as const,
    error,
    isError: true as const,
    isPending: false as const,
    isLoading: false as const,
    isLoadingError: true as const,
    isRetrying: true as const,
  });
}

/** `useQuery` over an engine read; see {@link engineQueryOptions}. */
export function useEngineQuery<T, S = T>(
  key: QueryKey,
  read: (api: EngineRemote) => Promise<T>,
  options?: EngineQueryOptions<T, S>,
) {
  return withRetriedError(key, useQuery(engineQueryOptions(key, read, options)));
}

export interface EngineInfiniteQueryOptions<T>
  extends Omit<
    UseInfiniteQueryOptions<Page<T>, Error, InfiniteData<Page<T>>, QueryKey, string | null>,
    'queryKey' | 'queryFn' | 'initialPageParam' | 'getNextPageParam'
  > {
  /** Keep the pages on disk (MMKV); see `EngineQueryOptions.persist`. */
  persist?: boolean;
  /** Identifies an item for de-duplication across pages; default its `id`. Keep it stable. */
  itemId?: (item: T) => string | undefined;
}

const idOf = (item: unknown) =>
  typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
    ? (item as { id: string }).id
    : undefined;

/** The pages' items in order, each id once (a page boundary can repeat an item). */
export function flattenPages<T>(
  data: InfiniteData<Page<T>> | undefined,
  itemId: (item: T) => string | undefined = idOf,
): T[] {
  if (!data) return [];
  const seen = new Set<string>();
  const items: T[] = [];
  for (const page of data.pages) {
    for (const item of page.items) {
      const id = itemId(item);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      items.push(item);
    }
  }
  return items;
}

/**
 * `useInfiniteQuery` over a cursor-paged engine read (`Page<T>`). `read`
 * gets `null` for the first page and the previous page's cursor after that;
 * `items` is every loaded page, flattened and de-duplicated:
 *
 *   const { items, fetchNextPage, hasNextPage } = useEngineInfiniteQuery(
 *     queryKeys.feed.home({ tab: 'forYou' }),
 *     (api, cursor) => api.feed.home({ tab: 'forYou', cursor }),
 *     { persist: true },
 *   );
 *
 * `fetchNextPage` never cancels a refetch in flight
 * ({@link useFetchNextPageAfterRefetch}).
 */
export function useEngineInfiniteQuery<T>(
  key: QueryKey,
  read: (api: EngineRemote, cursor: string | null) => Promise<Page<T>>,
  { persist = false, itemId, ...options }: EngineInfiniteQueryOptions<T> = {},
) {
  const query = useInfiniteQuery<Page<T>, Error, InfiniteData<Page<T>>, QueryKey, string | null>({
    ...(persist ? persistedQuery : {}),
    ...options,
    queryKey: key,
    queryFn: ({ pageParam }) => read(engine.api, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => (last.hasMore && last.cursor ? last.cursor : undefined),
  });
  const items = useMemo(() => flattenPages(query.data, itemId), [query.data, itemId]);
  const fetchNextPage = useFetchNextPageAfterRefetch(key, query.fetchNextPage);
  return { ...withRetriedError(key, query), items, fetchNextPage };
}

/**
 * An infinite query's `fetchNextPage` that waits for a refetch in flight
 * instead of cancelling it (TanStack's default `cancelRefetch: true`), then
 * asks for the next page of the fresh list if it has one. A list that
 * reaches its end while a pull to refresh runs (the refresh trims it to one
 * page, which brings the end near) would otherwise throw the fresh first page
 * away and append a next page to the old one: the refresh would show nothing
 * new, without an error. Merely joining the refetch would drop the page
 * request instead, and a caller that asks once (a search filling a
 * screenful) would stall.
 */
export function useFetchNextPageAfterRefetch<R extends { hasNextPage: boolean; isError: boolean }>(
  key: QueryKey,
  fetchNext: (options?: FetchNextPageOptions) => Promise<R>,
) {
  const client = useQueryClient();
  const hash = hashKey(key);
  return useCallback(
    (options?: FetchNextPageOptions): Promise<R> => {
      const state = client.getQueryCache().get(hash)?.state;
      const refetching = state !== undefined && state.fetchStatus !== 'idle' && state.fetchMeta?.fetchMore === undefined;
      const next = () => fetchNext({ cancelRefetch: false, ...options });
      if (!refetching || options?.cancelRefetch) return next();
      return next().then((result) => (result.hasNextPage && !result.isError ? next() : result));
    },
    [client, hash, fetchNext],
  );
}
