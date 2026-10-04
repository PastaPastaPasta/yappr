import { AppState, type AppStateStatus } from 'react-native';
import { create } from 'zustand';

import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';

/**
 * The write reconciler (PRD G-3, src/data/README.md "Writes"): a write whose
 * outcome is unknown (the DAPI wait timed out, an engine restart cut the call
 * short) is checked again by the app, never by the user. Each such write is a
 * job, keyed by what it follows (`ticket:<id>`, a post or a message whose call
 * never named its ticket). A job runs its check:
 *
 * - automatically, `RECHECK_GAPS_MS` apart (5, 20, 80 and 130 s after it
 *   starts);
 * - when the app comes back to the foreground;
 * - when a feed, profile or thread read shows what the write touched, or a
 *   conversation's messages are read (`shownIn`).
 *
 * A check that settles the outcome (landed, or proved absent) ends the job.
 * Once the automatic checks are used up without an answer, the job is
 * `exhausted`: only then may a screen say so ("Couldn't confirm"). It keeps
 * being checked on foreground and on reads, so a write that turns up later
 * still settles by itself. Nothing here ever re-sends a write.
 */

/**
 * The gaps before each automatic check: at 5, 20, 80 and 130 s after the job
 * starts. The engine calls a write absent only once its attempt stopped at
 * least 2 minutes before (`ABSENCE_AFTER_MS`, engine `writes/tickets.ts`):
 * the earlier checks can only confirm a landing, and the last one, past that
 * window, can also prove it never landed (Retry), so "Couldn't confirm" is
 * left for what no read can tell.
 */
export const RECHECK_GAPS_MS: readonly number[] = [5_000, 15_000, 60_000, 50_000];
/** A foreground or a read checks one job again at most this often. */
export const TRIGGER_GAP_MS = 10_000;
/** A scheduled check that finds a check already running waits this long. */
const BUSY_RETRY_MS = 1_000;

export interface ReconcileJob {
  /** One check. Resolves true once the outcome is known (or the job no longer matters). */
  run: () => Promise<boolean>;
  /** Whether a read whose data holds these ids shows this write. Without it, reads never trigger it. */
  shownIn?: (ids: ReadonlySet<string>) => boolean;
  /**
   * False while the write's own call still runs (the engine's `STILL_SENDING`):
   * its answer will settle it, so its checks never run out.
   */
  canExhaust?: boolean;
  /** The phase the write is in; a new phase starts the schedule again (a stalled call that answered). */
  episode?: string;
}

interface Job extends ReconcileJob {
  step: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<boolean> | null;
  lastRun: number;
}

const jobs = new Map<string, Job>();

/** What screens may show: a check running (a spinner on a tap), and jobs whose automatic checks ran out. */
export const useReconcileStore = create<{
  checking: Readonly<Record<string, true>>;
  exhausted: Readonly<Record<string, true>>;
}>()(() => ({ checking: {}, exhausted: {} }));

function mark(field: 'checking' | 'exhausted', key: string, on: boolean): void {
  useReconcileStore.setState((state) => {
    const current = state[field];
    if (Boolean(current[key]) === on) return state;
    const { [key]: _dropped, ...rest } = current;
    return { [field]: on ? { ...current, [key]: true } : rest };
  });
}

/** The job key for a write ticket. */
export const ticketJob = (ticketId: string) => `ticket:${ticketId}`;

export function isExhausted(key: string): boolean {
  return useReconcileStore.getState().exhausted[key] === true;
}

function schedule(key: string, job: Job, delay: number): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    job.timer = null;
    if (jobs.get(key) !== job) return;
    if (job.running) {
      schedule(key, job, BUSY_RETRY_MS);
      return;
    }
    runJob(key, job, true).catch(() => undefined);
  }, delay);
}

/**
 * Starts reconciling `key`, or keeps the schedule of the job already there
 * (taking the new `run` and `shownIn`), unless its episode changed.
 */
export function reconcile(key: string, spec: ReconcileJob): void {
  const known = jobs.get(key);
  if (known && known.episode === spec.episode) {
    known.run = spec.run;
    known.shownIn = spec.shownIn;
    known.canExhaust = spec.canExhaust;
    return;
  }
  if (known?.timer) clearTimeout(known.timer);
  mark('exhausted', key, false);
  const job: Job = { ...spec, step: 0, timer: null, running: null, lastRun: 0 };
  jobs.set(key, job);
  schedule(key, job, RECHECK_GAPS_MS[0]);
}

