import type { AppConnectStatusDTO } from '@engine/api';
import { create } from 'zustand';

import { onEngineEvent } from '~/data/events';
import { engine, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';

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
  signedOutByWallet: false,
}));

/** Follows the engine's reports, and reads them afresh on every engine boot. Started once by `AuthGates`. */
export function startAppConnectStatusSync(): () => void {
  let epoch = -1;
  const read = () => {
    engine.api.session
      .appConnectStatus()
      .then((status) => useAppConnectStatus.setState(status))
      .catch((error: unknown) => appendLog('warn', 'host', `Reading the wallet session failed: ${errorMessage(error)}`));
  };
  const stopEvents = onEngineEvent('session.appConnectStatus', (status) => useAppConnectStatus.setState(status));
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
