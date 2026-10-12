'use client'

import { APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS, selectSigningKey, type PinnedGroup, type SigningRequest } from 'platform-auth'
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed'
import { logger } from '@/lib/logger'
import { keyNetwork } from '@/lib/constants'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel, getPurposeName, getSecurityLevelName } from '@/lib/crypto/identity-keys'
import { consensusCodeOf, extractErrorMessage } from '@/lib/error-utils'
import { promptForAuthKey } from '@/lib/auth-utils'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { toAppConnectIdentityKey, type WasmIdentityKeyLike } from '@/lib/app-connect/key-mapping'
import { explainNoCoveringKey, rawSessionKey } from '@/lib/app-connect/signing-plan'
import { appConnectSessions, useAppConnectStatus } from '@/lib/app-connect/session-manager'
import { primaryGroupKey } from '@/lib/app-connect/session-health'

/**
 * The one place document and token writes get their signing key.
 *
 * - An App Connect session (a key ring) picks the narrowest live key that
 *   covers the write with `selectSigningKey`, before anything is built, so a
 *   write no key covers never reaches the network (where it would be a paid
 *   20014). Group keys only cover the members the startup trust check vouched for.
 * - A raw-key session (the stored WIF, as every legacy build has) signs with
 *   the CRITICAL or HIGH AUTHENTICATION key it matches, exactly as before. If
 *   that key is bound or carries limits, it goes through the same selector as
 *   a one-key ring.
 */

export type SigningUnavailableReason = 'renew' | 'wallet' | 'signed-out'

export const RENEW_IN_WALLET_MESSAGE = 'Renew Yappr in your Dash wallet to keep posting.'
export const NEEDS_WALLET_MESSAGE = 'This can\'t be done from this browser. Use your Dash wallet for it.'
export const SIGNED_OUT_MESSAGE = 'You were signed out from your Dash wallet. Sign in again to continue.'

export class SigningUnavailableError extends Error {
  constructor(readonly reason: SigningUnavailableReason, message: string) {
    super(message)
    this.name = 'SigningUnavailableError'
  }
}

export interface SigningKey {
  /** Compressed WIF; the caller drops it once the transition is signed. */
  wif: string
  identityKey: WasmIdentityPublicKey
  /** Signed by the App Connect key ring (so its refusals are key-ring errors). */
  appConnect: boolean
}

export interface ResolveSigningKeyOptions {
  /**
   * Only a raw key the user entered may sign this (moderation, YAPP
   * transfers): an App Connect session hands it to the wallet instead.
   */
  rawOnly?: boolean
  /** Raw path: the levels the stored key may match (default CRITICAL or HIGH). */
  allowedSecurityLevels?: readonly number[]
}

/** Whether this tab signs for `identityId` with an App Connect key ring. */
export function hasAppConnectSession(identityId: string): boolean {
  return appConnectSessions.current(identityId) !== null
}

async function trustedGroups(): Promise<PinnedGroup[]> {
  if (!isAppConnectBuild()) return []
  return [(await appConnectSessions.trust()).group]
}

export async function resolveSigningKey(
  ownerId: string,
  publicKeys: WasmIdentityPublicKey[],
  request: SigningRequest,
  options: ResolveSigningKeyOptions = {},
): Promise<SigningKey> {
  if (typeof window === 'undefined') {
    throw new Error('State transitions can only be performed in browser')
  }
  const session = appConnectSessions.current(ownerId)
  if (session) {
    if (options.rawOnly) throw new SigningUnavailableError('wallet', NEEDS_WALLET_MESSAGE)
    return resolveFromKeyRing(ownerId, publicKeys, request)
  }
  return resolveFromRawKey(ownerId, publicKeys, request, options)
}

