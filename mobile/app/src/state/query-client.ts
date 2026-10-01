import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { defaultShouldDehydrateQuery, QueryClient } from '@tanstack/react-query';
import type { PersistQueryClientProviderProps } from '@tanstack/react-query-persist-client';

import { config } from '~/config';
import { ENGINE_BUNDLE_HASH } from '~/engine/bundle-hash';

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

const persister = createAsyncStoragePersister({
  key: 'yappr-query-cache',
  storage: syncStorage,
});

/**
 * A cache written by another app version, engine build or network is
 * discarded instead of restored.
 */
export const cacheBuster = `${config.appVersion}:${ENGINE_BUNDLE_HASH}:${config.network}`;

export const persistOptions: PersistQueryClientProviderProps['persistOptions'] = {
  persister,
  maxAge: PERSIST_MAX_AGE_MS,
  buster: cacheBuster,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      query.meta?.persist === true && defaultShouldDehydrateQuery(query),
  },
};

/** Drops every cached query, in memory and on disk. Call on sign-out and account switch. */
export async function clearAccountCache(): Promise<void> {
  queryClient.clear();
  await persister.removeClient();
}
