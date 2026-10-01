import { useEffect, useReducer } from 'react';

import { formatTimeCompact } from '~/lib-allowlist';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Milliseconds until the compact label next changes, or null once it is a
 * fixed date (older than a week). Ported from web hooks/use-relative-time.
 */
export function nextUpdateDelayMs(dateMs: number, nowMs: number): number | null {
  const elapsed = Math.floor((nowMs - dateMs) / 1000);
  if (elapsed < MINUTE) return 1000;
  if (elapsed < HOUR) return (MINUTE - (elapsed % MINUTE)) * 1000;
  if (elapsed < DAY) return (HOUR - (elapsed % HOUR)) * 1000;
  if (elapsed < WEEK) return (DAY - (elapsed % DAY)) * 1000;
  return null;
}

/**
 * The live compact time of a post ("30s", "5m", "3h", "2d", then "Mar 4"),
 * re-rendering only when the label changes.
 */
export function useRelativeTime(date: Date): string {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const dateMs = date.getTime();

  useEffect(() => {
    if (!Number.isFinite(dateMs)) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delay = nextUpdateDelayMs(dateMs, Date.now());
      if (delay === null) return;
      timer = setTimeout(() => {
        tick();
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [dateMs]);

  return Number.isFinite(dateMs) ? formatTimeCompact(date) : '';
}
