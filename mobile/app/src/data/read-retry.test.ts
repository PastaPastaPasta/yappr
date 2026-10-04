import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { notifyManager, QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

import { getLogs } from '~/engine/logs';
import { queryClient, retriedReadError } from '~/state/query-client';

import { startConnectivity } from './connectivity';
import { withRetriedError } from './queries';
import { EARLY_RETRY_GAP_MS, NO_READ_RETRY, startReadRetry } from './read-retry';
import { fakeEngine } from './testing/fake-engine';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

/** What a read gets while DAPI stalls: G-11's "temporarily unavailable". */
const unavailable = () => Object.assign(new Error('DAPI request timed out'), { code: 'TIMEOUT' });

const stops: (() => void)[] = [];

/** A screen showing `key`, read by `read`. */
function show(key: string, read: jest.Mock, options: Partial<QueryObserverOptions> = {}) {
  const observer = new QueryObserver(queryClient, { queryKey: ['engine', 'devnet', key], queryFn: read, retry: false, ...options });
  stops.push(observer.subscribe(() => undefined));
  return observer;
}

/** The read-retry's AppState listener. */
const appStateListener = () =>
  jest.mocked(AppState.addEventListener).mock.calls.filter(([type]) => type === 'change').at(-1)![1] as (
    state: AppStateStatus,
  ) => void;

beforeAll(() => notifyManager.setScheduler((callback) => callback()));

beforeEach(() => {
  jest.useFakeTimers();
  queryClient.clear();
  fakeEngine.reset();
  fakeEngine.setStatus({ state: 'ready' });
  stops.push(startReadRetry());
});

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  queryClient.clear();
  jest.useRealTimers();
});

it('reads a list that found Dash Platform unavailable again at 2, 4 and 8 s, then every 30 s, until it answers (NET-03)', async () => {
  const read = jest.fn().mockRejectedValue(unavailable());
  const observer = show('hashtag', read);
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().status).toBe('error');
  expect(read).toHaveBeenCalledTimes(1);

  for (const [wait, calls] of [
    [2_000, 2],
    [4_000, 3],
    [8_000, 4],
    [30_000, 5],
    [30_000, 6],
  ] as const) {
    await jest.advanceTimersByTimeAsync(wait - 1);
    expect(read).toHaveBeenCalledTimes(calls - 1);
    await jest.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(calls);
  }
  expect(getLogs().some((line) => line.message === 'Dash Platform unavailable: retrying 1 failed read')).toBe(true);

  // Platform is back: the list fills by itself, and nothing reads it again.
  read.mockResolvedValue('posts');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(observer.getCurrentResult().data).toBe('posts');
  await jest.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(7);
});

it("shows a retried read as the error it was while the retry runs, not TanStack's pending (NEW-R-A-02)", async () => {
  const key = ['engine', 'devnet', 'hashtag'];
  let fail: (error: Error) => void = () => undefined;
  const read = jest
    .fn()
    .mockRejectedValueOnce(unavailable())
    .mockImplementation(() => new Promise((_, reject) => (fail = reject)));
  const observer = show('hashtag', read);
  await jest.advanceTimersByTimeAsync(0);
  expect(withRetriedError(key, observer.getCurrentResult())).not.toHaveProperty('isRetrying');

  // The backoff's retry stalls: TanStack is back on pending, error cleared; the screen is not.
  await jest.advanceTimersByTimeAsync(2_000);
  expect(observer.getCurrentResult()).toMatchObject({ status: 'pending', error: null });
  expect(withRetriedError(key, observer.getCurrentResult())).toMatchObject({
    status: 'error',
    isError: true,
    isPending: false,
    isLoading: false,
    isRetrying: true,
    error: expect.objectContaining({ code: 'TIMEOUT' }),
  });

  // Settled: the read's own state again.
  fail(unavailable());
  await jest.advanceTimersByTimeAsync(0);
  expect(retriedReadError(key)).toBeUndefined();
  expect(withRetriedError(key, observer.getCurrentResult())).not.toHaveProperty('isRetrying');

  // A read of the screen's own (its "Try again") shows pending as before.
  observer.refetch().catch(() => undefined);
  expect(withRetriedError(key, observer.getCurrentResult()).status).toBe('pending');
  fail(unavailable());
  await jest.advanceTimersByTimeAsync(0);
});

it("lets the reader's own read (\"Try again\") end a stalled retry and read afresh", async () => {
  const key = ['engine', 'devnet', 'hashtag'];
  const stalls: ((error: Error) => void)[] = [];
  const read = jest
    .fn()
    .mockRejectedValueOnce(unavailable())
    .mockImplementation(() => new Promise((_, reject) => stalls.push(reject)));
  const observer = show('hashtag', read);
  await jest.advanceTimersByTimeAsync(2_000);
  const held = withRetriedError(key, observer.getCurrentResult());
  expect(held).toMatchObject({ status: 'error', isRetrying: true });
  expect(read).toHaveBeenCalledTimes(2);

  // TanStack alone would join the stalled retry: no new read, still the hold.
  held.refetch().catch(() => undefined);
  await jest.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  expect(retriedReadError(key)).toBeUndefined();
  expect(withRetriedError(key, observer.getCurrentResult())).toMatchObject({ status: 'pending', fetchStatus: 'fetching' });
  expect(withRetriedError(key, observer.getCurrentResult())).not.toHaveProperty('isRetrying');

  // The cancelled retry's late answer is dropped; the reader's read decides.
  stalls[0](unavailable());
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().fetchStatus).toBe('fetching');
  stalls[1](unavailable());
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult()).toMatchObject({ status: 'error', fetchStatus: 'idle' });
});

