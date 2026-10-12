import bs58 from 'bs58'
import { KeyPurpose, KeySecurityLevel, type AppConnectRequest } from 'platform-auth'
import {
  APP_CONNECT_GROUP_BUDGET,
  APP_CONNECT_GROUP_LIFETIME_MS,
  APP_CONNECT_PROFILE_BUDGET,
  APP_CONNECT_PROFILE_LIFETIME_MS,
  DASHPAY_CONTRACT_ID,
  DASHPAY_PROFILE_DOCUMENT_TYPE,
  type AppConnectPins,
} from './config'

export const YAPPR_APP_CONNECT_LABEL = 'Yappr'

export interface YapprRequestInput {
  pins: AppConnectPins
  appEphemeralPubKey: Uint8Array
  /** 16 bytes, per browser and network, kept across logouts. */
  connectionId: Uint8Array
  createdAt: number
  /** Renewal: only this identity may answer. */
  identityHint?: string
}

/**
 * Yappr's request (docs/APP_CONNECT_PROFILE.md, "Yappr's request"): the group
 * key at CRITICAL (the starter claim is a token batch) as the primary binding,
 * the DashPay profile key, and the anchor's encryption key. Renewal is a new
 * login carrying the identity hint and the same connection id, which
 * supersedes the old keys; MODE=renew waits for wallets that can raise limits
 * in place.
 */
export function buildYapprAppConnectRequest(input: YapprRequestInput): AppConnectRequest {
  const { pins, createdAt } = input
  return {
    appEphemeralPubKey: input.appEphemeralPubKey,
    appId: bs58.decode(pins.appId),
    label: YAPPR_APP_CONNECT_LABEL,
    authBindings: [
      {
        kind: 'contractGroup',
        id: bs58.decode(pins.groupId),
        securityLevel: KeySecurityLevel.CRITICAL,
        totalBudget: APP_CONNECT_GROUP_BUDGET,
        expiresAt: createdAt + APP_CONNECT_GROUP_LIFETIME_MS,
      },
      {
        kind: 'documentType',
        id: bs58.decode(DASHPAY_CONTRACT_ID),
        documentTypeName: DASHPAY_PROFILE_DOCUMENT_TYPE,
        securityLevel: KeySecurityLevel.HIGH,
        totalBudget: APP_CONNECT_PROFILE_BUDGET,
        expiresAt: createdAt + APP_CONNECT_PROFILE_LIFETIME_MS,
      },
    ],
    encBindings: [{ contractId: bs58.decode(pins.appId), purpose: KeyPurpose.ENCRYPTION }],
    createdAt,
    connectionId: input.connectionId,
    ...(input.identityHint ? { identityHint: bs58.decode(input.identityHint) } : {}),
  }
}

/**
 * The wallet's return link, or undefined where a wallet could not open it:
 * the profile only allows https callbacks (local http builds poll instead).
 */
export function appConnectCallbackUrl(origin: string, basePath: string, requestHashHex: string): string | undefined {
  let url: URL
  try {
    url = new URL(`${basePath.replace(/\/+$/, '')}/connect/`, origin)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  url.searchParams.set('r', requestHashHex)
  return url.toString()
}
