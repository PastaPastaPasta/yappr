import type { AccountDTO, SessionDTO } from '@engine/api';
import { router } from 'expo-router';
import { create } from 'zustand';

import { onEngineEvent } from '~/data/events';
import { accountCacheSettled, useSessionStore } from '~/data/session';
import { clearSessionExpired, useSessionExpired } from '~/data/session-expiry';
import { engine, engineNetworkKey, engineStorage, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { refetchFailedReads } from '~/state/query-client';
import { syncStorage } from '~/state/storage';
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
  /** `reload`: the restart after signing an account in again (`loadSignedInAgain`). */
  kind: 'switch' | 'add' | 'sign-out' | 'reload';
  label: string;
}

interface AccountsState {
  /** A switch, add or sign-out in progress, shown full screen over the app. */
  transition: AccountTransition | null;
  /** While adding an account: the account to return to if the sign-in is abandoned. */
  returnTo: string | null;
  /** While signing an account in again (AUTH-14): that account. Its sign-in logs in afresh, never switches. */
  reauth: string | null;
}

export const useAccounts = create<AccountsState>()(() => ({ transition: null, returnTo: null, reauth: null }));

/**
 * `returnTo` and `reauth` of an "Add account" (or "Sign in again") in
 * progress, kept on the device as well: the engine parks the active account
 * before the sign-in flow opens, so an app killed during that flow (by the
 * user, or by iOS while the wallet is open) comes back with nobody signed in
 * and the parked accounts out of reach (NEW-R-vi-001). The next launch reads
 * it back (`recoverInterruptedAdd`). Identity ids only, no secrets.
 */
const ADDING_KEY = `yappr.accounts.adding.${engineNetworkKey}`;

interface Adding {
  returnTo: string;
  reauth: string | null;
  /** Launches that have tried to switch back to `returnTo` (`recoverInterruptedAdd`). */
  attempts?: number;
}

/**
 * Launches that try to switch back before giving up: an account whose
 * session never restores would otherwise put the switch overlay and its
 * failure toast on every launch.
 */
const MAX_RECOVERY_ATTEMPTS = 3;

function rememberAdding(adding: Adding | null): void {
  if (adding) syncStorage.setItem(ADDING_KEY, JSON.stringify(adding));
  else syncStorage.removeItem(ADDING_KEY);
}

function interruptedAdd(): Adding | null {
  try {
    const stored = JSON.parse(syncStorage.getItem(ADDING_KEY) ?? 'null') as Partial<Adding> | null;
    if (typeof stored?.returnTo !== 'string' || !stored.returnTo) return null;
    return {
      returnTo: stored.returnTo,
      reauth: typeof stored.reauth === 'string' ? stored.reauth : null,
      attempts: typeof stored.attempts === 'number' ? stored.attempts : 0,
    };
  } catch {
    return null;
  }
}

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
  // The screens behind re-read for the new account as the session settled; one that failed (a read the
  // restart cut short, a DAPI hiccup) would otherwise wait for its "Try again" (AUTH-10: all screens reload).
  accountCacheSettled()
    .then(() => refetchFailedReads('Account change settled'))
    .catch((error: unknown) => appendLog('warn', 'host', `Reading again after the account change failed: ${errorMessage(error)}`));
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
export async function switchAccount(
  account: { identityId: string; username: string | null },
  { quiet = false }: { quiet?: boolean } = {},
): Promise<boolean> {
  if (useSessionStore.getState().session?.identityId === account.identityId) return true;
  return (await runSwitch(account, () => engine.api.session.switchAccount(account.identityId), { quiet })) !== null;
}

/**
 * A wallet sign-in during "Add account" answered for an account already on
 * this device: the engine has prepared the switch to it (`status: 'switch'`),
 * so restart into it. Resolves with its session, or null (with a toast).
 */
export function finishWalletSwitch(identityId: string): Promise<SessionDTO | null> {
  const account = useSessionStore.getState().accounts.find((a) => a.identityId === identityId);
  return runSwitch(account ?? { identityId, username: null }, async () => undefined);
}

