import * as WebBrowser from 'expo-web-browser';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { config } from '~/config';
import { engineNetworkKey } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { syncStorage } from '~/state/storage';

/**
 * App Connect (PRD AUTH-13) stays off in every 1.0 build: with the flag off
 * no App Connect UI appears anywhere.
 */
export const FEATURE_APP_CONNECT = false;

/**
 * Whether this install has been past the Welcome screen (PRD AUTH-01): either
 * choice counts, and only signing the last account out shows it again.
 */
export const useOnboarding = create<{ welcomed: boolean }>()(
  persist((): { welcomed: boolean } => ({ welcomed: false }), {
    name: 'onboarding',
    version: 1,
    storage: createJSONStorage(() => syncStorage),
    merge: (persisted, current) => ({
      ...current,
      welcomed: (persisted as { welcomed?: unknown } | undefined)?.welcomed === true,
    }),
  }),
);

export const setWelcomed = (welcomed: boolean) => useOnboarding.setState({ welcomed });

export const links = {
  /** The terms and privacy policy cover every network, so they come from the root site. */
  terms: 'https://yap.pr/terms',
  privacy: 'https://yap.pr/privacy',
  /** The identity bridge, for the network this build talks to (web `identityBridgeUrl`). */
  identityBridge: `https://bridge.thepasta.org/?network=${encodeURIComponent(engineNetworkKey)}`,
  /** Web's DASH_WALLET_DOWNLOAD_URL. */
  getWallet: 'https://www.dash.org/download/',
};

/** Opens a page in the in-app browser. */
export function openInApp(url: string): void {
  WebBrowser.openBrowserAsync(url).catch((error: unknown) => {
    appendLog('warn', 'host', `Opening ${url} failed: ${errorMessage(error)}`);
  });
}

/** "Devnet" / "Testnet" / "Mainnet", for messages that name the network. */
export const networkName = config.network.charAt(0).toUpperCase() + config.network.slice(1);
