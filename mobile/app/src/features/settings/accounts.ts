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

/** Shows `transition` while `run` runs; `run` can hand over to a next step's transition without a gap. */
async function withTransition<T>(
  transition: AccountTransition,
  run: (handOver: (next: AccountTransition) => void) => Promise<T>,
): Promise<T> {
  let current = transition;
  useAccountTransition.setState({ transition });
  try {
    return await run((next) => {
      current = next;
      useAccountTransition.setState({ transition: next });
    });
  } finally {
    if (useAccountTransition.getState().transition === current) useAccountTransition.setState({ transition: null });
  }
}

/** Parks the current account, restarts the engine as `account`, and says how it went. */
async function runSwitch(account: { identityId: string; username: string | null }): Promise<boolean> {
  const name = accountName(account);
  try {
    await engine.api.session.switchAccount(account.identityId);
    const restored = await restartEngine('Switching accounts');
    if (restored?.identityId !== account.identityId) throw new Error('The account did not restore');
    toast.success(copy.account.switched(name));
    return true;
  } catch (error) {
    appendLog('warn', 'host', `Switching accounts failed: ${errorMessage(error)}`);
    toast.error(copy.account.switchFailed);
    return false;
  }
}

const switching = (account: { identityId: string; username: string | null }): AccountTransition => ({
  kind: 'switch',
  label: copy.account.switching(accountName(account)),
});

/**
 * Switch to another account signed in on this device (or, signed out, to a
 * parked one). Resolves true once the engine runs as it.
 */
export async function switchAccount(account: { identityId: string; username: string | null }): Promise<boolean> {
  if (useSessionStore.getState().session?.identityId === account.identityId) return true;
  return withTransition(switching(account), () => runSwitch(account));
}

/**
 * Add another account: park the current one, restart signed out, then open
 * sign-in. The parked account stays listed on Settings → Account, signed out
 * too, so backing out of sign-in can switch back to it.
 */
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

/** Signed out with nobody left: Home, signed out (AUTH-11). */
function goHome(): void {
  if (router.canDismiss()) router.dismissAll();
  router.navigate('/');
}

/**
 * Sign an account out and delete its keys from this device, offline
 * (AUTH-11). Signing out the active account moves to the most recently used
 * other account, if there is one; otherwise to Home, signed out.
 */
export async function signOutAccount(identityId: string): Promise<boolean> {
  const active = useSessionStore.getState().session?.identityId === identityId;
  return withTransition({ kind: 'sign-out', label: copy.account.signingOut }, async (handOver) => {
    try {
      await engine.api.session.signOut({ identityId });
    } catch (error) {
      appendLog('warn', 'host', `Sign-out failed: ${errorMessage(error)}`);
      toast.error(copy.account.signOutFailed);
      return false;
    }
    // Signing out another account changes no session, so nothing else refreshes the list.
    const accounts = await engine.api.session.accounts().catch(() => useSessionStore.getState().accounts);
    const remaining = accounts.filter((a) => a.identityId !== identityId);
    useSessionStore.setState({ accounts: remaining });
    toast(copy.account.signedOutDone);
    if (!active) return true;
    // The engine lists the most recently used account first.
    const next = remaining[0];
    if (!next) {
      goHome();
      return true;
    }
    // The cover stays up from the sign-out through the switch's restart.
    handOver(switching(next));
    await runSwitch(next);
    return true;
  });
}
