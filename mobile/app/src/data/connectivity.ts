import NetInfo from '@react-native-community/netinfo';

/**
 * What the OS says about connectivity, readable outside React (PRD G-1: a
 * write tap while offline sends nothing). Only a definite "not connected"
 * counts as offline, as compose's Post button reads it; unknown counts as
 * online.
 */

let offline = false;
let stop: (() => void) | null = null;

/** Follows NetInfo for the app's lifetime. Started by `startDataLayer` (and on the first write). */
export function startConnectivity(): () => void {
  stop ??= NetInfo.addEventListener((state) => {
    offline = state.isConnected === false;
  });
  return () => {
    stop?.();
    stop = null;
  };
}

export function isOffline(): boolean {
  startConnectivity();
  return offline;
}
