import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { notifyManager, QueryObserver } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

import { getLogs } from '~/engine/logs';
import { queryClient } from '~/state/query-client';

import { startConnectivity } from './connectivity';
import { EARLY_RETRY_GAP_MS, startReadRetry } from './read-retry';
import { fakeEngine } from './testing/fake-engine';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

/** What a read gets while DAPI stalls: G-11's "temporarily unavailable". */
const unavailable = () => Object.assign(new Error('DAPI request timed out'), { code: 'TIMEOUT' });

const stops: (() => void)[] = [];

/** A screen showing `key`, read by `read`. */
function show(key: string, read: jest.Mock) {
  const observer = new QueryObserver(queryClient, { queryKey: ['engine', 'devnet', key], queryFn: read, retry: false });
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
