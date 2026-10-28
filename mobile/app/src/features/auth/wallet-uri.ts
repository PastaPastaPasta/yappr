/**
 * Which App Connect URI opens the wallet on this device. A build offers one
 * carrier (`dashpay://connect` or `dash-key:`), or on testnet and devnet
 * staging both, the same request in each (`NEXT_PUBLIC_APP_CONNECT_CARRIER`).
 * Pure: the probing of installed schemes is in `app-connect.ts`.
 */

export type WalletCarrier = 'dash-key' | 'dashpay';

export interface WalletCarrierUri {
  carrier: WalletCarrier;
  uri: string;
}

/**
 * What `Linking.canOpenURL` is asked, per carrier (iOS answers only for schemes
 * in LSApplicationQueriesSchemes, Android only for <queries>: both list
 * `dashpay` and `dash-key`, plugins/wallet-schemes).
 */
export const WALLET_PROBE_URLS: Record<WalletCarrier, string> = {
  dashpay: 'dashpay://connect',
  'dash-key': 'dash-key:yappr',
};

/**
 * The URI to open with `options` (the build's carriers, default first, which
 * is `dash-key:` where both are offered since that is what the wallets in
 * circulation accept). With one option, that one, whatever `installed` says.
 * With several, the carrier that exactly one installed wallet handles; none or
 * both installed (or the answer unknown) falls back to the default.
 */
export function pickWalletUri(options: readonly WalletCarrierUri[], installed: Partial<Record<WalletCarrier, boolean>>): string | null {
  if (options.length === 0) return null;
  const handled = options.filter((option) => installed[option.carrier] === true);
  return (handled.length === 1 ? handled[0] : options[0]).uri;
}
