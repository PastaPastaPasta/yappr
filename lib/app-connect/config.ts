import type { AppConnectCarrier, YapprKeyExchangeNetworkName } from 'platform-auth'
import { parseAppConnectPins as parsePins } from './pins.mjs'
import { DASHPAY_CONTRACT_ID } from '@/lib/constants'

/**
 * Build-time switches and pinned data for App Connect login
 * (docs/APP_CONNECT_PROFILE.md, docs/APP_CONNECT_CONTRACTS.md).
 *
 * `NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect` turns it on for a build; anything
 * else (or nothing) keeps the legacy key exchange for current production
 * defaults. Testnet and sakura support PV14; the release explicitly selects
 * App Connect at cut-over. Every `process.env.NEXT_PUBLIC_*` read below is
 * spelled out literally so Next inlines it into the static export.
 */

export type LoginProtocol = 'app-connect' | 'legacy'

export function parseLoginProtocol(value: string | undefined): LoginProtocol {
  return value?.trim() === 'app-connect' ? 'app-connect' : 'legacy'
}

export function loginProtocol(): LoginProtocol {
  return parseLoginProtocol(process.env.NEXT_PUBLIC_LOGIN_PROTOCOL)
}

export function isAppConnectBuild(): boolean {
  return loginProtocol() === 'app-connect'
}

/**
 * Which URI carries the request in the QR code (DIP dashpay/dips#181):
 * `dashpay://connect` or the transitional `dash-key:`. Current testnet and
 * devnet wallets accept only `dash-key:`, so that stays the default there;
 * `NEXT_PUBLIC_APP_CONNECT_CARRIER=dashpay` switches a build to the DIP's URI.
 * Mainnet is always `dashpay`, whatever the variable says.
 */
export function parseAppConnectCarrier(
  value: string | undefined,
  network: YapprKeyExchangeNetworkName,
): AppConnectCarrier {
  if (network === 'mainnet') return 'dashpay'
  return value?.trim() === 'dashpay' ? 'dashpay' : 'dash-key'
}

export function appConnectCarrier(network: YapprKeyExchangeNetworkName): AppConnectCarrier {
  return parseAppConnectCarrier(process.env.NEXT_PUBLIC_APP_CONNECT_CARRIER, network)
}

/** Platform's App Connect system contract, where wallets publish `loginKeyResponse` documents. */
export const APP_CONNECT_RESPONSE_CONTRACT_ID = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ'
export const APP_CONNECT_RESPONSE_DOCUMENT_TYPE = 'loginKeyResponse'
/** Bound V1 keys and the anchor's encryption opt-in exist from protocol 14. */
export const APP_CONNECT_MIN_PROTOCOL_VERSION = 14
/** The DashPay document type the second binding asks for. */
export const DASHPAY_PROFILE_DOCUMENT_TYPE = 'profile'
export { DASHPAY_CONTRACT_ID }

const DAY_MS = 24 * 60 * 60_000
/** Group key: 0.5 DASH for 90 days (user decision 2026-10-11). */
export const APP_CONNECT_GROUP_BUDGET = 50_000_000_000n
export const APP_CONNECT_GROUP_LIFETIME_MS = 90 * DAY_MS
/** DashPay profile key: 1e9 credits (about 60¢) for 90 days. */
export const APP_CONNECT_PROFILE_BUDGET = 1_000_000_000n
export const APP_CONNECT_PROFILE_LIFETIME_MS = 90 * DAY_MS
/** The renewal banner shows below this share of the budget or this much time left. */
export const APP_CONNECT_RENEW_BUDGET_SHARE = 0.2
export const APP_CONNECT_RENEW_WITHIN_MS = 14 * DAY_MS
/** Or below this many credits left (about 60¢, a few dozen writes), whatever the grant's size. */
export const APP_CONNECT_RENEW_BUDGET_FLOOR = 1_000_000_000n

/** A pinned member contract and the version the app expects it at. */
export interface PinnedMemberContract {
  contractId: string
  version: number
}

export interface AppConnectPins {
  appId: string
  groupId: string
  groupOwner: string
  members: PinnedMemberContract[]
}

export { APP_CONNECT_DEFAULT_MEMBER_VERSION } from './pins.mjs'

/** The owning parser is shared with read-only release monitoring. */
export function parseAppConnectPins(env: {
  appId?: string
  groupId?: string
  groupOwner?: string
  members?: string
}): AppConnectPins | null {
  return parsePins(env)
}

export function appConnectPins(): AppConnectPins | null {
  return parseAppConnectPins({
    appId: process.env.NEXT_PUBLIC_APP_CONNECT_APP_ID,
    groupId: process.env.NEXT_PUBLIC_APP_CONNECT_GROUP_ID,
    groupOwner: process.env.NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER,
    members: process.env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS,
  })
}

/**
 * The contract an encryption key must be bound to on this build: the anchor
 * on App Connect builds (null there when the pins are missing, which leaves
 * messaging unavailable), null on legacy builds, where keys are unbound.
 */
export function messagingAnchorId(): string | null {
  return isAppConnectBuild() ? appConnectPins()?.appId ?? null : null
}
