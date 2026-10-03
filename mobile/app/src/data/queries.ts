import type { EngineApi } from '@engine/api';
import type { Page } from '@engine/api/dto';
import type { Remote } from '@engine/rpc/client';
import {
  queryOptions,
  useInfiniteQuery,
  type FetchNextPageOptions,
  useQuery,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { engine } from '~/engine';
import { persistedQuery } from '~/state/query-client';

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

/** `useQuery` over an engine read; see {@link engineQueryOptions}. */
export function useEngineQuery<T, S = T>(
  key: QueryKey,
  read: (api: EngineRemote) => Promise<T>,
  options?: EngineQueryOptions<T, S>,
) {
  return useQuery(engineQueryOptions(key, read, options));
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
 * `fetchNextPage` joins a refetch in flight instead of cancelling it
 * (TanStack's default `cancelRefetch: true`): a list that reaches its end
 * while a pull to refresh runs (the refresh trims it to one page, which
 * brings the end near) would otherwise throw the fresh first page away and
 * append a next page to the old one, and the refresh would show nothing
 * new without an error.
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
  const { fetchNextPage: fetchNext } = query;
  const fetchNextPage = useCallback(
    (options?: FetchNextPageOptions) => fetchNext({ cancelRefetch: false, ...options }),
    [fetchNext],
  );
  return { ...query, items, fetchNextPage };
}