/**
 * `prepare` has the engine park the current account; then restart into
 * `account`, behind the switch progress. `quiet`: no toast on failure (the
 * caller says what happens next).
 */
function runSwitch(
  account: { identityId: string; username: string | null },
  prepare: () => Promise<void>,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<SessionDTO | null> {
  const name = accountName(account);
  return withTransition({ kind: 'switch', label: copy.accounts.switching(name) }, async () => {
    try {
      await prepare();
      const restored = await restartEngine('Switching accounts');
      if (restored?.identityId !== account.identityId) throw new Error('The account did not restore');
      toast.success(copy.accounts.switched(name));
      return restored;
    } catch (error) {
      appendLog('warn', 'host', `Switching accounts failed: ${errorMessage(error)}`);
      if (!quiet) toast.error(copy.accounts.switchFailed);
      return null;
    }
  });
}

/**
 * After a sign-in that logged in afresh an account marked "Sign in again"
 * (AUTH-14; the caller reads the mark before signing in, since the sign-in
 * clears it): that account was parked, so the engine that signed it in was
 * booted without its other stored secrets (its encryption and transfer
 * keys). Restart into it, as a switch does, so they load. Resolves with the
 * restored session, or with `session` if the restart failed: the sign-in
 * itself is durable, and the next boot loads the secrets.
 */
export function loadSignedInAgain(session: SessionDTO): Promise<SessionDTO> {
  return withTransition({ kind: 'reload', label: copy.accounts.loadingAgain(accountName(session)) }, async () => {
    try {
      const restored = await restartEngine('Signed in again');
      if (restored?.identityId !== session.identityId) throw new Error('The account did not restore');
      return restored;
    } catch (error) {
      appendLog('warn', 'host', `Reloading the account after signing in again failed: ${errorMessage(error)}`);
      return session;
    }
  });
}

/**
 * Park the current account, restart the engine signed out, then open the
 * sign-in flow; abandoning it switches back (`returnFromAddAccount`).
 * Signed out, this is just the sign-in flow.
 */
async function signInBesideCurrent({
  label,
  failed,
  reauth,
  returnTo = null,
}: {
  label: string;
  failed: string;
  reauth: string | null;
  /** Signed out: the account to return to if the sign-in is abandoned (a switch away from it just failed). */
  returnTo?: string | null;
}): Promise<void> {
  const from = useSessionStore.getState().session?.identityId ?? null;
  if (!from) {
    useAccounts.setState({ reauth, returnTo });
    rememberAdding(returnTo ? { returnTo, reauth } : null);
    router.push('/sign-in');
    return;
  }
  await withTransition({ kind: 'add', label }, async () => {
    let parked = false;
    try {
      // Before the engine parks `from`: from here on, a launch that finds nobody signed in goes back to it.
      rememberAdding({ returnTo: from, reauth });
      await engine.api.session.prepareAddAccount();
      parked = true;
      if (await restartEngine(reauth ? 'Signing in again' : 'Adding an account')) {
        throw new Error('The engine restored an account');
      }
      useAccounts.setState({ returnTo: from, reauth });
      router.push('/sign-in');
    } catch (error) {
      // Nothing was parked. Once something was, the next launch settles it (`recoverInterruptedAdd`).
      if (!parked) rememberAdding(null);
      appendLog('warn', 'host', `Preparing to sign in failed: ${errorMessage(error)}`);
      toast.error(failed);
    }
  });
}

/** Add another account (AUTH-10). */
export function addAccount(): Promise<void> {
  return signInBesideCurrent({ label: copy.accounts.adding, failed: copy.accounts.addFailed, reauth: null });
}

/**
 * Sign an account in again (AUTH-14: its stored key no longer signs), by
 * wallet or key: the sign-in flow with that account parked, whose sign-in
 * stores the new key instead of switching back to the old one. Abandoning
 * it returns to the account that was active, still marked "Sign in again".
 */
export function reauthenticate(identityId: string, { returnTo }: { returnTo?: string | null } = {}): Promise<void> {
  return signInBesideCurrent({
    label: copy.accounts.reauthing,
    failed: copy.accounts.reauthFailed,
    reauth: identityId,
    returnTo,
  });
}

/**
 * The account the sign-in flow is signing in again (its sign-in screen says
 * so), while it still needs it (marked "Sign in again"): a leftover target
 * never shows. Which sign-ins log in afresh rather than switch back follows
 * the marks alone, so a plain "Add account" for a marked account does too.
 */
export function useReauthTarget(): string | null {
  const reauth = useAccounts((s) => s.reauth);
  return useSessionExpired(reauth) ? reauth : null;
}

/**
 * A sign-in or switch ends any "sign in again" flow (mounted by `AuthGates`):
 * whatever happens next is not that flow.
 */
export function startReauthTracking(): () => void {
  return onEngineEvent('session.changed', ({ reason }) => {
    if (reason !== 'signed-in' && reason !== 'switched') return;
    useAccounts.setState({ reauth: null });
    // An account is in the session slot again: no launch needs to go back to the parked one.
    rememberAdding(null);
  });
}

/**
 * The sign-in flow closed. After an abandoned "Add account", go back to the
 * account that was parked; after a completed one, forget it. A switch back
 * that fails leaves it for the next launch (`recoverInterruptedAdd`).
 */
export function returnFromAddAccount(): void {
  const { returnTo } = useAccounts.getState();
  useAccounts.setState({ returnTo: null, reauth: null });
  const { status, accounts } = useSessionStore.getState();
  if (!returnTo || status !== 'signed-out') {
    rememberAdding(null);
    return;
  }
  const account = accounts.find((a) => a.identityId === returnTo) ?? { identityId: returnTo, username: null };
  switchAccount(account)
    .then((switched) => {
      if (switched) rememberAdding(null);
    })
    .catch(() => undefined);
}

/**
 * At launch, once the engine has restored the session: an "Add account" or
 * "Sign in again" the last launch was killed in the middle of
 * (NEW-R-vi-001). Signed in, there is nothing to go back to. Signed out:
 * with `resume` (the engine still holds that flow's wallet request, and the
 * sign-in flow reopens on it) the flow carries on, so abandoning it goes
 * back as it would have; otherwise switch back to the parked account now.
 * A switch that fails is tried again at the next launch, up to
 * MAX_RECOVERY_ATTEMPTS launches; the account then stays in the switcher.
 */
export async function recoverInterruptedAdd({ resume }: { resume: boolean }): Promise<void> {
  const adding = interruptedAdd();
  if (!adding) return;
  const { status } = useSessionStore.getState();
  if (status === 'signed-in') {
    rememberAdding(null);
    return;
  }
  if (status !== 'signed-out') return;
  if (resume) {
    if (!useAccounts.getState().returnTo) useAccounts.setState({ returnTo: adding.returnTo, reauth: adding.reauth });
    return;
  }
  // Only a flow of this launch (none should run yet) owns what is in memory.
  if (useAccounts.getState().returnTo || useAccounts.getState().transition) return;
  const account = (await refreshAccounts()).find((a) => a.identityId === adding.returnTo);
  if (!account) {
    rememberAdding(null);
    return;
  }
  const attempts = adding.attempts ?? 0;
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    appendLog('warn', 'host', `Gave up going back to the parked account after ${attempts} launches`);
    rememberAdding(null);
    return;
  }
  // Counted before the switch, so a launch that dies during it counts too.
  rememberAdding({ ...adding, attempts: attempts + 1 });
  appendLog('info', 'host', 'Going back to the account parked by an interrupted sign-in');
  if (await switchAccount(account)) rememberAdding(null);
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
    clearSessionExpired(identityId);
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
    } else if (active) {
      // This engine booted with the account's keys in its page (and RN holds that page's source):
      // only a fresh engine drops them (ENGINE.md §11.1). A switch above restarts anyway. Like a switch,
      // the restart then reads again, once, what the screens behind failed to read for the signed-out
      // reader (a read cut short by the restart and replayed on the booting engine; one suspect for
      // D-L2i-004, which device QA could not reproduce).
      restartEngine('Signed out').catch((error: unknown) =>
        appendLog('warn', 'host', `Restarting after sign-out failed: ${errorMessage(error)}`),
      );
    }
    return true;
  });
}
