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
let started = false;

/**
 * Follows NetInfo for the app's lifetime, as TanStack's `onlineManager`
 * event source (replacing its browser listener). Started by
 * `startDataLayer` (and on the first write).
 */
export function startConnectivity(): () => void {
  if (!started) {
    started = true;
    onlineManager.setEventListener((setOnline) =>
      NetInfo.addEventListener((state) => {
        const wasOffline = offline;
        offline = state.isConnected === false;
        setOnline(!offline);
        if (wasOffline && !offline) {
          refetchFailedReads('Back online').catch((error: unknown) =>
            appendLog('warn', 'host', `Reading again after reconnecting failed: ${errorMessage(error)}`),
          );
        }
      }),
    );
  }
  return () => {
    if (!started) return;
    started = false;
    // Runs the NetInfo unsubscribe the listener above returned.
    onlineManager.setEventListener(() => undefined);
  };
}

export function isOffline(): boolean {
  startConnectivity();
  return offline;
}