/** The outcome is known (or no longer matters): no more checks. */
export function stopReconciling(key: string): void {
  const job = jobs.get(key);
  if (job?.timer) clearTimeout(job.timer);
  jobs.delete(key);
  mark('exhausted', key, false);
  mark('checking', key, false);
}

async function runJob(key: string, job: Job, scheduled: boolean): Promise<boolean> {
  if (job.running) return job.running;
  job.lastRun = Date.now();
  mark('checking', key, true);
  const running = job.run().catch((error: unknown) => {
    // A check that could not run proves nothing: the write stays where it was.
    appendLog('warn', 'host', `Checking a write failed: ${errorMessage(error)}`);
    return false;
  });
  job.running = running;
  const settled = await running;
  job.running = null;
  // Stopped or restarted meanwhile (its ticket settled, or a new episode began): that has the last word.
  if (jobs.get(key) !== job) return settled;
  mark('checking', key, false);
  if (settled) {
    stopReconciling(key);
    return true;
  }
  if (!scheduled) return false;
  job.step += 1;
  if (job.step < RECHECK_GAPS_MS.length) schedule(key, job, RECHECK_GAPS_MS[job.step]);
  else if (job.canExhaust !== false) mark('exhausted', key, true);
  return false;
}

/**
 * Checks `key` now (a tap on "Couldn't confirm · Tap to check"). Resolves
 * true once its outcome is known, null when nothing reconciles it.
 */
export async function recheck(key: string): Promise<boolean | null> {
  const job = jobs.get(key);
  return job ? runJob(key, job, false) : null;
}

/**
 * The app came to the foreground, or a read showed data: every job it
 * concerns is checked, unless one ran in the last `TRIGGER_GAP_MS`.
 */
export function recheckAll(trigger: 'foreground' | 'read', ids?: ReadonlySet<string>): void {
  const now = Date.now();
  for (const [key, job] of [...jobs]) {
    if (job.running || now - job.lastRun < TRIGGER_GAP_MS) continue;
    if (trigger === 'read' && !(ids && job.shownIn?.(ids))) continue;
    runJob(key, job, false).catch(() => undefined);
  }
}

/** Forgets every job (an account change: none of the last account's writes is this one's). */
export function resetReconciler(): void {
  for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer);
  jobs.clear();
  useReconcileStore.setState({ checking: {}, exhausted: {} });
}

/** Every `id` string in a read's data (pages, a thread's focus and replies, quoted posts). */
function idsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) idsIn(item, into);
  } else if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    for (const [field, child] of Object.entries(value)) {
      if (field === 'id' && typeof child === 'string') into.add(child);
      else if (typeof child === 'object') idsIn(child, into);
    }
  }
  return into;
}

/**
 * What a read shows, for jobs' `shownIn`: every id in a feed, profile or
 * thread read (posts and what was done to them), a conversation's key for
 * its messages. Null for any other read.
 */
function shownBy(key: readonly unknown[], data: unknown): Set<string> | null {
  const family = key[2];
  if (family === 'feed' || family === 'profile' || family === 'post') return idsIn(data);
  if (family === 'dm' && key[3] === 'messages' && typeof key[4] === 'string') return new Set([key[4]]);
  return null;
}

let stopTriggers: (() => void) | null = null;

/** Wires the foreground and read triggers for the app's lifetime. Started by `startDataLayer`. */
export function startReconciler(): () => void {
  if (!stopTriggers) {
    let foreground = AppState.currentState === 'active';
    const appState = AppState.addEventListener('change', (next: AppStateStatus) => {
      const back = next === 'active' && !foreground;
      foreground = next === 'active';
      if (back) recheckAll('foreground');
    });
    const stopCache = queryClient.getQueryCache().subscribe((event) => {
      if (jobs.size === 0 || event.type !== 'updated' || event.action.type !== 'success') return;
      const shown = shownBy(event.query.queryKey, event.query.state.data);
      if (shown) recheckAll('read', shown);
    });
    stopTriggers = () => {
      appState.remove();
      stopCache();
    };
  }
  return () => {
    stopTriggers?.();
    stopTriggers = null;
  };
}
