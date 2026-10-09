import { act } from '@testing-library/react-native';

import { queryClient } from '~/state/query-client';

/**
 * The app's own UI-level retry (`state/query-client.ts`), read as this module
 * loads: before the screen tests' `beforeAll` turns retries off.
 */
const PRODUCTION_RETRY = queryClient.getDefaultOptions().queries?.retry;

/** Retry failed reads as the app does, for reads set up after this call. */
export function withProductionRetry(): void {
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: PRODUCTION_RETRY } });
}

/** No UI-level retry again (the screen tests' default), on the real clock. */
export function withoutRetry(): void {
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  jest.useRealTimers();
}

/**
 * Lets TanStack's first retry run, its default delay being a second, on
 * Jest's fake clock (`renderRouter` turns it on; elsewhere, turn it on first).
 */
export const waitOutRetry = () =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(1_000);
  });
