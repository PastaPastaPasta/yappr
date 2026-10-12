'use client'

import { create } from 'zustand'
import {
  buildAppConnectSession,
  classifyAppConnectError,
  clearSensitiveBytes,
  KeyPurpose,
  KeySecurityLevel,
  type AppConnectGrant,
  type AppConnectSession,
  type AppConnectSigningFailure,
  type YapprKeyExchangeNetworkName,
} from 'platform-auth'
import { logger } from '@/lib/logger'
import { scopedKey } from '@/lib/storage-scope'
import { getConfiguredNetwork, keyNetwork } from '@/lib/constants'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { appConnectPins } from './config'
import { checkAppConnectTrust, type AppConnectTrust } from './group-trust'
import { AppConnectKeyRingStore, indexedDbKeyRingBackend } from './key-ring-store'
import { clearAppConnectEncryptionKey, setAppConnectEncryptionKey } from './memory-keys'
import { appConnectPlatformPort } from './platform-port'
import { appConnectHealth, primaryGroupKey, reconcileSessionWithChain, type AppConnectHealth } from './session-health'

/**
 * The browser's App Connect session: the key ring of the identity signed in
 * through a wallet, its health (allowance and expiry), and the startup group
 * trust check. Only App Connect builds create one; on legacy builds every
 * method here finds no session and the raw-key path signs as before.
 */

/** Why writes stopped until the user renews in their wallet. */
export type RenewReason = 'expired' | 'allowance-spent' | 'insufficient-allowance' | 'revoked-key'

interface AppConnectStatus {
  /** The identity with an App Connect session, or null. */
  identityId: string | null
  health: AppConnectHealth | null
  /** Set when a write was refused for the allowance or expiry: the blocking renew prompt. */
  renewRequired: RenewReason | null
  /** The wallet revoked this browser's keys; the session was wiped. */
  signedOutByWallet: boolean
  /** The group key is CRITICAL (the wallet granted what was asked), so token claims can be signed here. */
  canSignTokens: boolean
  dismissRenewRequired: () => void
  dismissSignedOut: () => void
}

export const useAppConnectStatus = create<AppConnectStatus>((set) => ({
  identityId: null,
  health: null,
  renewRequired: null,
  signedOutByWallet: false,
  canSignTokens: false,
  dismissRenewRequired: () => set({ renewRequired: null }),
  dismissSignedOut: () => set({ signedOutByWallet: false }),
}))

/**
 * Whether `identityId` signs with an App Connect session whose group key is
 * only HIGH: token transitions (the starter claim) cannot be signed here, so
 * the claim is hidden rather than offered and then refused.
 */
export function useTokenClaimHidden(identityId: string | undefined): boolean {
  return useAppConnectStatus((state) => identityId !== undefined && state.identityId === identityId && !state.canSignTokens)
}

const REFRESH_INTERVAL_MS = 60 * 60_000

function publishSession(session: AppConnectSession | null): void {
  if (!session) {
    useAppConnectStatus.setState({ identityId: null, health: null, renewRequired: null, canSignTokens: false })
    return
  }
  const group = primaryGroupKey(session)
  useAppConnectStatus.setState({
    identityId: session.identityId,
    health: appConnectHealth(session, Date.now()),
    canSignTokens: group?.securityLevel === KeySecurityLevel.CRITICAL,
  })
}

class AppConnectSessionManager {
  private store: AppConnectKeyRingStore | null = null
  private active: AppConnectSession | null = null
  private trustPromise: Promise<AppConnectTrust> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private signedOutListener: ((identityId: string) => void) | null = null

  network(): YapprKeyExchangeNetworkName {
    return getConfiguredNetwork()
  }

  private keyStore(): AppConnectKeyRingStore {
    this.store ??= new AppConnectKeyRingStore(indexedDbKeyRingBackend(scopedKey('yappr-app-connect')))
    return this.store
  }

  /** This browser's connection id for the configured network (hex). */
  connectionId(): Promise<string> {
    return this.keyStore().connectionId(this.network())
  }

  /**
   * The proved group trust check, run once per page load (and again after a
   * failed read). Login is offered only when it passes; signing routes group
   * keys only to the members it vouched for.
   */
  trust(): Promise<AppConnectTrust> {
    const pins = appConnectPins()
    if (!pins) return Promise.reject(new Error('App Connect is not configured on this build'))
    this.trustPromise ??= checkAppConnectTrust(appConnectPlatformPort, pins)
      .then((trust) => {
        if (!trust.ok) logger.error('App Connect group trust check failed; new logins are blocked:', trust.reason, trust.contracts ?? '')
        return trust
      })
      .catch((error: unknown) => {
        this.trustPromise = null
        throw error
      })
    return this.trustPromise
  }

  /** The session for `identityId` (or any, without one) if this tab holds it. */
  current(identityId?: string): AppConnectSession | null {
    if (!this.active || (identityId !== undefined && this.active.identityId !== identityId)) return null
    return this.active
  }

  onSignedOut(listener: ((identityId: string) => void) | null): void {
    this.signedOutListener = listener
  }

  /** Stores a verified grant as this browser's session and makes it active. Wipes the grant's keys. */
  async adopt(grant: AppConnectGrant): Promise<AppConnectSession> {
    const pins = appConnectPins()
    if (!pins) throw new Error('App Connect is not configured on this build')
    const keys = new Map<string, Uint8Array>()
    const session = buildAppConnectSession(grant, {
      network: this.network(),
      appId: pins.appId,
      groupId: pins.groupId,
      connectionId: await this.connectionId(),
      grantedAt: Date.now(),
      keyRef: (privateKey, keyId) => {
        const ref = `key-${keyId}`
        keys.set(ref, privateKey.slice())
        return ref
      },
    })
    try {
      await this.keyStore().save(session, keys)
    } finally {
      keys.forEach(clearSensitiveBytes)
    }
    await this.activate(session)
    return session
  }

