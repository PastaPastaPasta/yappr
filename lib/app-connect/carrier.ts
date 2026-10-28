import type { AppConnectCarrier } from 'platform-auth'

/**
 * One App Connect request in one carrier's URI form. A build that offers both
 * carriers (`NEXT_PUBLIC_APP_CONNECT_CARRIER=both`, testnet and devnet only)
 * renders the same request, the same ephemeral key and body, as two of these.
 */
export interface AppConnectCarrierUri {
  carrier: AppConnectCarrier
  uri: string
}

/** A request's URIs, the default carrier's first. */
export type AppConnectCarrierUris = readonly [AppConnectCarrierUri, ...AppConnectCarrierUri[]]

/** What the carrier switch says about each carrier. */
export const APP_CONNECT_CARRIER_LABELS: Record<AppConnectCarrier, { name: string; audience: string }> = {
  'dash-key': { name: 'dash-key:', audience: 'current wallets' },
  dashpay: { name: 'dashpay://connect', audience: 'new wallets' },
}

/**
 * The URI to show: the one of the `wanted` carrier when the request has it,
 * else the first, which is the build's default (`dash-key:` where both are
 * offered, as that is what the wallets in circulation accept). Only the
 * rendering changes with the choice, never the request.
 */
export function selectCarrierUri(uris: AppConnectCarrierUris, wanted: AppConnectCarrier | null): AppConnectCarrierUri {
  return uris.find((entry) => entry.carrier === wanted) ?? uris[0]
}
