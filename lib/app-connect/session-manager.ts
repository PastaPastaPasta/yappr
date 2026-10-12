'use client'

import { create } from 'zustand'
import {
  APP_CONNECT_SESSION_VERSION,
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
import { AppConnectKeyRingStore, exactGrant, indexedDbKeyRingBackend, isNewerGrant, isSameGrant, type SessionMatch } from './key-ring-store'
import { clearAppConnectEncryptionKey, setAppConnectEncryptionKey, setAppConnectSessionIdentity } from './memory-keys'
import { appConnectPlatformPort } from './platform-port'
import {
  appConnectHealth,
  primaryGroupKey,
  reconcileSessionWithChain,
  withoutOutdatedEncryptionKeys,
  type AppConnectHealth,
} from './session-health'

/**
 * The browser's App Connect session: the key ring of the identity signed in
 * through a wallet, its health (allowance and expiry), and the startup group
 * trust check. Only App Connect builds create one; on legacy builds every
 * method here finds no session and the raw-key path signs as before.
 */

/** Why writes stopped until the user renews in their wallet. */
export type RenewReason = 'expired' | 'allowance-spent' | 'insufficient-allowance'

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
  /** Bumped by every activation and deactivation, so an activation finishing late can tell it was overtaken. */
  private activations = 0
  /** Bumped by every logout; `loggedOutAt` keeps each identity's latest, so an adoption can tell a logout overtook it. */
  private lifecycle = 0
  private readonly loggedOutAt = new Map<string, number>()
  private signedOutListener: ((identityId: string) => void) | null = null

  network(): YapprKeyExchangeNetworkName {
    return getConfiguredNetwork()
  }

  /** The browser's key ring (also holds the wrapped pending sign-in request). */
  keyStore(): AppConnectKeyRingStore {
    this.store ??= new AppConnectKeyRingStore(indexedDbKeyRingBackend(scopedKey('yappr-app-connect')))
    return this.store
  }

  /** This browser's connection id for the configured network (hex). */
  connectionId(): Promise<string> {
    return this.keyStore().connectionId(this.network())
  }

  /**
   * The proved group trust check, cached for the page and run again by the
   * hourly refresh, before every sign-in (`fresh`) and after a failed read.
   * Login is offered only when it passes; signing routes group keys only to
   * the members it vouched for.
   */
  trust(options: { fresh?: boolean } = {}): Promise<AppConnectTrust> {
    const pins = appConnectPins()
    if (!pins) return Promise.reject(new Error('App Connect is not configured on this build'))
    if (options.fresh) this.trustPromise = null
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
    const startedAt = this.lifecycle
    const keys = new Map<string, Uint8Array>()
    let session: AppConnectSession
    let stored = false
    try {
      const pins = appConnectPins()
      if (!pins) throw new Error('App Connect is not configured on this build')
      session = buildAppConnectSession(grant, {
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
      stored = await this.keyStore().save(session, keys)
    } finally {
      keys.forEach(clearSensitiveBytes)
      for (const granted of [...grant.authKeys, ...grant.encryptionKeys]) clearSensitiveBytes(granted.privateKey)
    }
    if (!stored) {
      // Another tab stored a newer grant for this identity meanwhile: use that one.
      const newer = await this.keyStore().load(this.network())
      if (!newer || newer.identityId !== session.identityId) throw new Error('The wallet sign-in was replaced; try again')
      session = newer
    }
    // The user logged out of this identity while the grant was being stored:
    // the logout stands, so forget exactly this grant and activate nothing.
    if (this.signedOutSince(session.identityId, startedAt)) {
      if (stored) await this.clearStored(exactGrant(session))
      throw new Error('Signed out while the wallet was connecting')
    }
    // A logout (or another sign-in) while the keys were read overtook this one: nothing may sign in on it.
    if (!await this.activate(session)) throw new Error('Signed out while the wallet was connecting')
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
    // A session from a build with other pins (a re-cut anchor or group) covers nothing here.
    const pins = appConnectPins()
    if (!pins || session.v !== APP_CONNECT_SESSION_VERSION || session.network !== this.network()
      || session.appId !== pins.appId || session.groupId !== pins.groupId) {
      logger.warn('App Connect: the stored session does not match this build; dropping it')
      await this.discard(session)
      return false
    }
    return this.activate(session)
  }

  /** Makes `session` this tab's own. False when a logout, discard or newer activation overtook it meanwhile. */
  private async activate(session: AppConnectSession): Promise<boolean> {
    const activation = ++this.activations
    this.active = session
    setAppConnectSessionIdentity(session.identityId)
    clearAppConnectEncryptionKey()
    const pins = appConnectPins()
    const encKey = session.encKeys.find((key) => key.purpose === KeyPurpose.ENCRYPTION && key.contractId === pins?.appId)
    const wif = encKey ? await this.privateKeyWif(session, encKey.keyRef) : null
    // A logout, discard or newer activation during the key read wins: install nothing for this one.
    if (activation !== this.activations) return false
    if (wif) setAppConnectEncryptionKey(session.identityId, wif)
    publishSession(session)
    this.startRefresh()
    return true
  }

  /** Drops this tab's in-memory session; the stored ring is left alone. */
  private deactivate(): void {
    this.activations++
    this.active = null
    setAppConnectSessionIdentity(null)
    clearAppConnectEncryptionKey()
    this.stopRefresh()
    publishSession(null)
  }

  private async clearStored(match: SessionMatch): Promise<void> {
    try {
      await this.keyStore().clear(this.network(), match)
    } catch (error) {
      logger.error('App Connect: could not clear the key ring:', error)
    }
  }

  /** Logout: forgets this browser's session for `identityId`, whichever tab stored it. The connection id stays. */
  async logout(identityId: string): Promise<void> {
    this.cancelAdoptions(identityId)
    if (this.active?.identityId === identityId) this.deactivate()
    await this.clearStored({ identityId })
  }

  /**
   * `identityId` is being signed out: an adoption for it under way now
   * activates nothing. Called on every sign-out, also one that leaves the
   * stored ring alone because this tab no longer holds a grant (after a revoke).
   */
  cancelAdoptions(identityId: string): void {
    this.loggedOutAt.set(identityId, ++this.lifecycle)
  }

  /** Whether `identityId` was signed out (or a raw key replaced its grant) after `lifecycle` read `since`. */
  private signedOutSince(identityId: string, since: number): boolean {
    return (this.loggedOutAt.get(identityId) ?? 0) > since
  }

  /**
   * A raw key signed `identityId` in: this tab stops using its wallet grant
   * for it and drops an adoption under way. Only that exact grant is cleared,
   * never a newer one another tab stored.
   */
  async yieldToRawKey(identityId: string): Promise<void> {
    this.cancelAdoptions(identityId)
    const session = this.current(identityId)
    if (session) await this.discard(session)
  }

  /** Whether this tab's active session is `session`'s grant, even after a refresh replaced the object. */
  private holds(session: AppConnectSession): boolean {
    return this.active !== null && isSameGrant(this.active, session)
  }

  /**
   * Forgets exactly `session` (a login that failed after its grant was stored),
   * never a newer grant another tab has stored since.
   */
  async discard(session: AppConnectSession): Promise<void> {
    if (this.holds(session)) this.deactivate()
    await this.clearStored(exactGrant(session))
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
    let encryptionOutdated = false
    try {
      const identity = await appConnectPlatformPort.getIdentityFresh(session.identityId)
      if (!identity) return
      const budgeted = session.authKeys.filter((key) => key.totalBudget !== undefined).map((key) => key.keyId)
      const budgets = budgeted.length > 0
        ? await appConnectPlatformPort.remainingBudgets(session.identityId, budgeted)
        : new Map<number, bigint | undefined>()
      reconciled = reconcileSessionWithChain(session, identity.publicKeys, budgets)
      const appId = appConnectPins()?.appId
      if (!reconciled.revoked && appId && reconciled.session.encKeys.some((key) => key.contractId === appId)) {
        const current = await appConnectPlatformPort.contractKeys(session.identityId, appId, KeyPurpose.ENCRYPTION)
        const updated = withoutOutdatedEncryptionKeys(reconciled.session, appId, current)
        if (updated) {
          encryptionOutdated = true
          reconciled = { revoked: false, session: updated }
        }
      }
    } catch (error) {
      logger.warn('App Connect: session refresh failed:', error)
      return
    }
    if (this.active !== session) return
    if (reconciled.revoked) {
      await this.signOutRevoked(session)
      return
    }
    if (encryptionOutdated) {
      // Peers now encrypt to the newer key another wallet registered; the messaging prompts lead to renewing for it.
      logger.warn(`App Connect: ${session.identityId} has a newer messaging key from another wallet; this session stops using its own`)
      clearAppConnectEncryptionKey()
    }
    this.active = reconciled.session
    publishSession(reconciled.session)
    await this.keyStore().updateSession(reconciled.session).catch((error: unknown) => {
      logger.warn('App Connect: could not persist the refreshed session:', error)
    })
  }

  /**
   * `session`'s keys are revoked, superseded or unusable. A wallet supersedes
   * the old grant whenever another tab signs in again, so first look for a
   * newer grant for the same identity in the store and switch to it; only when
   * there is none does this tab sign out, clearing its own grant and nothing else.
   */
  async signOutRevoked(session: AppConnectSession): Promise<void> {
    // A grant this tab no longer holds (signed out, or replaced by a raw key or
    // a newer grant since the caller read it) has nothing left here to end.
    if (!this.holds(session)) return
    const startedAt = this.lifecycle
    let stored: AppConnectSession | null = null
    try {
      stored = await this.keyStore().load(this.network())
    } catch (error) {
      logger.warn('App Connect: could not re-read the key ring:', error)
    }
    if (stored && stored.identityId === session.identityId && isNewerGrant(stored, session)) {
      logger.info(`App Connect: another tab renewed the session for ${session.identityId}; switching to it`)
      if (this.holds(session)) await this.activate(stored)
      return
    }
    logger.warn(`App Connect: the wallet revoked this browser's keys for ${session.identityId}; signing out`)
    await this.discard(session)
    // A logout or a raw-key sign-in for this identity overtook the revoke: the
    // session it would end is no longer this grant's, so it signs nothing out.
    if (this.signedOutSince(session.identityId, startedAt)) return
    useAppConnectStatus.setState({ signedOutByWallet: true })
    this.signedOutListener?.(session.identityId)
  }

  /**
   * What a refused write means for the session (docs/APP_CONNECT_PROFILE.md,
   * "Errors"). Returns the failure when the code is a key-ring error.
   */
  async handleWriteFailure(identityId: string, code: number | null): Promise<AppConnectSigningFailure | null> {
    const classification = classifyAppConnectError(code)
    const session = this.active
    if (!classification || !session || session.identityId !== identityId) return null
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
        await this.signOutRevoked(session)
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
      // A member update since page load narrows what the group key may sign for.
      this.trust({ fresh: true }).catch((error: unknown) => logger.warn('App Connect: hourly trust check failed:', error))
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
