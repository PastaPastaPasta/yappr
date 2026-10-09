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

interface Onboarding {
  /** This install has been past the Welcome screen (PRD AUTH-01): either choice counts. */
  welcomed: boolean;
  /**
   * The last account signed out since: Welcome at the next launch, whatever
   * the launch's provisional "who was signed in" still says (D-L1i-006).
   */
  welcomeDue: boolean;
}

/** Whether to show Welcome (PRD AUTH-01): once, and again only after the last account signs out. */
export const useOnboarding = create<Onboarding>()(
  persist((): Onboarding => ({ welcomed: false, welcomeDue: false }), {
    name: 'onboarding',
    version: 1,
    storage: createJSONStorage(() => syncStorage),
    merge: (persisted, current) => {
      const stored = persisted as Partial<Record<keyof Onboarding, unknown>> | undefined;
      return { ...current, welcomed: stored?.welcomed === true, welcomeDue: stored?.welcomeDue === true };
    },
  }),
);

/**
 * `true`: past Welcome (a choice on it, or a sign-in). `false`: the last
 * account signed out, so Welcome comes back at the next launch.
 */
export const setWelcomed = (welcomed: boolean) => useOnboarding.setState({ welcomed, welcomeDue: !welcomed });

export const links = {
  /** This network's copies (devnet: under `/devnet`), so the notice on them names the network the app is on (D-013). */
  terms: `https://yap.pr${config.webBasePath}/terms`,
  privacy: `https://yap.pr${config.webBasePath}/privacy`,
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