it('starts the backoff over for the next outage', async () => {
  const read = jest.fn().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValue('posts');
  const observer = show('hashtag', read);
  await jest.advanceTimersByTimeAsync(2_000 + 4_000);
  expect(observer.getCurrentResult().data).toBe('posts');

  // Another screen, a later outage: its first retry is 2 s away again, not 8 s.
  const next = jest.fn().mockRejectedValueOnce(unavailable()).mockResolvedValue('profile');
  const later = show('profile', next);
  await jest.advanceTimersByTimeAsync(0);
  expect(later.getCurrentResult().status).toBe('error');
  await jest.advanceTimersByTimeAsync(2_000);
  expect(later.getCurrentResult().data).toBe('profile');
});

it('leaves a read that failed for good, one no screen shows, and one still showing its data alone', async () => {
  const refused = jest.fn().mockRejectedValue(Object.assign(new Error('Proof verification failed'), { code: 'PROOF' }));
  show('refused', refused);
  const hidden = jest.fn().mockRejectedValue(unavailable());
  await queryClient.fetchQuery({ queryKey: ['engine', 'devnet', 'hidden'], queryFn: hidden, retry: false }).catch(() => undefined);
  // A cached list whose refresh failed: it shows its posts, not the error.
  queryClient.setQueryData(['engine', 'devnet', 'cached'], 'cached posts');
  const cached = jest.fn().mockRejectedValue(unavailable());
  const shown = show('cached', cached);
  await shown.refetch();
  expect(shown.getCurrentResult()).toMatchObject({ status: 'error', data: 'cached posts' });

  await jest.advanceTimersByTimeAsync(60_000);
  expect(refused).toHaveBeenCalledTimes(1);
  expect(hidden).toHaveBeenCalledTimes(1);
  expect(cached).toHaveBeenCalledTimes(1);
});

it('leaves reads with a schedule of their own alone: a poll, their own backoff, a read embedded in a card', async () => {
  const retried = () => getLogs().filter((line) => line.message.startsWith('Dash Platform unavailable: retrying')).length;
  const before = retried();
  const poll = jest.fn().mockRejectedValue(unavailable());
  show('newPosts', poll, { refetchInterval: 15_000 });
  const dm = jest.fn().mockRejectedValue(unavailable());
  show('dm', dm, { retry: 0, retryDelay: 1_000 });
  const embedded = jest.fn().mockRejectedValue(unavailable());
  show('poll', embedded, { meta: NO_READ_RETRY });
  await jest.advanceTimersByTimeAsync(0);

  await jest.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 30_000);
  // The poll keeps its own 15 s, with nothing on top of it; the others are not read again.
  expect(retried()).toBe(before);
  expect(poll.mock.calls.length).toBeLessThanOrEqual(4);
  expect(dm).toHaveBeenCalledTimes(1);
  expect(embedded).toHaveBeenCalledTimes(1);
});

it('reads a failure every screen shows as "temporarily unavailable" again, an engine turned away included', async () => {
  const busy = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Too many calls waiting'), { code: 'ENGINE_BUSY' })).mockResolvedValue('posts');
  const observer = show('hashtag', busy);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(observer.getCurrentResult().data).toBe('posts');
});

it('sends nothing while offline or with the engine down, and goes on once it can', async () => {
  const stopConnectivity = startConnectivity();
  stops.push(stopConnectivity);
  const report = jest.mocked(NetInfo.addEventListener).mock.calls.at(-1)![0];
  const read = jest.fn().mockRejectedValue(unavailable());
  show('hashtag', read);
  await jest.advanceTimersByTimeAsync(0);

  // The reconnect itself re-reads (connectivity.ts): only the backoff is under test here.
  report({ isConnected: false } as NetInfoState);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(1);

  fakeEngine.setStatus({ state: 'restarting' });
  report({ isConnected: true } as NetInfoState);
  await jest.advanceTimersByTimeAsync(0);
  const afterReconnect = read.mock.calls.length;
  await jest.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(afterReconnect);

  // A degraded engine still reaches Platform: the next step reads again.
  fakeEngine.setStatus({ state: 'degraded' });
  await jest.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(afterReconnect + 1);
});

it('stops in the background and starts over on the return to the foreground', async () => {
  const read = jest.fn().mockRejectedValue(unavailable());
  show('hashtag', read);
  await jest.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
  expect(read).toHaveBeenCalledTimes(4);

  appStateListener()('background');
  await jest.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(4);

  appStateListener()('active');
  await jest.advanceTimersByTimeAsync(2_000);
  expect(read).toHaveBeenCalledTimes(5);
});

it('brings a long wait forward when another read answers, but no sooner than the gap after the last retry', async () => {
  const read = jest.fn().mockRejectedValue(unavailable());
  show('hashtag', read);
  const other = jest.fn().mockResolvedValue('notifications');
  const answering = show('notifications', other);
  await jest.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
  expect(read).toHaveBeenCalledTimes(4);
  // The next retry is 30 s away. Platform answers another read 1 s in.
  await jest.advanceTimersByTimeAsync(1_000);
  read.mockResolvedValue('posts');
  await answering.refetch();

  await jest.advanceTimersByTimeAsync(EARLY_RETRY_GAP_MS - 1_000 - 1);
  expect(read).toHaveBeenCalledTimes(4);
  await jest.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(5);
});
