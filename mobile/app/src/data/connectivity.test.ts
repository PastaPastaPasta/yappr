import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import { isOffline, startConnectivity } from './connectivity';

it('counts only a definite "not connected" as offline, and follows NetInfo once', () => {
  const stop = startConnectivity();
  startConnectivity();
  expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
  const listener = jest.mocked(NetInfo.addEventListener).mock.calls[0]![0];
  const report = (isConnected: boolean | null) => listener({ isConnected } as NetInfoState);

  expect(isOffline()).toBe(false);
  report(false);
  expect(isOffline()).toBe(true);
  report(null);
  expect(isOffline()).toBe(false);
  stop();
});
