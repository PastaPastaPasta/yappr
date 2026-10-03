import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * When the relative label of a time at `sinceMs`, read at `nowMs`, next
 * changes ("30s" to "31s", "5m" to "6m", "3h" to "4h", "2d" to "3d"; the
 * spoken "5 minutes ago" turns at the same moments), or null once it is a
 * fixed date (a week old). Each label turns on the time's own boundary, as
 * on web (hooks/use-relative-time). A time ahead of this device's clock
 * ticks each second within a minute of it; a badly skewed clock can put it
 * hours ahead, so until then it waits.
 */
export function nextLabelChangeAt(sinceMs: number, nowMs: number): number | null {
  const elapsed = nowMs - sinceMs;
  if (!Number.isFinite(elapsed) || elapsed >= WEEK_MS) return null;
  if (elapsed < -MINUTE_MS) return sinceMs - MINUTE_MS;
  const unit = elapsed < MINUTE_MS ? SECOND_MS : elapsed < HOUR_MS ? MINUTE_MS : elapsed < DAY_MS ? HOUR_MS : DAY_MS;
  return sinceMs + (Math.floor(elapsed / unit) + 1) * unit;
}

interface Subscriber {
  sinceMs: number;
  /** When its label next changes; null once it never will. */
  dueAt: number | null;
  listener: () => void;
}

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** When the pending timer fires; null when none is pending. */
let timerAt: number | null = null;
let appState: NativeEventSubscription | null = null;
let backgrounded = false;

/** One timer for every subscriber, set for the earliest label change; none in the background. */
function schedule(): void {
  clearTimeout(timer);
  timer = undefined;
  timerAt = null;
  if (backgrounded) return;
  let next = Infinity;
  for (const { dueAt } of subscribers) if (dueAt !== null && dueAt < next) next = dueAt;
  if (next === Infinity) return;
  timerAt = next;
  timer = setTimeout(tick, Math.max(0, next - Date.now()));
}

/** Calls the subscribers whose label is due to change (or, with `all`, every one). */
function notify(all: boolean): void {
  const now = Date.now();
  for (const subscriber of [...subscribers]) {
    if (!all && (subscriber.dueAt === null || subscriber.dueAt > now)) continue;
    subscriber.dueAt = nextLabelChangeAt(subscriber.sinceMs, now);
    subscriber.listener();
  }
}

function tick(): void {
  timer = undefined;
  timerAt = null;
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
 * Calls `listener` whenever the relative label of a time at `sinceMs`
 * changes, on the app's one shared clock: however many times are on screen
 * there is a single timer, set for the next label among them to change, and
 * none while the app is in the background or once every label is a fixed
 * date. Returns the unsubscribe.
 */
export function subscribeToClock(sinceMs: number, listener: () => void): () => void {
  const subscriber: Subscriber = { sinceMs, dueAt: nextLabelChangeAt(sinceMs, Date.now()), listener };
  if (subscriber.dueAt === null) return () => undefined;
  subscribers.add(subscriber);
  if (!appState) {
    backgrounded = AppState.currentState === 'background';
    appState = AppState.addEventListener('change', onAppState);
  }
  // Only a change due before the pending timer needs a new one.
  if (timerAt === null || subscriber.dueAt < timerAt) schedule();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    clearTimeout(timer);
    timer = undefined;
    timerAt = null;
    appState?.remove();
    appState = null;
  };
}
