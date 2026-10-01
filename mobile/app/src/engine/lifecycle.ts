import NetInfo from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';

import { withBackgroundTask } from '../../modules/background-flush';

import { appendLog, errorMessage } from './logs';
import type { EngineSupervisor } from './supervisor';

/** How long the app holds the background window for the engine's flush (ENGINE.md §3.4, §9.3). */
export const BACKGROUND_FLUSH_MS = 2000;

/**
 * Replays React Native's AppState and NetInfo into the engine:
 *
 * - background: `engine.lifecycle('background')` (the engine fires
 *   `visibilitychange` and `pagehide`, so lib flushes), then wait for the
 *   storage writes it caused to be durable; at most 2 s, inside an iOS
 *   background task. Pings pause.
 * - active: `engine.lifecycle('active')`, and an immediate ping, so a
 *   WebContent process the OS killed while suspended is noticed at once.
 * - connectivity: `engine.connectivity(online)`; coming back online finishes
 *   a boot that failed offline.
 */
export function bridgeLifecycle(supervisor: EngineSupervisor<unknown>, storageIdle: () => Promise<void>): () => void {
  let backgrounded = AppState.currentState === 'background';
  // Launched in the background (iOS prewarm, a background launch): a failed start then waits for
  // the foreground instead of crash-looping on a locked Keychain.
  if (backgrounded) supervisor.setForeground(false);

  const flush = () =>
    withBackgroundTask(async () => {
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        // The storage wait runs even if the engine is down or the call fails: earlier secure
        // writes may still be landing.
        supervisor
          .background()
          .catch((error: unknown) => appendLog('warn', 'host', `Background lifecycle: ${errorMessage(error)}`))
          .then(storageIdle)
          .then(
          () => 'flushed',
          (error: unknown) => `failed (${errorMessage(error)})`,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('timed out'), BACKGROUND_FLUSH_MS);
        }),
      ]);
      clearTimeout(timer);
      appendLog(outcome === 'flushed' ? 'info' : 'warn', 'host', `Background flush ${outcome} in ${Date.now() - started} ms`);
    });

  // iOS may pass through `inactive` both ways; only background ⇄ active matters.
  const appState = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'background' && !backgrounded) {
      backgrounded = true;
      supervisor.setForeground(false);
      flush().catch((error: unknown) => appendLog('warn', 'host', `Background flush: ${errorMessage(error)}`));
    } else if (next === 'active' && backgrounded) {
      backgrounded = false;
      supervisor.setForeground(true);
      supervisor
        .call('engine.lifecycle', ['active'])
        .catch((error: unknown) => appendLog('warn', 'host', `Foreground: ${errorMessage(error)}`));
    }
  });

  let online: boolean | null = null;
  const netInfo = NetInfo.addEventListener((state) => {
    // Unknown reachability (null) counts as online; only a definite "no" is offline.
    const next = state.isConnected !== false && state.isInternetReachable !== false;
    if (next === online) return;
    const first = online === null;
    online = next;
    if (first && next) return; // the engine starts out online
    supervisor
      .connectivity(next)
      .catch((error: unknown) => appendLog('warn', 'host', `Connectivity: ${errorMessage(error)}`));
  });

  return () => {
    appState.remove();
    netInfo();
  };
}
