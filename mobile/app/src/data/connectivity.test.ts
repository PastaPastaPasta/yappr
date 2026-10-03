import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager, QueryObserver } from '@tanstack/react-query';

import { queryClient } from '~/state/query-client';

import { isOffline, startConnectivity } from './connectivity';

it('counts only a definite "not connected" as offline, and follows NetInfo once', () => {
  const stop = startConnectivity();
  startConnectivity();
  expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
  const listener = jest.mocked(NetInfo.addEventListener).mock.calls.at(-1)![0];
  const report = (isConnected: boolean | null) => listener({ isConnected } as NetInfoState);

  expect(isOffline()).toBe(false);
  report(false);
  expect(isOffline()).toBe(true);
  report(null);
  expect(isOffline()).toBe(false);
  stop();
});

it('drives TanStack online state, and re-reads failed reads a screen shows when connectivity returns (G-1)', async () => {
  const stop = startConnectivity();
  const listener = jest.mocked(NetInfo.addEventListener).mock.calls.at(-1)![0];
  const report = (isConnected: boolean | null) => listener({ isConnected } as NetInfoState);
  const read = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('feed');
  const observer = new QueryObserver(queryClient, { queryKey: ['engine', 'test', 'feed'], queryFn: read, retry: false });
  const unsubscribe = observer.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observer.getCurrentResult().status).toBe('error');

  report(false);
  expect(onlineManager.isOnline()).toBe(false);
  report(true);
  expect(onlineManager.isOnline()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(read).toHaveBeenCalledTimes(2);
  expect(observer.getCurrentResult().data).toBe('feed');

  unsubscribe();
  queryClient.clear();
  stop();
});

it('keeps the offline flag current while TanStack has dropped its event source', () => {
  const stop = startConnectivity();
  const subscriptions = jest.mocked(NetInfo.addEventListener).mock.calls.length;
  const listener = jest.mocked(NetInfo.addEventListener).mock.calls.at(-1)![0];
  const stopNetInfo = jest.mocked(NetInfo.addEventListener).mock.results.at(-1)!.value as jest.Mock;
  stopNetInfo.mockClear();
  const report = (isConnected: boolean | null) => listener({ isConnected } as NetInfoState);

  // The last TanStack subscriber leaving (the query provider unmounting) runs the event source's cleanup:
  // NetInfo is still followed.
  const unsubscribe = onlineManager.subscribe(() => undefined);
  unsubscribe();
  expect(stopNetInfo).not.toHaveBeenCalled();
  report(false);
  expect(isOffline()).toBe(true);
  expect(NetInfo.addEventListener).toHaveBeenCalledTimes(subscriptions);

  // A new subscriber gets the current state.
  const again = onlineManager.subscribe(() => undefined);
  expect(onlineManager.isOnline()).toBe(false);
  report(true);
  expect(onlineManager.isOnline()).toBe(true);
  again();
  stop();
  expect(stopNetInfo).toHaveBeenCalledTimes(1);
});
