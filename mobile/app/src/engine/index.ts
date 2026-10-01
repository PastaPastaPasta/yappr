import type { EngineApi } from '@engine/api';
import type { Remote } from '@engine/rpc/client';
import { Platform } from 'react-native';

import { config } from '~/config';
import { clearAccountCache } from '~/state/query-client';

import { appendLog, errorMessage } from './logs';
import { loadEnginePage, type EngineLoad, type Simulation } from './page';
import { createRemote } from './remote';
import { createEngineStorage } from './storage/engine-storage';
import { EngineSupervisor } from './supervisor';

/**
 * The app's one engine (ADR-001 E1, ENGINE.md §1). Screens call it through
 * `engine.api.<module>.<method>()` (typed by the engine's `EngineApi`), most
 * often via the TanStack Query helpers in ./hooks. The hidden WebView that
 * runs it is mounted by `<EngineHost>` in the root layout.
 */

/** Storage namespace: `testnet`, `mainnet` or `devnet-<name>` (ENGINE.md §9.1). */
export const engineNetworkKey = config.engine?.networkKey ?? config.network;

export const engineStorage = createEngineStorage(engineNetworkKey);

/** The bridge carries the snapshot at every boot; past this it is worth a warning (ENGINE.md §9.1). */
const SNAPSHOT_WARN_CHARS = 8_000_000;

let nextSimulation: Simulation | null = null;

export const engineSupervisor = new EngineSupervisor<EngineLoad>({
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  async prepare() {
    await engineStorage.open();
    const snapshot = await engineStorage.snapshot();
    const { snapshotChars } = engineStorage.stats();
    if (snapshotChars > SNAPSHOT_WARN_CHARS) appendLog('warn', 'host', `Storage snapshot is ${snapshotChars} characters`);
    const simulate = nextSimulation;
    nextSimulation = null;
    return loadEnginePage(snapshot, simulate);
  },
  onStorage(batch) {
    const { epoch } = engineSupervisor.getStatus();
    const written = engineStorage.apply(batch);
    // A secret that did not land leaves the engine waiting for its ack (and a sign-in hanging):
    // say so, and treat it as a crash of that engine (backoff, then failed). Key names only.
    written?.catch((error: unknown) => {
      const keys = batch.ops.map((op) => op[1] ?? 'clear').join(', ');
      appendLog('error', 'host', `Secure write ${batch.seq} failed (${keys}): ${errorMessage(error)}`);
      engineSupervisor.crashed('a secure write failed', epoch);
    });
    return written;
  },
  log: appendLog,
}, { engineLogLevel: __DEV__ ? 'info' : 'warn' });

export interface Engine {
  api: Remote<EngineApi>;
  /** Subscribe to an engine event (ENGINE.md §8); the subscription survives restarts. */
  on(event: string, handler: (payload: unknown) => void): () => void;
}

export const engine: Engine = {
  api: createRemote<EngineApi>((path, args) => engineSupervisor.call(path, args)),
  on: (event, handler) => engineSupervisor.on(event, handler),
};

/** Diagnostics (dev): restart into a simulated Lockdown Mode or outdated WebView. */
export function simulateOnNextBoot(simulation: Simulation): void {
  nextSimulation = simulation;
  engineSupervisor.restart(`Simulating ${simulation}`);
}

/** Diagnostics: delete this network's engine data (storage and secrets), then boot a fresh engine. */
export async function resetEngineData(): Promise<void> {
  engineSupervisor.stop();
  try {
    await engineStorage.reset();
    // The persisted screens' cache belongs to the data just deleted.
    await clearAccountCache();
  } finally {
    engineSupervisor.start();
  }
}
