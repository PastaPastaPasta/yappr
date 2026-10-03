import { useCallback, useSyncExternalStore } from 'react';

import { formatTimeCompact } from '~/lib-allowlist';

import { subscribeToClock } from './clock';

/**
 * The live compact time of a post ("30s", "5m", "3h", "2d", then "Mar 4"),
 * kept current by the shared clock (`./clock`), not a timer per post.
 *
 * The label is the store's snapshot: it reads the time, so it is never
 * computed in the render body, where the React Compiler would memoize it on
 * `date` alone and freeze it (QA D-L3i-007). React re-renders only when a
 * tick actually changes the label.
 */
export function useRelativeTime(date: Date): string {
  const dateMs = date.getTime();
  const subscribe = useCallback((listener: () => void) => subscribeToClock(dateMs, listener), [dateMs]);
  return useSyncExternalStore(subscribe, () => (Number.isFinite(dateMs) ? formatTimeCompact(new Date(dateMs)) : ''));
}