async function resolveFromKeyRing(
  ownerId: string,
  publicKeys: WasmIdentityPublicKey[],
  request: SigningRequest,
): Promise<SigningKey> {
  const session = appConnectSessions.current(ownerId)
  if (!session) throw new SigningUnavailableError('signed-out', SIGNED_OUT_MESSAGE)
  const ctx = { now: Date.now(), groups: await trustedGroups() }
  const selection = selectSigningKey(session.authKeys, request, ctx)
  if (!selection.ok) {
    // Every write Yappr makes is one batch member, so a split plan means no single key covers it.
    if (explainNoCoveringKey(session.authKeys, request, ctx) === 'renew') {
      const group = primaryGroupKey(session)
      const expired = group?.expiresAt !== undefined && group.expiresAt - ctx.now <= APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS
      useAppConnectStatus.setState({ renewRequired: expired ? 'expired' : 'allowance-spent' })
      throw new SigningUnavailableError('renew', RENEW_IN_WALLET_MESSAGE)
    }
    logger.error(`App Connect: no key in the ring covers this write (${selection.reason})`)
    throw new SigningUnavailableError('wallet', NEEDS_WALLET_MESSAGE)
  }

  const identityKey = publicKeys.find((key) => key.keyId === selection.key.keyId)
  if (!identityKey || identityKey.disabledAt !== undefined) {
    // The wallet revoked or superseded this browser's grant; the refresh signs out.
    await appConnectSessions.refresh()
    throw new SigningUnavailableError('signed-out', SIGNED_OUT_MESSAGE)
  }
  const wif = await appConnectSessions.privateKeyWif(session, selection.key.keyRef)
  // The private key must be the chain key the ring says it is: never sign with a mismatched pair.
  if (!wif || !matchIdentityKey(wif, [identityKey], { network: keyNetwork(), purpose: KeyPurpose.AUTHENTICATION, keyId: identityKey.keyId }).ok) {
    logger.error(`App Connect: the key ring's key ${selection.key.keyId} is missing or does not match the chain; signing out`)
    await appConnectSessions.clear()
    useAppConnectStatus.setState({ signedOutByWallet: true })
    throw new SigningUnavailableError('signed-out', SIGNED_OUT_MESSAGE)
  }
  logger.debug(`App Connect: signing with key ${identityKey.keyId} (${selection.key.bounds?.kind ?? 'unbound'})`)
  return { wif, identityKey, appConnect: true }
}

async function resolveFromRawKey(
  ownerId: string,
  publicKeys: WasmIdentityPublicKey[],
  request: SigningRequest,
  options: ResolveSigningKeyOptions,
): Promise<SigningKey> {
  const { getPrivateKey } = await import('@/lib/secure-storage')
  const wif = getPrivateKey(ownerId)?.trim()
  if (!wif) {
    promptForAuthKey()
    throw new Error('Private key not found. Please re-enter your key.')
  }
  const result = matchIdentityKey(wif, publicKeys, {
    network: keyNetwork(),
    purpose: KeyPurpose.AUTHENTICATION,
    allowedSecurityLevels: options.allowedSecurityLevels ?? [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
  })
  if (!result.ok) {
    logger.error(
      result.reason === 'rejected'
        ? `Private key matches key id=${result.match.keyId} (purpose ${getPurposeName(result.match.purpose)}, level ${getSecurityLevelName(result.match.securityLevel)}), which cannot sign this operation`
        : 'Private key does not match any enabled key on this identity'
    )
    throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.')
  }

  // A bound or limited raw key gets the same pre-broadcast check as a key ring;
  // an unbound V0 key (every legacy login) signs as it always has.
  const wasmKey = result.key as unknown as WasmIdentityKeyLike
  const limited = Boolean(wasmKey.contractBounds) || wasmKey.totalBudget != null || wasmKey.expiresAt != null
  if (!limited) return { wif, identityKey: result.key, appConnect: false }
  const mapped = toAppConnectIdentityKey(wasmKey)
  if (!mapped) throw new Error('Your key could not be read. Sign in again.')
  let remaining: bigint | undefined
  if (mapped.totalBudget !== undefined) {
    const { appConnectPlatformPort } = await import('@/lib/app-connect/platform-port')
    remaining = (await appConnectPlatformPort.remainingBudgets(ownerId, [mapped.id])).get(mapped.id)
  }
  const ringKey = rawSessionKey(mapped, remaining)
  if (ringKey) {
    const ctx = { now: Date.now(), groups: await trustedGroups() }
    const selection = selectSigningKey([ringKey], request, ctx)
    if (!selection.ok) {
      throw new SigningUnavailableError(
        explainNoCoveringKey([ringKey], request, ctx),
        'The key you signed in with can\'t do this. Sign in with another key or use your Dash wallet.',
      )
    }
  }
  return { wif, identityKey: result.key, appConnect: false }
}

/** Call after a write signed with `key` was refused; updates the session for key-ring errors. */
export async function reportSigningFailure(ownerId: string, key: SigningKey, error: unknown): Promise<void> {
  if (!key.appConnect) return
  try {
    await appConnectSessions.handleWriteFailure(ownerId, consensusCodeOf(error) ?? codeFromMessage(error))
  } catch (handlingError) {
    logger.warn('App Connect: could not handle a refused write:', extractErrorMessage(handlingError))
  }
}

/** Call after a write landed (or was broadcast), so an App Connect session's budget stays current. */
export function reportSigningSuccess(ownerId: string): void {
  appConnectSessions.noteWriteLanded(ownerId)
}

function codeFromMessage(error: unknown): number | null {
  const match = /\bcode"?\s*[=:]\s*(\d{5})\b/i.exec(extractErrorMessage(error))
  return match ? Number(match[1]) : null
}
