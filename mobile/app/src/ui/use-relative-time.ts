import { useCallback, useSyncExternalStore } from 'react';

import { formatTime, formatTimeCompact } from '~/lib-allowlist';

import { subscribeToClock } from './clock';

/**
 * `compact` is the visible time ("30s", "5m", "3h", "2d", then "Mar 4");
 * `spoken` is the screen-reader form ("5 minutes ago"), since "5m" reads as
 * "5 meters".
 */
export type RelativeTimeStyle = 'compact' | 'spoken';

/**
 * The live relative time of a post (empty without one), kept current by the
 * shared clock (`./clock`), not a timer per post.
 *
 * The label is the store's snapshot: it reads the time, so it is never
 * computed in the render body, where the React Compiler would memoize it on
 * `date` alone and freeze it (QA D-L3i-007). React re-renders only when a
 * tick actually changes the label.
 */
export function useRelativeTime(date: Date | null, style: RelativeTimeStyle = 'compact'): string {
  const dateMs = date ? date.getTime() : Number.NaN;
  const subscribe = useCallback((listener: () => void) => subscribeToClock(dateMs, listener), [dateMs]);
  return useSyncExternalStore(subscribe, () => {
    if (!Number.isFinite(dateMs)) return '';
    return style === 'spoken' ? formatTime(new Date(dateMs)) : formatTimeCompact(new Date(dateMs));
  });
}
