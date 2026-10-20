import { router } from 'expo-router';

import { useSessionStore } from '~/data/session';
import { appendLog, errorMessage } from '~/engine/logs';
import { addAccount, useAccounts } from '~/features/auth/accounts';
import { confirmSignOut } from '~/features/auth/AccountSwitcher';

/** How long the next account may take to take over after a sign-out (its switch restarts the engine). */
const TAKEOVER_MS = 60_000;

/**
 * Resolves once `identityId` is the active account and no account change is
 * running: a sign-out only queues the next account's switch, which then
 * restarts the engine.
 */
export function accountTakenOver(identityId: string, timeoutMs = TAKEOVER_MS): Promise<void> {
  const ready = () =>
    useSessionStore.getState().session?.identityId === identityId && useAccounts.getState().transition === null;
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stops: (() => void)[] = [];
    const finish = () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('The next account did not take over'));
    }, timeoutMs);
    const check = () => {
      if (!ready()) return;
      finish();
      resolve();
    };
    stops.push(useSessionStore.subscribe(check), useAccounts.subscribe(check));
  });
}

/**
 * Messages come from a wallet sign-in (D38), and the engine never signs the
 * active account in again: sign it out (asked), then open the wallet sign-in,
 * beside the account that takes over once it has.
 */
export function signOutForWallet(): void {
  const { session, accounts } = useSessionStore.getState();
  if (!session) return;
  const next = accounts.find((account) => account.identityId !== session.identityId);
  confirmSignOut(session)
    .then(async () => {
      // Still on the device: the sign-out was cancelled or failed.
      if (useSessionStore.getState().accounts.some((account) => account.identityId === session.identityId)) return;
      if (!next) {
        router.push('/sign-in');
        return;
      }
      await accountTakenOver(next.identityId);
      await addAccount();
    })
    .catch((error: unknown) => appendLog('warn', 'host', `Sign-out for wallet messaging failed: ${errorMessage(error)}`));
}
