import type { Query } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

import { engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { failedReadCount, queryClient, refetchFailedReads } from '~/state/query-client';

import { isOffline } from './connectivity';
import { isTemporaryReadFailure } from './read-error';

/** PRD NET-03: the waits before each retry of reads that found Dash Platform unavailable; the last repeats. */
export const READ_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 30_000] as const;

/**
 * A read that answers shows Dash Platform is back: a retry waiting longer
 * than the first step is brought forward to it, but never sooner than this
 * after the last retry, so a steady stream of answers can't turn the backoff
 * into a loop.
 */
export const EARLY_RETRY_GAP_MS = 8_000;

const SHORTEST = READ_RETRY_DELAYS_MS[0];

/**
 * A failed read showing G-11's inline error for an unavailable Platform. A
 * read that still has data shows it (a failed refresh was a toast), and
 * re-reading a list whole would reshuffle it under the reader: its next
 * pull to refresh, or the reconnect and engine re-reads, bring it up to date.
 */
const unavailableInline = (query: Query) => query.state.data === undefined && isTemporaryReadFailure(query.state.error);

/**
 * Reads a screen shows that failed because Dash Platform could not be
 * reached (G-11's "temporarily unavailable") are read again by themselves
 * (PRD NET-03): 2 s, 4 s, 8 s, then every 30 s, while the app is in the
 * foreground, until none is left failing. With a stalled DAPI the OS still
 * reports a connection and the engine stays up, so neither "Back online"
 * (`connectivity.ts`) nor "Engine ready" (`sync.ts`) would ever re-read them.
 *
 * - "A screen shows" is TanStack's active queries: the screens mounted in
 *   the tab stacks. Only reads showing the inline error are retried
 *   ({@link unavailableInline}); a list whose next page failed keeps its
 *   "Load More".
 * - Offline, or with the engine down, a retry sends nothing and the backoff
 *   goes on: going back online and the engine coming up re-read every
 *   failed read themselves.
 * - A retry joins a read already in flight rather than starting another, so
 *   a stalled read that takes a minute to fail holds the next retry back
 *   until it has.
 * - The backoff starts over once nothing is failing, and on every return to
 *   the foreground. Another read answering brings a long wait forward
 *   ({@link EARLY_RETRY_GAP_MS}).
 *
 * Started once by `startDataLayer`; returns the stop.
 */
export function startReadRetry(): () => void {
  const now = () => Date.now();
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = 0;
  let lastRetryAt = Number.NEGATIVE_INFINITY;
  let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';

  const failing = () => failedReadCount(unavailableInline) > 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = (delay: number) => {
    cancel();
    dueAt = now() + delay;
    timer = setTimeout(retry, delay);
  };

  /** Arms the next step unless one is already waiting; with nothing failing, starts the backoff over. */
  const schedule = () => {
    if (timer || !foreground) return;
    if (!failing()) {
      attempt = 0;
      return;
    }
    arm(READ_RETRY_DELAYS_MS[Math.min(attempt, READ_RETRY_DELAYS_MS.length - 1)]);
  };

  function retry() {
    timer = null;
    if (!foreground) return;
    attempt += 1;
    const { state } = engineSupervisor.getStatus();
    if (isOffline() || (state !== 'ready' && state !== 'degraded')) {
      // Nothing to reach Platform with: wait for the next step.
      schedule();
      return;
    }
    lastRetryAt = now();
    refetchFailedReads('Dash Platform unavailable', unavailableInline)
      .catch((error: unknown) => appendLog('warn', 'host', `Reading again after Dash Platform was unavailable failed: ${errorMessage(error)}`))
      .finally(schedule);
  }

  /** A read answered from Dash Platform. */
  const answered = () => {
    if (!failing()) {
      cancel();
      attempt = 0;
      return;
    }
    const at = now();
    const soonest = Math.max(at + SHORTEST, lastRetryAt + EARLY_RETRY_GAP_MS);
    if (timer && dueAt > soonest) arm(soonest - at);
  };

  const stopCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated') {
      if (event.action.type === 'error') schedule();
      // `manual` is the app's own setQueryData (an optimistic change), not an answer.
      else if (event.action.type === 'success' && !event.action.manual) answered();
    } else if (event.type === 'observerAdded' && event.query.state.status === 'error') {
      // A screen opened on a read that had already failed.
      schedule();
    }
  });

  const appState = AppState.addEventListener('change', (next: AppStateStatus) => {
    foreground = next === 'active';
    cancel();
    if (!foreground) return;
    attempt = 0;
    schedule();
  });

  schedule();
  return () => {
    cancel();
    stopCache();
    appState.remove();
  };
}
