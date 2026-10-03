import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

/** How often a compact time ("30s", "5m", "3h", "2d", "Mar 4") can change. */
export type ClockCadence = 'second' | 'minute';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS;

/**
 * How often the compact label of a time `elapsedMs` ago can change: each
 * second under a minute, then each minute (minutes, hours, days), and never
 * once it is a fixed date (older than a week). A time ahead of this device's
 * clock reads "0s" until it is reached: a few seconds ahead (a block time
 * against a slow clock) still ticks each second, but a badly skewed clock
 * can put it hours ahead, so past a minute it is checked each minute.
 */
export function relativeTimeCadence(elapsedMs: number): ClockCadence | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs >= WEEK_MS) return null;
  return Math.abs(elapsedMs) < MINUTE_MS ? 'second' : 'minute';
}

interface Subscriber {
  sinceMs: number;
  cadence: ClockCadence | null;
  listener: () => void;
}

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** The cadence the pending timer was set for. */
let scheduled: ClockCadence | null = null;
let lastMinute = 0;
let appState: NativeEventSubscription | null = null;
let backgrounded = false;

const has = (cadence: ClockCadence): boolean => [...subscribers].some((s) => s.cadence === cadence);

/** One timer for every subscriber, at the fastest cadence any of them needs; none in the background. */
function schedule(): void {
  clearTimeout(timer);
  timer = undefined;
  scheduled = backgrounded ? null : has('second') ? 'second' : has('minute') ? 'minute' : null;
  if (!scheduled) return;
  const now = Date.now();
  const delay = scheduled === 'second' ? SECOND_MS - (now % SECOND_MS) : MINUTE_MS - (now % MINUTE_MS);
  timer = setTimeout(tick, delay);
}

/**
 * Calls the subscribers whose label may have changed: every one on a
 * second cadence (including one that just turned a minute old), and on a new
 * wall-clock minute (or `all`) every one on a minute cadence.
 */
function notify(all: boolean): void {
  const now = Date.now();
  const minute = Math.floor(now / MINUTE_MS);
  const newMinute = all || minute !== lastMinute;
  lastMinute = minute;
  for (const subscriber of [...subscribers]) {
    const due = subscriber.cadence === 'second' || (newMinute && subscriber.cadence === 'minute');
    if (!due) continue;
    subscriber.cadence = relativeTimeCadence(now - subscriber.sinceMs);
    subscriber.listener();
  }
}

function tick(): void {
  timer = undefined;
  notify(false);
  schedule();
}

/** Timers do not run in the background; back in front, every label catches up at once. */
function onAppState(next: AppStateStatus): void {
  if (next === 'background') {
    backgrounded = true;
    schedule();
  } else if (next === 'active' && backgrounded) {
    backgrounded = false;
    notify(true);
    schedule();
  }
}

/**
 * Calls `listener` whenever the compact label of a time at `sinceMs` can
 * have changed, on the app's one shared clock: each second while it is under
 * a minute old, then on each wall-clock minute, and never once it is a fixed
 * date. However many times are on screen there is a single timer, and it
 * stops while the app is in the background. Returns the unsubscribe.
 */
export function subscribeToClock(sinceMs: number, listener: () => void): () => void {
  const now = Date.now();
  const subscriber: Subscriber = { sinceMs, cadence: relativeTimeCadence(now - sinceMs), listener };
  if (!subscriber.cadence) return () => undefined;
  subscribers.add(subscriber);
  if (!appState) {
    backgrounded = AppState.currentState === 'background';
    lastMinute = Math.floor(now / MINUTE_MS);
    appState = AppState.addEventListener('change', onAppState);
  }
  // Only a faster cadence (or none pending) needs a new timer.
  if (scheduled !== 'second' && scheduled !== subscriber.cadence) schedule();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    clearTimeout(timer);
    timer = undefined;
    scheduled = null;
    appState?.remove();
    appState = null;
  };
}
