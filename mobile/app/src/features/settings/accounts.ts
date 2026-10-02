import type { SessionDTO } from '@engine/api';
import { router } from 'expo-router';
import { create } from 'zustand';

import { useSessionStore } from '~/data/session';
import { engine, engineStorage, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { handleOf } from '~/ui/handle';
import { toast } from '~/ui/toast';

import { copy } from './copy';

/**
 * Accounts on this device, from Settings → Account (PRD AUTH-10, AUTH-11).
 * lib has one session slot, so a switch or an add is a controlled engine
 * restart: the engine parks the current account (`session.switchAccount` /
 * `prepareAddAccount`), then the host restarts it, and the next boot
 * restores the target. Signing out works offline, for any account.
 *
 * The same contract as the sign-in PR's account switcher
 * (`features/auth/accounts.ts`, #636): once both are in, Settings uses that one.
 */

export interface AccountTransition {
  kind: 'switch' | 'add' | 'sign-out';
  label: string;
}

/** A switch, add or sign-out in progress: the Account screen covers itself while it runs. */
export const useAccountTransition = create<{ transition: AccountTransition | null }>()(() => ({ transition: null }));

/** The engine can take a while to boot (wasm, SDK, contracts). */
const RESTART_TIMEOUT_MS = 90_000;

/** "@alice" (DPNS's `.dash` dropped), or the truncated identity id. */
export const accountName = (account: { identityId: string; username: string | null }) =>
  handleOf({ id: account.identityId, username: account.username?.replace(/\.dash$/i, '') || null });

/** Resolves once `ready()` holds, re-checked on every `subscribe` notification; rejects after `ms`. */
function when(subscribe: (listener: () => void) => () => void, ready: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error('The engine did not come back in time'));
    }, ms);
    const check = () => {
      if (!ready()) return;
      clearTimeout(timer);
      stop();
      resolve();
    };
    stop = subscribe(check);
    check();
  });
}

/**
 * Restarts the engine once every secure write has landed (so the next boot
 * reads the parked account), and resolves with the session the new boot
 * restored, after the session store agrees with it.
 */
async function restartEngine(reason: string): Promise<SessionDTO | null> {
  await engineStorage.idle();
  const from = engineSupervisor.getStatus().epoch;
  engineSupervisor.restart(reason);
  await when(
    engineSupervisor.subscribeStatus,
    () => {
      const { state, epoch } = engineSupervisor.getStatus();
      return epoch > from && (state === 'ready' || state === 'degraded');
    },
    RESTART_TIMEOUT_MS,
  );
  const session = await engine.api.session.current();
  const identityId = session?.identityId ?? null;
  await when(
    useSessionStore.subscribe,
    () => {
      const s = useSessionStore.getState();
      return s.status !== 'unknown' && (s.session?.identityId ?? null) === identityId;
    },
    RESTART_TIMEOUT_MS,
  );
  return session;
}

async function withTransition<T>(transition: AccountTransition, run: () => Promise<T>): Promise<T> {
  useAccountTransition.setState({ transition });
  try {
    return await run();
  } finally {
    if (useAccountTransition.getState().transition === transition) useAccountTransition.setState({ transition: null });
  }
}

/** Switch to another account signed in on this device. Resolves true once the engine runs as it. */
export async function switchAccount(account: { identityId: string; username: string | null }): Promise<boolean> {
  const { identityId } = account;
  if (useSessionStore.getState().session?.identityId === identityId) return true;
  const name = accountName(account);
  return withTransition({ kind: 'switch', label: copy.account.switching(name) }, async () => {
    try {
      await engine.api.session.switchAccount(identityId);
      const restored = await restartEngine('Switching accounts');
      if (restored?.identityId !== identityId) throw new Error('The account did not restore');
      toast.success(copy.account.switched(name));
      return true;
    } catch (error) {
      appendLog('warn', 'host', `Switching accounts failed: ${errorMessage(error)}`);
      toast.error(copy.account.switchFailed);
      return false;
    }
  });
}

/** Add another account: park the current one, restart signed out, then open sign-in. */
export async function addAccount(): Promise<void> {
  if (!useSessionStore.getState().session) {
    router.push('/sign-in');
    return;
  }
  await withTransition({ kind: 'add', label: copy.account.adding }, async () => {
    try {
      await engine.api.session.prepareAddAccount();
      if (await restartEngine('Adding an account')) throw new Error('The engine restored an account');
      router.push('/sign-in');
    } catch (error) {
      appendLog('warn', 'host', `Preparing to add an account failed: ${errorMessage(error)}`);
      toast.error(copy.account.addFailed);
    }
  });
}

/**
 * Sign an account out and delete its keys from this device, offline
 * (AUTH-11). Signing out the active account moves to the most recently used
 * other account, if there is one; otherwise the app is signed out.
 */
export async function signOutAccount(identityId: string): Promise<boolean> {
  const active = useSessionStore.getState().session?.identityId === identityId;
  const signedOut = await withTransition({ kind: 'sign-out', label: copy.account.signingOut }, async () => {
    try {
      await engine.api.session.signOut({ identityId });
    } catch (error) {
      appendLog('warn', 'host', `Sign-out failed: ${errorMessage(error)}`);
      toast.error(copy.account.signOutFailed);
      return false;
    }
    // Signing out another account changes no session, so nothing else refreshes the list.
    const accounts = await engine.api.session.accounts().catch(() => useSessionStore.getState().accounts);
    useSessionStore.setState({ accounts: accounts.filter((a) => a.identityId !== identityId) });
    toast(copy.account.signedOutDone);
    return true;
  });
  const next = active ? useSessionStore.getState().accounts[0] : undefined;
  if (signedOut && next) await switchAccount(next);
  return signedOut;
}
