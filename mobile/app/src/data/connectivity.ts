import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

import { appendLog, errorMessage } from '~/engine/logs';
import { refetchFailedReads } from '~/state/query-client';

/**
 * What the OS says about connectivity, readable outside React (PRD G-1: a
 * write tap while offline sends nothing). Only a definite "not connected"
 * counts as offline, as compose's Post button reads it; unknown counts as
 * online.
 *
 * It also drives TanStack's `onlineManager` (React Native has no browser
 * `online` event), so queries' `refetchOnReconnect` works, and when
 * connectivity returns the reads a screen shows that failed are read again
 * once (PRD G-1: "visible lists refresh once").
 */

let offline = false;
let stop: (() => void) | null = null;

/**
 * Follows NetInfo for the app's lifetime. Started by `startDataLayer` (and on
 * the first write). The offline flag has its own NetInfo listener and only
 * forwards its value to TanStack's `onlineManager` (replacing its browser
 * listener), so it stays current even while TanStack has nothing subscribed
 * (it drops its event source then, e.g. when the query provider unmounts).
 */
export function startConnectivity(): () => void {
  if (!stop) {
    let setOnline: ((online: boolean) => void) | null = null;
    const stopNetInfo = NetInfo.addEventListener((state) => {
      const wasOffline = offline;
      offline = state.isConnected === false;
      setOnline?.(!offline);
      if (wasOffline && !offline) {
        refetchFailedReads('Back online').catch((error: unknown) =>
          appendLog('warn', 'host', `Reading again after reconnecting failed: ${errorMessage(error)}`),
        );
      }
    });
    onlineManager.setEventListener((set) => {
      setOnline = set;
      set(!offline);
      return () => {
        if (setOnline === set) setOnline = null;
      };
    });
    stop = () => {
      stopNetInfo();
      onlineManager.setEventListener(() => undefined);
    };
  }
  return () => {
    stop?.();
    stop = null;
  };
}

export function isOffline(): boolean {
  startConnectivity();
  return offline;
}
