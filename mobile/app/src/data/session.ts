import type { AccountDTO, CapabilitiesDTO, SessionDTO } from '@engine/api';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { engine, engineSupervisor } from '~/engine';
import { ENGINE_BUNDLE_HASH } from '~/engine/bundle-hash';
import { appendLog, errorMessage } from '~/engine/logs';
import { clearAccountCache, queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';

import { onEngineEvent } from './events';
import { queryKeys } from './keys';

/**
 * The signed-in account, driven by the engine (`session.current()` once per
 * engine boot, then `session.changed`). `unknown` until the engine has
 * restored the saved session.
 */
export type SessionStatus = 'unknown' | 'signed-out' | 'signed-in';

interface SessionState {
  status: SessionStatus;
  session: SessionDTO | null;
  /** Accounts signed in on this device, the active one included (`session.accounts`). */
  accounts: AccountDTO[];
}

export const useSessionStore = create<SessionState>()(() => ({
  status: 'unknown',
  session: null,
  accounts: [],
}));

export interface UseSession extends SessionState {
  identityId: string | null;
  signedIn: boolean;
}

/** The session, re-rendering when it changes. */
export function useSession(): UseSession {
  const state = useSessionStore();
  return { ...state, identityId: state.session?.identityId ?? null, signedIn: state.status === 'signed-in' };
}

/** The signed-in identity id, or null; re-renders only when it changes. */
export function useViewerId(): string | null {
  return useSessionStore((s) => s.session?.identityId ?? null);
}

const CAPABILITIES_KEY = 'yappr.capabilities';

/** The last engine's capabilities, valid while the app ships the same engine bundle. */
function storedCapabilities(): CapabilitiesDTO | null {
  try {
    const stored = JSON.parse(syncStorage.getItem(CAPABILITIES_KEY) ?? 'null') as {
      bundle?: string;
      capabilities?: CapabilitiesDTO;
    } | null;
    return stored?.bundle === ENGINE_BUNDLE_HASH ? (stored.capabilities ?? null) : null;
  } catch {
    return null;
  }
}

let lastCapabilities: CapabilitiesDTO | null = storedCapabilities();

const getCapabilities = () => engineSupervisor.getStatus().info?.capabilities ?? lastCapabilities;

/**
 * What the active contract can serve (`engine.info().capabilities`): ranking
 * sorts, repost and bookmark rules per kind, content limits. Before the
 * engine boots, the last boot's answer for this engine bundle; null on a
 * first launch.
 */
export function useCapabilities(): CapabilitiesDTO | null {
  return useSyncExternalStore(engineSupervisor.subscribeStatus, getCapabilities);
}

/** The cache another account (or nobody) left would show the wrong viewer state. */
const LAST_IDENTITY_KEY = 'yappr.session.identity';

function accountChanged(previous: string | null, next: string | null): void {
  if (previous === next) return;
  if (next) syncStorage.setItem(LAST_IDENTITY_KEY, next);
  else syncStorage.removeItem(LAST_IDENTITY_KEY);
  // Signing in adds viewer marks: refetch. Signing out or switching: drop the old account's data.
  const done = previous
    ? clearAccountCache()
    : queryClient.invalidateQueries({ queryKey: queryKeys.all });
  done.catch((error: unknown) => appendLog('warn', 'host', `Cache reset failed: ${errorMessage(error)}`));
}

function applySession(session: SessionDTO | null): void {
  const previous = useSessionStore.getState();
  const previousId =
    previous.status === 'unknown'
      ? syncStorage.getItem(LAST_IDENTITY_KEY)
      : (previous.session?.identityId ?? null);
  useSessionStore.setState({ status: session ? 'signed-in' : 'signed-out', session });
  accountChanged(previousId, session?.identityId ?? null);
  engine.api.session
    .accounts()
    .then((accounts) => useSessionStore.setState({ accounts }))
    .catch((error: unknown) => appendLog('warn', 'host', `Reading accounts failed: ${errorMessage(error)}`));
}

const RETRY_MS = 5000;

/**
 * Keeps the session store in step with the engine: `session.changed`, plus
 * `session.current()` on every engine boot (which also runs the engine's
 * restore). Started once by `startDataLayer`.
 */
export function startSessionSync(): () => void {
  let epoch = -1;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const refresh = (forEpoch: number) => {
    clearTimeout(retry);
    engine.api.session
      .current()
      .then((session) => {
        if (forEpoch === engineSupervisor.getStatus().epoch) applySession(session);
      })
      .catch((error: unknown) => {
        appendLog('warn', 'host', `Restoring the session failed: ${errorMessage(error)}`);
        // Offline boots can't restore yet; try again while this engine runs.
        retry = setTimeout(() => {
          if (forEpoch === engineSupervisor.getStatus().epoch) refresh(forEpoch);
        }, RETRY_MS);
      });
  };

  const onStatus = () => {
    const status = engineSupervisor.getStatus();
    const capabilities = status.info?.capabilities;
    if (capabilities && capabilities !== lastCapabilities) {
      lastCapabilities = capabilities;
      syncStorage.setItem(CAPABILITIES_KEY, JSON.stringify({ bundle: ENGINE_BUNDLE_HASH, capabilities }));
    }
    if ((status.state === 'ready' || status.state === 'degraded') && status.epoch !== epoch) {
      epoch = status.epoch;
      refresh(epoch);
    }
  };

  const stopEvents = onEngineEvent('session.changed', ({ session }) => applySession(session));
  const stopStatus = engineSupervisor.subscribeStatus(onStatus);
  onStatus();
  return () => {
    clearTimeout(retry);
    stopEvents();
    stopStatus();
  };
}
