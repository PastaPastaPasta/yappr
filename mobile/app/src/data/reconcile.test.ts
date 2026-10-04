import { notifyManager } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

import { queryClient } from '~/state/query-client';

import { queryKeys } from './keys';
import {
  RECHECK_GAPS_MS,
  TRIGGER_GAP_MS,
  isExhausted,
  recheck,
  reconcile,
  resetReconciler,
  startReconciler,
  stopReconciling,
  useReconcileStore,
} from './reconcile';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

/** The reconciler's AppState listener. */
const appStateListener = () =>
  jest.mocked(AppState.addEventListener).mock.calls.filter(([type]) => type === 'change').at(-1)![1] as (
    state: AppStateStatus,
  ) => void;

/** A check that answers "still unknown" until told otherwise. */
function job(answer: () => boolean = () => false) {
  return jest.fn(async () => answer());
}

let stop: () => void = () => undefined;

/** When the last automatic check runs: 130 s after the job starts. */
const ALL_CHECKS_MS = RECHECK_GAPS_MS.reduce((sum, gap) => sum + gap, 0);
/** The engine's `ABSENCE_AFTER_MS` (engine `writes/tickets.ts`): before it, a check can only confirm a landing. */
const ENGINE_ABSENCE_AFTER_MS = 2 * 60_000;

beforeAll(() => notifyManager.setScheduler((callback) => callback()));

beforeEach(() => {
  jest.useFakeTimers();
  resetReconciler();
  queryClient.clear();
  stop = startReconciler();
});

afterEach(() => {
  stop();
  resetReconciler();
  jest.useRealTimers();
});

it('checks at 5, 20, 80 and 130 s, and only then says the checks ran out', async () => {
  expect(RECHECK_GAPS_MS).toEqual([5_000, 15_000, 60_000, 50_000]);
  const run = job();
  reconcile('ticket:t1', { run });
  for (const [gap, calls] of [
    [5_000, 1],
    [15_000, 2],
    [60_000, 3],
    [50_000, 4],
  ] as const) {
    await jest.advanceTimersByTimeAsync(gap - 1);
    expect(run).toHaveBeenCalledTimes(calls - 1);
    expect(isExhausted('ticket:t1')).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(calls);
  }
  expect(isExhausted('ticket:t1')).toBe(true);
  // No more automatic checks after that.
  await jest.advanceTimersByTimeAsync(10 * 60_000);
  expect(run).toHaveBeenCalledTimes(4);
});

it('runs its last automatic check past the engine\'s absence window, so a write that never landed can be proved absent', () => {
  // With a margin for the moment the app hears of the ticket after the engine settled it.
  expect(ALL_CHECKS_MS).toBeGreaterThanOrEqual(ENGINE_ABSENCE_AFTER_MS + 10_000);
});

it('stops once a check settles the outcome, and never says anything ran out', async () => {
  let landed = false;
  const run = job(() => landed);
  reconcile('ticket:t2', { run });
  await jest.advanceTimersByTimeAsync(5_000);
  landed = true;
  await jest.advanceTimersByTimeAsync(15_000);
  expect(run).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(isExhausted('ticket:t2')).toBe(false);
});

it('checks every job again when the app comes back to the foreground, also once the checks ran out', async () => {
  let landed = false;
  const run = job(() => landed);
  reconcile('ticket:t3', { run });
  await jest.advanceTimersByTimeAsync(ALL_CHECKS_MS);
  expect(isExhausted('ticket:t3')).toBe(true);

  appStateListener()('background');
  await jest.advanceTimersByTimeAsync(TRIGGER_GAP_MS);
  landed = true;
  appStateListener()('active');
  await jest.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(5);
  // Settled: the job is gone, and with it "ran out".
  expect(isExhausted('ticket:t3')).toBe(false);
  appStateListener()('background');
  appStateListener()('active');
  await jest.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(5);
});

