import bs58 from 'bs58'
import { DASHPAY_CONTRACT_ID } from '@/lib/constants'

/**
 * Build-time switches and pinned data for App Connect login
 * (docs/APP_CONNECT_PROFILE.md, docs/APP_CONNECT_CONTRACTS.md).
 *
 * `NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect` turns it on for a build; anything
 * else (or nothing) keeps the legacy key exchange, which is all PV13 networks
 * (testnet, mainnet) can run. Every `process.env.NEXT_PUBLIC_*` read below is
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

/** Every member is registered at version 1; an update could widen what group keys sign for. */
export const APP_CONNECT_DEFAULT_MEMBER_VERSION = 1

function isIdentifier(value: string): boolean {
  try {
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}

/**
 * The pinned anchor, group, owner and members, or null when any is missing or
 * malformed (App Connect is then unavailable on this build). Members are
 * comma-separated contract ids, each optionally `id:version`; a bare id expects
 * version 1. The anchor must be pinned as a member, and no member twice.
 */
export function parseAppConnectPins(env: {
  appId?: string
  groupId?: string
  groupOwner?: string
  members?: string
}): AppConnectPins | null {
  const appId = env.appId?.trim() ?? ''
  const groupId = env.groupId?.trim() ?? ''
  const groupOwner = env.groupOwner?.trim() ?? ''
  if (![appId, groupId, groupOwner].every(isIdentifier)) return null

  const members: PinnedMemberContract[] = []
  for (const entry of (env.members ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [contractId, versionText, extra] = entry.split(':')
    if (extra !== undefined || !isIdentifier(contractId)) return null
    const version = versionText === undefined ? APP_CONNECT_DEFAULT_MEMBER_VERSION : Number(versionText)
    if (!Number.isSafeInteger(version) || version < 1) return null
    if (members.some((member) => member.contractId === contractId)) return null
    members.push({ contractId, version })
  }
  if (!members.some((member) => member.contractId === appId)) return null
  return { appId, groupId, groupOwner, members }
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
