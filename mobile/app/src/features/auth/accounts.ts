import type { AccountDTO, SessionDTO } from '@engine/api';
import { router } from 'expo-router';
import { create } from 'zustand';

import { useSessionStore } from '~/data/session';
import { engine, engineStorage, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { handleOf } from '~/ui/handle';
import { toast } from '~/ui/toast';

import { copy } from './copy';
import { setWelcomed } from './onboarding';

/**
 * Accounts on this device (PRD AUTH-10, AUTH-11). lib has one session slot,
 * so a switch or an add is a controlled engine restart: the engine parks the
 * current account (`session.switchAccount` / `prepareAddAccount`), then the
 * host restarts it with the next account's secrets and waits for the new
 * session to come back.
 */

export interface AccountTransition {
  kind: 'switch' | 'add' | 'sign-out';
  label: string;
}

interface AccountsState {
  /** A switch, add or sign-out in progress, shown full screen over the app. */
  transition: AccountTransition | null;
  /** While adding an account: the account to return to if the sign-in is abandoned. */
  returnTo: string | null;
}

export const useAccounts = create<AccountsState>()(() => ({ transition: null, returnTo: null }));

/** The engine can take a while to boot (wasm, SDK, contracts). */
const RESTART_TIMEOUT_MS = 90_000;

/** "@alice", or the truncated identity id. lib's session names keep DPNS's `.dash` suffix; handles drop it. */
export const accountName = (account: { identityId: string; username: string | null }) =>
  handleOf({ id: account.identityId, username: account.username?.replace(/\.dash$/i, '') || null });

/** Resolves once `ready` holds for `subscribe`'s source; rejects after `ms`. */
function when(subscribe: (listener: () => void) => () => void, ready: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!ready()) return;
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error('The engine did not come back in time'));
    }, ms);
    const stop = subscribe(check);
    check();
  });
}

/**
 * Restart the engine once every secure write has landed, so the next boot
 * reads the parked account's state, and resolve with the session that boot
 * restored. Only the new epoch's answer counts: the session store may already
 * say "signed out", and a late write for the old engine must not pass for it.
 */
async function restartEngine(reason: string): Promise<SessionDTO | null> {
  await engineStorage.idle();
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
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
  // The session sync applies the same restore; wait for it so the screens behind agree.
  const identityId = session?.identityId ?? null;
  await when(
    useSessionStore.subscribe,
    () => {
      const s = useSessionStore.getState();
      return s.status !== 'unknown' && (s.session?.identityId ?? null) === identityId;
    },
    Math.max(deadline - Date.now(), 0),
  );
  return session;
}

async function withTransition<T>(transition: AccountTransition, run: () => Promise<T>): Promise<T> {
  useAccounts.setState({ transition });
  try {
    return await run();
  } finally {
    // A switch queued by this one (signing out the active account) may already show its own.
    if (useAccounts.getState().transition === transition) useAccounts.setState({ transition: null });
  }
}

/** Re-reads the engine's account list into the session store (a sign-out of another account changes no session). */
async function refreshAccounts(): Promise<AccountDTO[]> {
  const accounts = await engine.api.session.accounts();
  useSessionStore.setState({ accounts });
  return accounts;
}

/**
 * Switch to another account signed in on this device. Resolves true once the
 * engine has restarted as that account; false (with a toast) if it did not.
 */
export async function switchAccount(account: { identityId: string; username: string | null }): Promise<boolean> {
  const { identityId } = account;
  if (useSessionStore.getState().session?.identityId === identityId) return true;
  const name = accountName(account);
  return withTransition({ kind: 'switch', label: copy.accounts.switching(name) }, async () => {
    try {
      await engine.api.session.switchAccount(identityId);
      const restored = await restartEngine('Switching accounts');
      if (restored?.identityId !== identityId) throw new Error('The account did not restore');
      toast.success(copy.accounts.switched(name));
      return true;
    } catch (error) {
      appendLog('warn', 'host', `Switching accounts failed: ${errorMessage(error)}`);
      toast.error(copy.accounts.switchFailed);
      return false;
    }
  });
}

/**
 * Add another account: park the current one, restart the engine signed out,
 * then open the sign-in flow. Abandoning the sign-in switches back
 * (`returnFromAddAccount`). Signed out, this is just the sign-in flow.
 */
export async function addAccount(): Promise<void> {
  const from = useSessionStore.getState().session?.identityId ?? null;
  if (!from) {
    router.push('/sign-in');
    return;
  }
  await withTransition({ kind: 'add', label: copy.accounts.adding }, async () => {
    try {
      await engine.api.session.prepareAddAccount();
      if (await restartEngine('Adding an account')) throw new Error('The engine restored an account');
      useAccounts.setState({ returnTo: from });
      router.push('/sign-in');
    } catch (error) {
      appendLog('warn', 'host', `Preparing to add an account failed: ${errorMessage(error)}`);
      toast.error(copy.accounts.addFailed);
    }
  });
}

/**
 * The sign-in flow closed. After an abandoned "Add account", go back to the
 * account that was parked; after a completed one, forget it.
 */
export function returnFromAddAccount(): void {
  const { returnTo } = useAccounts.getState();
  if (!returnTo) return;
  useAccounts.setState({ returnTo: null });
  const { status, accounts } = useSessionStore.getState();
  if (status !== 'signed-out') return;
  const account = accounts.find((a) => a.identityId === returnTo) ?? { identityId: returnTo, username: null };
  switchAccount(account).catch(() => undefined);
}

/**
 * Sign an account out and delete its keys from this device (PRD AUTH-11),
 * offline. Signing out the active account moves to the most recently used
 * other account, if there is one; signing out the last one brings Welcome
 * back on the next launch (AUTH-01).
 */
export async function signOutAccount(identityId: string): Promise<boolean> {
  const active = useSessionStore.getState().session?.identityId === identityId;
  return withTransition({ kind: 'sign-out', label: copy.accounts.signingOut }, async () => {
    try {
      await engine.api.session.signOut({ identityId });
    } catch (error) {
      appendLog('warn', 'host', `Sign-out failed: ${errorMessage(error)}`);
      toast.error(copy.signout.failed);
      return false;
    }
    const remaining = await refreshAccounts().catch(() => useSessionStore.getState().accounts);
    const others = remaining.filter((a) => a.identityId !== identityId);
    if (others.length === 0) setWelcomed(false);
    toast(copy.signout.done);
    const next = active ? others[0] : undefined;
    if (next) {
      // Outside this transition: the switch shows its own.
      queueMicrotask(() => {
        switchAccount(next).catch(() => undefined);
      });
    }
    return true;
  });
}