  /** Loads the stored session for `identityId` without touching the network. */
  async restore(identityId: string): Promise<boolean> {
    if (this.active?.identityId === identityId) return true
    let session: AppConnectSession | null
    try {
      session = await this.keyStore().load(this.network())
    } catch (error) {
      logger.warn('App Connect: could not read the key ring:', error)
      return false
    }
    if (!session || session.identityId !== identityId) return false
    await this.activate(session)
    return true
  }

  private async activate(session: AppConnectSession): Promise<void> {
    this.active = session
    clearAppConnectEncryptionKey()
    const pins = appConnectPins()
    const encKey = session.encKeys.find((key) => key.purpose === KeyPurpose.ENCRYPTION && key.contractId === pins?.appId)
    if (encKey) {
      const wif = await this.privateKeyWif(session, encKey.keyRef)
      if (wif) setAppConnectEncryptionKey(session.identityId, wif)
    }
    publishSession(session)
    this.startRefresh()
  }

  /** Forgets the session and its keys (logout or revoke). The connection id stays. */
  async clear(): Promise<void> {
    this.active = null
    clearAppConnectEncryptionKey()
    this.stopRefresh()
    publishSession(null)
    try {
      await this.keyStore().clear(this.network())
    } catch (error) {
      logger.error('App Connect: could not clear the key ring:', error)
    }
  }

  /** A stored private key as a compressed WIF, or null when the ring has none under `keyRef`. */
  async privateKeyWif(session: AppConnectSession, keyRef: string): Promise<string | null> {
    const bytes = await this.keyStore().privateKey(session, keyRef)
    if (!bytes) return null
    try {
      return privateKeyToWif(bytes, keyNetwork(), true)
    } finally {
      clearSensitiveBytes(bytes)
    }
  }

  /**
   * Re-reads the session's keys from chain: budgets and expiries are applied,
   * and a key the wallet revoked or superseded signs the user out. A failed
   * read changes nothing (being offline must not end a session).
   */
  async refresh(): Promise<void> {
    const session = this.active
    if (!session) return
    let reconciled: ReturnType<typeof reconcileSessionWithChain>
    try {
      const identity = await appConnectPlatformPort.getIdentityFresh(session.identityId)
      if (!identity) return
      const budgeted = session.authKeys.filter((key) => key.totalBudget !== undefined).map((key) => key.keyId)
      const budgets = budgeted.length > 0
        ? await appConnectPlatformPort.remainingBudgets(session.identityId, budgeted)
        : new Map<number, bigint | undefined>()
      reconciled = reconcileSessionWithChain(session, identity.publicKeys, budgets)
    } catch (error) {
      logger.warn('App Connect: session refresh failed:', error)
      return
    }
    if (this.active !== session) return
    if (reconciled.revoked) {
      await this.signOutByWallet(session.identityId)
      return
    }
    this.active = reconciled.session
    publishSession(reconciled.session)
    await this.keyStore().updateSession(reconciled.session).catch((error: unknown) => {
      logger.warn('App Connect: could not persist refreshed budgets:', error)
    })
  }

  private async signOutByWallet(identityId: string): Promise<void> {
    logger.warn(`App Connect: the wallet revoked this browser's keys for ${identityId}; signing out`)
    await this.clear()
    useAppConnectStatus.setState({ signedOutByWallet: true })
    this.signedOutListener?.(identityId)
  }

  /**
   * What a refused write means for the session (docs/APP_CONNECT_PROFILE.md,
   * "Errors"). Returns the failure when the code is a key-ring error.
   */
  async handleWriteFailure(identityId: string, code: number | null): Promise<AppConnectSigningFailure | null> {
    const classification = classifyAppConnectError(code)
    if (!classification || this.active?.identityId !== identityId) return null
    switch (classification.action) {
      case 'renew': {
        const reason: RenewReason = classification.failure === 'expired'
          ? 'expired'
          : classification.failure === 'allowance-spent' ? 'allowance-spent' : 'insufficient-allowance'
        useAppConnectStatus.setState({ renewRequired: reason })
        await this.refresh()
        break
      }
      case 'logout':
        await this.signOutByWallet(identityId)
        break
      case 'invalidate':
        logger.error(`App Connect: a write was refused out of its key's bounds (code ${code}). The selector should make this impossible.`)
        await this.refresh()
        break
      case 'handoff':
        logger.error(`App Connect: a write needs the wallet (code ${code}); the session cannot sign it`)
        break
    }
    return classification.failure
  }

  private budgetRefresh: ReturnType<typeof setTimeout> | null = null

  /** A write signed by the ring landed: re-read the budgets shortly (coalesced across a burst of writes). */
  noteWriteLanded(identityId: string): void {
    if (this.active?.identityId !== identityId || this.budgetRefresh) return
    this.budgetRefresh = setTimeout(() => {
      this.budgetRefresh = null
      this.refresh().catch((error: unknown) => logger.warn('App Connect: budget refresh failed:', error))
    }, 10_000)
  }

  private startRefresh(): void {
    if (this.refreshTimer || typeof window === 'undefined') return
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error: unknown) => logger.warn('App Connect: hourly check failed:', error))
    }, REFRESH_INTERVAL_MS)
    // First check soon after start, off the restore path.
    setTimeout(() => {
      this.refresh().catch((error: unknown) => logger.warn('App Connect: startup check failed:', error))
    }, 5_000)
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }
}

export const appConnectSessions = new AppConnectSessionManager()
