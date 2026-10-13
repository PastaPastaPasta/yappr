import type { AppConnectStatusDTO } from '@engine/api';
import { create } from 'zustand';

import { onEngineEvent } from '~/data/events';
import { engine, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';

import { afterSignOut } from './accounts';

/**
 * The App Connect session's standing as the engine reports it
 * (`session.appConnectStatus`): the account signed in through a wallet, its
 * allowance and time (`renew-soon`, `renew-required`), a write stopped until
 * the user renews, and a revoke that signed the account out.
 */
export const useAppConnectStatus = create<AppConnectStatusDTO>()(() => ({
  identityId: null,
  health: null,
  renewRequired: null,
  signedOutByWallet: null,
}));

/** The account a wallet's revoke signed out, while "Signed out from your wallet" shows. */
export const useRevokedNotice = create<{ account: string | null }>()(() => ({ account: null }));

/**
 * The engine reports a revoke once it has signed the account out: say so,
 * and settle what follows any sign-out here (the next account on this phone,
 * or a fresh engine).
 */
function apply(status: AppConnectStatusDTO): void {
  useAppConnectStatus.setState(status);
  const account = status.signedOutByWallet;
  if (!account) return;
  useRevokedNotice.setState({ account });
  engine.api.session.appConnectDismiss({ signedOut: true }).catch(() => undefined);
  afterSignOut(account, true).catch((error: unknown) =>
    appendLog('warn', 'host', `Settling the sign-out after a revoke failed: ${errorMessage(error)}`),
  );
}

/** Follows the engine's reports, and reads them afresh on every engine boot. Started once by `AuthGates`. */
export function startAppConnectStatusSync(): () => void {
  let epoch = -1;
  const read = () => {
    engine.api.session
      .appConnectStatus()
      .then(apply)
      .catch((error: unknown) => appendLog('warn', 'host', `Reading the wallet session failed: ${errorMessage(error)}`));
  };
  const stopEvents = onEngineEvent('session.appConnectStatus', apply);
  const stopStatus = engineSupervisor.subscribeStatus(() => {
    const status = engineSupervisor.getStatus();
    if ((status.state === 'ready' || status.state === 'degraded') && status.epoch !== epoch) {
      epoch = status.epoch;
      read();
    }
  });
  return () => {
    stopEvents();
    stopStatus();
  };
}