it('checks a job when a feed, profile or thread read shows what it touched, at most every 10 s', async () => {
  const run = job();
  reconcile('ticket:t4', { run, shownIn: (ids) => ids.has('post-1') });
  const feed = queryKeys.feed.home({ tab: 'following' });

  // A read that does not show it, and one of another family, do nothing.
  await queryClient.fetchQuery({ queryKey: feed, queryFn: async () => ({ pages: [{ items: [{ id: 'post-2' }] }] }) });
  await queryClient.fetchQuery({ queryKey: queryKeys.dm.conversations, queryFn: async () => [{ id: 'post-1' }] });
  await jest.advanceTimersByTimeAsync(0);
  expect(run).not.toHaveBeenCalled();

  await queryClient.fetchQuery({
    queryKey: queryKeys.post.thread('root'),
    queryFn: async () => ({ focus: { id: 'root', quoted: { id: 'post-1' } }, replies: { items: [] } }),
  });
  await jest.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);

  // Again right away: within the gap, nothing; after it, checked again.
  await queryClient.fetchQuery({ queryKey: feed, queryFn: async () => ({ pages: [{ items: [{ id: 'post-1' }] }] }), staleTime: 0 });
  await jest.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  // The 5 s automatic check runs; 10 s after it, a read checks again (before the 20 s check).
  await jest.advanceTimersByTimeAsync(5_000 + TRIGGER_GAP_MS);
  expect(run).toHaveBeenCalledTimes(2);
  await queryClient.fetchQuery({ queryKey: feed, queryFn: async () => ({ pages: [{ items: [{ id: 'post-1' }] }] }), staleTime: 0 });
  await jest.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(3);
});

it('checks a message job when its conversation\'s messages are read', async () => {
  const run = job();
  reconcile('ticket:t7', { run, shownIn: (ids) => ids.has('conv-1') });
  await queryClient.fetchQuery({ queryKey: queryKeys.dm.messages('conv-2'), queryFn: async () => ({ pages: [] }) });
  await jest.advanceTimersByTimeAsync(0);
  expect(run).not.toHaveBeenCalled();
  await queryClient.fetchQuery({ queryKey: queryKeys.dm.messages('conv-1'), queryFn: async () => ({ pages: [] }) });
  await jest.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
});

it('never runs out while the write’s own call still runs, and starts over when a new phase begins', async () => {
  const run = job();
  reconcile('ticket:t5', { run, canExhaust: false, episode: 'running' });
  await jest.advanceTimersByTimeAsync(ALL_CHECKS_MS);
  expect(run).toHaveBeenCalledTimes(4);
  expect(isExhausted('ticket:t5')).toBe(false);

  // The call answered, still without proof: the schedule starts again, and may run out now.
  reconcile('ticket:t5', { run, episode: 'settled' });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledTimes(5);
  await jest.advanceTimersByTimeAsync(ALL_CHECKS_MS - 5_000);
  expect(isExhausted('ticket:t5')).toBe(true);
  // The same phase again keeps the schedule (no restart).
  reconcile('ticket:t5', { run, episode: 'settled' });
  expect(isExhausted('ticket:t5')).toBe(true);
});

it('checks on a tap, showing "checking" meanwhile, and a tap during a check runs no second one', async () => {
  let finish: (settled: boolean) => void = () => undefined;
  const run = jest.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
  reconcile('dm.send:local:1', { run });
  const first = recheck('dm.send:local:1');
  const second = recheck('dm.send:local:1');
  expect(run).toHaveBeenCalledTimes(1);
  expect(useReconcileStore.getState().checking['dm.send:local:1']).toBe(true);
  finish(true);
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(true);
  expect(useReconcileStore.getState().checking['dm.send:local:1']).toBeUndefined();
  // Nothing reconciles it any more.
  await expect(recheck('dm.send:local:1')).resolves.toBeNull();
});

it('treats a check that could not run as no answer, and forgets a job that was stopped', async () => {
  const run = jest.fn(async () => {
    throw new Error('engine gone');
  });
  reconcile('ticket:t6', { run });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledTimes(1);
  stopReconciling('ticket:t6');
  await jest.advanceTimersByTimeAsync(ALL_CHECKS_MS);
  expect(run).toHaveBeenCalledTimes(1);
  expect(isExhausted('ticket:t6')).toBe(false);
});
