import { PlatformAuthController, decodeYapprIdentityId, type AuthUser } from 'platform-auth'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { useLoginModal } from '@/hooks/use-login-modal'
import { createYapprPlatformAuthDependencies } from '@/lib/auth/platform-auth-adapters'
import { getConfiguredNetwork, type AppNetwork } from '@/lib/constants'
import {
  clearAuthVaultDek,
  clearEncryptionKey,
  clearEncryptionKeyType,
  clearLoginKey,
  clearPrivateKey,
  clearTransferKey,
  hasEncryptionKey,
} from '@/lib/secure-storage'
import { stopDmEngine } from '@/lib/services/dm-v5'
import { dpnsService } from '@/lib/services/dpns-service'
import { identityService } from '@/lib/services/identity-service'
import { logger } from '@/lib/logger'
import { appConnectPins, isAppConnectBuild } from '@/lib/app-connect/config'
import { appConnectPlatformPort } from '@/lib/app-connect/platform-port'
import { appConnectSessions, useAppConnectStatus, type RenewReason } from '@/lib/app-connect/session-manager'
import type { AppConnectHealth } from '@/lib/app-connect/session-health'
import { walletKeyRows, type WalletKeyRow } from '@/lib/app-connect/wallet-keys'
import { RpcError } from '../protocol/envelope'
import { createAccountRegistry, type SignInMethod } from '../session/accounts'
import { createAppConnectFlow, type AppConnectFlowDTO, type AppConnectReturn } from '../session/app-connect'
import { engineKeyRingBackend, forgetEngineRing } from '../session/app-connect-store'
import { createKeyExchange, type KeyExchangeRequestDTO, type KeyExchangeStep } from '../session/key-exchange'
import { assertWalletKeyEnabled, verifySignInKey } from '../session/keys'
import type { AppLifecycleState } from '../shims/lifecycle'
import type { SecureHold } from '../shims/storage'
import type { TicketStore } from '../writes/tickets'

export type { KeyExchangeRequestDTO, KeyToRegister } from '../session/key-exchange'
export type { SignInMethod } from '../session/accounts'
export type { AppConnectCandidateDTO, AppConnectFlowDTO, AppConnectPhaseDTO, AppConnectReturn } from '../session/app-connect'

export interface SessionDTO {
  identityId: string
  network: AppNetwork
  username: string | null
  /** Credits (AuthUser.balance). */
  credits: bigint
  /** An encryption key is stored for this identity (needed for DMs and private feeds). */
  hasEncryptionKey: boolean
  method: SignInMethod
}

export interface AccountDTO {
  identityId: string
  username: string | null
  method: SignInMethod
  lastUsedAt: Date
  active: boolean
}

/** What a typed key resolves to, before signing in (PRD AUTH-08 "Identity found"). */
export interface KeyCheckDTO {
  identityId: string
  username: string | null
  keyId: number
  securityLevel: number
}

export type KeyExchangeResultDTO = KeyExchangeStep<SessionDTO>

/** `renewed`: a wallet renewed the active account's App Connect keys. */
export type SessionChangeReason = 'restored' | 'signed-in' | 'switched' | 'signed-out' | 'key-invalid' | 'balance' | 'renewed'

/** The active App Connect session's standing, for the renew prompts (web's `useAppConnectStatus`). */
export interface AppConnectStatusDTO {
  /** The account signed in through a wallet (App Connect), or null. */
  identityId: string | null
  /** `renew-soon`: under a fifth of the allowance or two weeks left; `renew-required`: writes have stopped. */
  health: AppConnectHealth | null
  /** A write was stopped for the allowance or the expiry: renewing in the wallet is what brings writes back. */
  renewRequired: RenewReason | null
  /** The account the engine signed out because its wallet revoked this device's keys (after the sign-out), until dismissed. */
  signedOutByWallet: string | null
}

/** One key a wallet granted Yappr for this account (Settings): what it may do, its allowance and expiry. */
export type WalletConnectionDTO = WalletKeyRow

/** How accepting a wallet's answer ended. `reload`: the account was parked here, and the host restarts the engine into it. */
export type AppConnectAcceptDTO =
  | { status: 'signed-in'; session: SessionDTO; reload: boolean }
  | { status: 'renewed'; session: SessionDTO }

export interface SessionEvents {
  'session.changed': { session: SessionDTO | null; reason: SessionChangeReason }
  'session.keyRequired': { identityId: string | null; purpose: 'auth' | 'encryption' }
  /** Every change of the App Connect sign-in or renewal in progress. */
  'session.appConnect': AppConnectFlowDTO
  /** Every change of the App Connect session's standing. */
  'session.appConnectStatus': AppConnectStatusDTO
}

export interface SessionModuleOptions {
  emit<E extends keyof SessionEvents>(event: E, payload: SessionEvents[E]): void
  tickets?: TicketStore
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /**
   * Resolves once the host has written every secure batch so far. Sign-in
   * and sign-out wait for it, so a reported sign-in is durable and a
   * reported sign-out has removed the keys (ENGINE.md §9.1). Absent in Node.
   */
  secureDurable?: () => Promise<void>
  /**
   * Holds back secure writes from the host (`EngineStorage.holdSecure`), so a
   * failed wallet sign-in again (AUTH-14) cannot delete the parked account's
   * stored secrets. Absent in Node.
   */
  holdSecure?: (matches: (key: string) => boolean) => SecureHold
  /** The auth controller (the engine shares it with {@link foregroundBalanceRefresh}); tests stub its dependencies. */
  controller?: PlatformAuthController
  /**
   * Stops direct messages and saves their pending state, before sign-out or
   * an account switch takes the keys away (the `dm` module). Default: lib's
   * `stopDmEngine`, which does not wait for the save.
   */
  stopDm?: () => Promise<void>
  /** Sign-out failed after `stopDm`: the account stays signed in, so its messages may run again. */
  resumeDm?: () => void
  /** An account signed out (active or not): remove what its messages keep on the device (the `dm` module). */
  forgetDm?: (identityId: string) => void
  /**
   * Shared with {@link createMobileAuthController}: the identities signed in
   * by key in this engine while parked, so their stored secrets were never
   * hydrated here (PRD AUTH-14, signing an account in again). The session
   * module adds to it; the controller and `dm.unlock` read it.
   */
  unhydrated?: Set<string>
}

/** A Platform identity id: 32 bytes in base58. */
function isIdentityId(value: string): boolean {
  try {
    return decodeYapprIdentityId(value).length === 32
  } catch {
    return false
  }
}

/** AuthUser.balance (a number of credits) as the DTOs carry credits. */
const toCredits = (balance: number): bigint => BigInt(Math.trunc(balance))

/**
 * Mobile 1.0 signs in with a wallet (key exchange) or a private key only
 * (ADR-001 E5): no vaults, passwords or passkeys, no username or profile
 * gate (DPNS registration links out to web). Post-login tasks (block data,
 * private-feed key sync) and the encryption-key auto-derive stay on, as on
 * web. The balance refresh runs in the foreground only
 * ({@link foregroundBalanceRefresh}).
 *
 * `unhydrated` (the session module's): for those identities lib cannot see
 * whether an encryption key is stored, so the auto-derive after a key login
 * counts one as stored and never writes its derived key over an imported
 * one. The host restarts the engine after such a sign-in, which loads the
 * stored keys (`dm.unlock` can then derive one if none was stored).
 */
export function createMobileAuthController({ unhydrated }: { unhydrated?: ReadonlySet<string> } = {}): PlatformAuthController {
  const deps = createYapprPlatformAuthDependencies()
  const secretStore: typeof deps.secretStore = unhydrated
    ? { ...deps.secretStore, hasEncryptionKey: identityId => unhydrated.has(identityId) || deps.secretStore.hasEncryptionKey(identityId) }
    : deps.secretStore
  return new PlatformAuthController({
    ...deps,
    secretStore,
    features: {
      ...deps.features,
      usernameGate: false,
      profileGate: false,
      passwordLogin: false,
      passkeyLogin: false,
      authVault: false,
      legacyPasswordLogin: false,
      balanceRefresh: false,
    },
    vault: undefined,
    passkeys: undefined,
    legacyPasswordLogins: undefined,
  })
}

/** How often the signed-in balance is read while the app is in the foreground (platform-auth's default). */
const BALANCE_REFRESH_MS = 300_000

/**
 * The controller's balance refresh, in the foreground only (PRD NET-08):
 * platform-auth's own `setInterval` keeps running in a backgrounded Android
 * WebView. Every `intervalMs` while signed in and active, and at once on
 * return to the foreground when the last read is older than that; the
 * engine's `lifecycle` drives `lifecycle()`.
 */
export function foregroundBalanceRefresh(
  controller: {
    getState(): { user: unknown }
    subscribe(listener: () => void): unknown
    refreshBalance(): Promise<void>
  },
  intervalMs = BALANCE_REFRESH_MS,
) {
  let foreground = true
  let timer: ReturnType<typeof setInterval> | null = null
  /** When the balance was last read here (the controller reads it itself on sign-in and restore). */
  let lastRead = Date.now()
  const refresh = () => {
    lastRead = Date.now()
    controller.refreshBalance().catch(error => logger.warn('Balance refresh failed:', error))
  }
  const sync = () => {
    const run = foreground && controller.getState().user !== null
    if (run && !timer) {
      timer = setInterval(refresh, intervalMs)
    } else if (!run && timer) {
      clearInterval(timer)
      timer = null
    }
  }
  controller.subscribe(sync)
  return {
    lifecycle(state: AppLifecycleState): void {
      if (state === 'inactive') return
      const back = state === 'active' && !foreground
      foreground = state === 'active'
      if (back && controller.getState().user !== null && Date.now() - lastRead >= intervalMs) refresh()
      sync()
    },
  }
}

/**
 * `session.*` (ENGINE.md §6.3). lib has one session slot, so one account is
 * active in the engine at a time; switching accounts or adding one is a
 * controlled engine restart: `switchAccount`/`prepareAddAccount` rearrange
 * storage, then the host restarts the engine with the next account's secrets.
 */
export function createSessionModule(options: SessionModuleOptions) {
  const storage = options.storage ?? localStorage
  // lib's App Connect key ring lives in the engine's storage (the device's secure storage), not IndexedDB.
  appConnectSessions.useKeyRingBackend(engineKeyRingBackend(localStorage))
  const controller = options.controller ?? createMobileAuthController()
  const registry = createAccountRegistry(storage)
  const stopDm = options.stopDm ?? (async () => stopDmEngine())
  const unhydrated = options.unhydrated ?? new Set<string>()

  function toDTO(user: AuthUser | null): SessionDTO | null {
    if (!user) return null
    return {
      identityId: user.identityId,
      network: getConfiguredNetwork(),
      username: user.username ?? null,
      credits: toCredits(user.balance),
      hasEncryptionKey: hasEncryptionKey(user.identityId),
      method: registry.get(user.identityId)?.method ?? 'key',
    }
  }

  function announce(reason: SessionChangeReason): SessionDTO | null {
    const session = toDTO(controller.getState().user)
    options.emit('session.changed', { session, reason })
    return session
  }

  let restoring: Promise<SessionDTO | null> | null = null
  /** Restores lib's saved session once per engine boot; every session call waits for it. */
  function restored(): Promise<SessionDTO | null> {
    restoring ??= (async () => {
      const switched = registry.takeSwitchMarker()
      const hadSession = registry.activeIdentityId() !== null
      const user = await controller.restoreSession()
      if (!user) {
        if (hadSession) announce('key-invalid')
        return null
      }
      if (!registry.get(user.identityId)) registry.upsert(user.identityId, { username: user.username ?? null })
      return announce(switched ? 'switched' : 'restored')
    })()
    return restoring
  }

  /**
   * One account at a time: a different identity is added through
   * `prepareAddAccount`. Signing in again as the active identity is refused
   * too: a failed wallet re-login would clear that identity's stored keys
   * (platform-auth's `loginWithLoginKey`). To re-enter a key, sign out first.
   */
  function assertSlotFree(identityId: string): void {
    const active = registry.activeIdentityId()
    if (active === identityId) throw new RpcError('This account is already signed in', 'BAD_REQUEST')
    if (active) {
      throw new RpcError('Another account is signed in. Add the account (session.prepareAddAccount) and restart the engine first.', 'BAD_REQUEST')
    }
  }

  /**
   * Sign-ins and account changes (switch, add, sign-out) run one at a time:
   * two can never race for lib's single session slot, and none can run while
   * another waits for direct messages to stop.
   */
  let sessionQueue: Promise<unknown> = Promise.resolve()
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = sessionQueue.then(task)
    sessionQueue = run.catch(() => undefined)
    return run
  }

  function exclusiveSignIn(identityId: string, login: () => Promise<unknown>, method: SignInMethod): Promise<SessionDTO> {
    return exclusive(async () => {
      assertSlotFree(identityId)
      await login()
      return signedIn(identityId, method)
    })
  }

  /**
   * After `switchAccount`/`prepareAddAccount` lib's session slot no longer
   * matches the controller and the keys in memory: until the host restarts
   * the engine, session and write calls are refused.
   */
  let restartRequired = false
  function assertUsable(): void {
    if (restartRequired) throw new RpcError('The engine must restart to finish switching accounts', 'RESTART_REQUIRED')
  }
  function requireRestart(): void {
    restartRequired = true
    options.tickets?.requireRestart()
  }

  async function signedIn(identityId: string, method: SignInMethod): Promise<SessionDTO> {
    const user = controller.getState().user
    registry.upsert(identityId, { username: user?.username ?? null, method })
    await options.secureDurable?.()
    const session = announce('signed-in')
    if (!session) throw new RpcError('Sign-in did not establish a session', 'NOT_SIGNED_IN')
    return session
  }

  /** Park the active account (if any) and put `identityId`'s session in place; the host restarts the engine next. */
  async function switchNow(identityId: string): Promise<void> {
    await stopDm()
    assertUsable()
    registry.switchTo(identityId)
    requireRestart()
  }

  /** An account parked on this device (by "Add account") while the session slot is empty. */
  function isParked(identityId: string): boolean {
    return registry.activeIdentityId() === null && registry.get(identityId)?.savedSession !== undefined
  }

  const keyExchange = createKeyExchange<SessionDTO>({
    controller,
    storage,
    async complete(identityId, loginKey, keyIndex, { reauth }) {
      assertUsable()
      return exclusive(async () => {
        // The wallet answered for an account parked here: switch to it with its saved keys. Logging
        // in again would put them at risk: a failed login-key login clears the identity's keys by
        // name, and the host then purges the parked account's secrets it never hydrated. Unless the
        // account is being signed in again (`reauth`, PRD AUTH-14): those keys no longer sign.
        const parked = isParked(identityId)
        if (parked && !reauth) {
          await switchNow(identityId)
          return { status: 'switch', identityId }
        }
        assertSlotFree(identityId)
        // The key this login would store must still sign: else the account would only be marked again.
        await assertWalletKeyEnabled(identityId, loginKey)
        if (parked) {
          // A failed login-key login clears the identity's keys by name, and the host would delete
          // the stored ones it never hydrated here (an imported encryption key among them): hold
          // this identity's secure writes until the login has succeeded, and drop them if it fails.
          // A successful one stores the wallet-derived encryption key, as web does (ENGINE.md).
          const hold = options.holdSecure?.(key => key.endsWith(`_${identityId}`))
          let succeeded = false
          try {
            await controller.completeYapprKeyExchangeLogin({ identityId, loginKey, keyIndex })
            succeeded = true
          } finally {
            hold?.release(succeeded)
          }
        } else {
          await controller.completeYapprKeyExchangeLogin({ identityId, loginKey, keyIndex })
        }
        return { status: 'signed-in', session: await signedIn(identityId, 'key-exchange') }
      })
    },
  })

  const appConnect = createAppConnectFlow({ emit: state => options.emit('session.appConnect', state) })
  /** Bumped by every App Connect start and cancel, so a start still waiting for the restore can tell it was overtaken. */
  let appConnectStarts = 0

  /** The account a revoke signed out here: reported only once its sign-out is done, never for a revoke that changed nothing. */
  let revokedSignOut: string | null = null
  function currentAppConnectStatus(): AppConnectStatusDTO {
    const { identityId, health, renewRequired } = useAppConnectStatus.getState()
    return { identityId, health, renewRequired, signedOutByWallet: revokedSignOut }
  }
  const emitAppConnectStatus = () => options.emit('session.appConnectStatus', currentAppConnectStatus())
  // The App Connect session's standing (allowance, expiry, a revoke) reaches the host's prompts.
  useAppConnectStatus.subscribe(emitAppConnectStatus)

  // The wallet revoked or superseded this device's keys (lib found it on a refresh or a refused
  // write, and dropped the ring): sign the account out, as web does. A newer grant for the same
  // account stands, and a revoke that a sign-out or another sign-in overtook ends nothing.
  /** A revoke held back while that account's renewal runs: the sign-out it owes, unless the renewal lands. */
  let deferredRevoke: string | null = null
  function signOutRevoked(identityId: string): void {
    exclusive(async () => {
      if (registry.activeIdentityId() !== identityId || appConnectSessions.current(identityId)) return
      // A renewal started while this waited its turn: it replaces the keys, so the sign-out waits for it.
      if (appConnect.renewing() === identityId) {
        deferredRevoke = identityId
        return
      }
      await signOutNow({ identityId })
      revokedSignOut = identityId
      emitAppConnectStatus()
    }).catch(error => logger.error('Signing out after the wallet revoked this device failed:', error))
  }
  /** The renewal a revoke waited for ended without a new grant (cancelled, or replaced by another flow): sign out now. */
  function settleDeferredRevoke(): void {
    const identityId = deferredRevoke
    if (!identityId || appConnect.renewing() === identityId) return
    deferredRevoke = null
    if (!appConnectSessions.current(identityId)) signOutRevoked(identityId)
  }

  appConnectSessions.onSignedOut(identityId => {
    // lib's own notice is web's; the host hears of a revoke from this module, once the sign-out is done.
    useAppConnectStatus.getState().dismissSignedOut()
    if (controller.getState().user?.identityId !== identityId) return
    if (appConnectSessions.current(identityId)) return
    // A renewal supersedes the old keys the moment the wallet answers it: the renewal in progress
    // is what replaces them, so it stands (writes fail meanwhile). Abandoned, it signs out then.
    if (appConnect.renewing() === identityId) {
      deferredRevoke = identityId
      return
    }
    // The app was killed while the wallet answered a renewal: the host resumes that renewal at launch.
    // The lookup is async, so what it finds counts only if no flow started or ended meanwhile.
    const flowBefore = appConnect.state().flow
    appConnect.pending(identityId)
      .catch(() => false)
      .then(waiting => {
        if (appConnectSessions.current(identityId)) return
        if (appConnect.renewing() === identityId) {
          deferredRevoke = identityId
          return
        }
        if (waiting && appConnect.state().flow === flowBefore) deferredRevoke = identityId
        else signOutRevoked(identityId)
      })
      .catch(error => logger.error('Handling a revoke failed:', error))
  })

  /**
   * Signs in with the grant of a wallet's answer the user confirmed. A
   * renewal of the active account only replaces its keys. An account parked
   * on this device signs in afresh (its old keys are the ones the wallet just
   * superseded), with its secure writes held until the sign-in has
   * succeeded, so a failure cannot touch the secrets it keeps here; the host
   * then restarts the engine into it to load them.
   */
  async function acceptAppConnect(identityId: string): Promise<AppConnectAcceptDTO> {
    const renewing = appConnect.renewing()
    const hint = appConnect.hint()
    if (hint !== undefined && hint !== identityId) {
      throw new RpcError(renewing ? 'The renewal came from another account' : 'The answer came from another account', 'BAD_REQUEST')
    }
    const active = registry.activeIdentityId()
    if (renewing !== undefined && active === identityId && controller.getState().user?.identityId === identityId) {
      const grant = appConnect.accept(identityId)
      if (!grant) throw new RpcError('That answer is no longer available. Try again.', 'BAD_REQUEST')
      await appConnectSessions.adopt(grant)
      if (deferredRevoke === identityId) deferredRevoke = null
      useAppConnectStatus.getState().dismissRenewRequired()
      // The renewal may have added keys: whatever reads the identity next must not see a cached copy.
      identityService.clearCache(identityId)
      await options.secureDurable?.()
      const session = announce('renewed')
      if (!session) throw new RpcError('Renewing did not keep the session', 'NOT_SIGNED_IN')
      return { status: 'renewed', session }
    }
    // A renewal whose account was signed out meanwhile (the wallet disabled the old keys first) signs it back in.
    assertSlotFree(identityId)
    const parked = isParked(identityId)
    const grant = appConnect.accept(identityId)
    if (!grant) throw new RpcError('That answer is no longer available. Try again.', 'BAD_REQUEST')
    const hold = parked ? options.holdSecure?.(key => key.endsWith(`_${identityId}`)) : undefined
    let succeeded = false
    try {
      const ring = await appConnectSessions.adopt(grant)
      try {
        await controller.loginWithKeyRing(identityId, { skipUsernameCheck: true })
        // A sign-out while the controller read the identity ended this session: undo the sign-in.
        if (!appConnectSessions.current(identityId)) {
          await controller.logout()
          throw new RpcError('Signed out while the wallet was connecting', 'BAD_REQUEST')
        }
      } catch (error) {
        await appConnectSessions.discard(ring)
        // A login that got as far as storing its session leaves none behind (a parked account's deletes are held, and dropped).
        if (controller.getState().user?.identityId === identityId) await controller.logout()
        throw error
      }
      succeeded = true
    } finally {
      hold?.release(succeeded)
    }
    if (revokedSignOut === identityId) {
      revokedSignOut = null
      emitAppConnectStatus()
    }
    const session = await signedIn(identityId, 'app-connect')
    // Its other stored secrets were never loaded here: nothing more runs until the host restarts into it.
    if (parked) requireRestart()
    return { status: 'signed-in', session, reload: parked }
  }

  /** The keys the wallets granted the active account, with this device's marked (Settings). */
  async function walletConnections(): Promise<WalletConnectionDTO[]> {
    const identityId = registry.activeIdentityId()
    const pins = appConnectPins()
    if (!identityId || !pins || !isAppConnectBuild()) return []
    const identity = await appConnectPlatformPort.getIdentityFresh(identityId)
    const keys = identity?.publicKeys ?? []
    const budgeted = keys.filter(key => key.totalBudget !== undefined && key.disabledAt === undefined).map(key => key.id)
    const budgets = budgeted.length > 0
      ? await appConnectPlatformPort.remainingBudgets(identityId, budgeted)
      : new Map<number, bigint | undefined>()
    const thisDevice = new Set(appConnectSessions.current(identityId)?.authKeys.map(key => key.keyId) ?? [])
    return walletKeyRows(keys, budgets, pins.groupId, thisDevice)
  }

  // lib asks for a key by opening web modals; the engine turns that into an event.
  const keyPrompts = [[useLoginModal, 'auth'], [useEncryptionKeyModal, 'encryption']] as const
  for (const [modal, purpose] of keyPrompts) {
    modal.subscribe(state => {
      if (!state.isOpen) return
      state.close()
      options.emit('session.keyRequired', { identityId: registry.activeIdentityId(), purpose })
    })
  }

  // The controller refreshes the balance every 5 minutes; report changes for the active identity.
  let lastUser: AuthUser | null = null
  controller.subscribe(state => {
    const previous = lastUser
    lastUser = state.user
    if (previous && state.user && previous.identityId === state.user.identityId &&
      (previous.balance !== state.user.balance || previous.username !== state.user.username)) {
      announce('balance')
    }
  })

  /** The body of `signOut`, run on the session queue. */
  async function signOutNow(opts: { identityId?: string }): Promise<void> {
    assertUsable()
    await restored()
    const active = registry.activeIdentityId()
    const identityId = opts.identityId ?? active
    if (!identityId) return
    const isActive = identityId === active
    if (isActive) {
      // Keys and session first: if logout fails, the account stays fully signed in.
      await stopDm()
      assertUsable()
      try {
        await controller.logout()
      } catch (error) {
        options.resumeDm?.()
        throw error
      }
    } else {
      for (const clear of [clearPrivateKey, clearEncryptionKey, clearEncryptionKeyType, clearTransferKey, clearLoginKey, clearAuthVaultDek]) {
        clear(identityId)
      }
    }
    options.tickets?.forgetIdentity(identityId)
    options.forgetDm?.(identityId)
    if (appConnect.renewing() === identityId) appConnect.cancel()
    registry.remove(identityId, { live: isActive })
    await options.secureDurable?.()
    if (isActive) announce('signed-out')
  }

  return {
    /** The active session, after the boot restore. */
    async current(): Promise<SessionDTO | null> {
      assertUsable()
      await restored()
      return toDTO(controller.getState().user)
    },

    /**
     * Restore the saved session (run at boot). The stored key must still
     * sign for the identity (`storedKeyBelongsToIdentity`); otherwise the
     * session is dropped and `session.changed {reason: 'key-invalid'}` fires.
     */
    async restore(): Promise<SessionDTO | null> {
      assertUsable()
      return restored()
    },

    /** Resolve a typed key (WIF or hex) to its identity without signing in. */
    async checkKey(input: { key: string }): Promise<KeyCheckDTO> {
      const verified = await verifySignInKey(input.key)
      const username = await dpnsService.resolveUsername(verified.identityId).catch(() => null)
      return { identityId: verified.identityId, username, keyId: verified.keyId, securityLevel: verified.securityLevel }
    },

    /**
     * Sign in with a private key (WIF or hex). Arguments are sensitive: never logged.
     * A parked account signed in this way (PRD AUTH-14: the host signs it in
     * again) keeps its stored encryption key (`unhydrated`); the host
     * restarts the engine next to load its other secrets.
     */
    async signInWithKey(input: { key: string }): Promise<SessionDTO> {
      assertUsable()
      await restored()
      const { identityId, wif } = await verifySignInKey(input.key)
      return exclusiveSignIn(identityId, async () => {
        const parked = isParked(identityId)
        if (parked) unhydrated.add(identityId)
        try {
          await controller.loginWithAuthKey(identityId, wif, { skipUsernameCheck: true })
        } catch (error) {
          if (parked) unhydrated.delete(identityId)
          throw error
        }
        // The key replaces any wallet grant this account had here: a parked account's ring is not
        // hydrated (so lib could not drop it), and the next boot would restore it ahead of the key.
        if (isAppConnectBuild()) forgetEngineRing(localStorage, appConnectSessions.network(), identityId)
      }, 'key')
    },

    /**
     * A wallet sign-in request. `reauth`: the identities whose stored keys no
     * longer sign (PRD AUTH-14, marked "Sign in again" by the host). The
     * wallet's answer for one parked here logs in with the new key rather than
     * switching back to its saved one. Kept with the request, so a request
     * resumed by a restarted engine does the same.
     */
    async startKeyExchange(opts: { reauth?: readonly string[] } = {}): Promise<KeyExchangeRequestDTO> {
      assertUsable()
      if (isAppConnectBuild()) throw new RpcError('This network signs in with App Connect (session.appConnectStart)', 'NOT_SUPPORTED')
      await restored()
      const reauth = opts.reauth ?? []
      if (!Array.isArray(reauth) || !reauth.every(id => typeof id === 'string')) {
        throw new RpcError('reauth must be a list of identity IDs', 'BAD_REQUEST')
      }
      return keyExchange.start({ reauth })
    },

    /** A wallet request that is still waiting (resume it after an app restart). */
    async pendingKeyExchange(): Promise<KeyExchangeRequestDTO | null> {
      if (isAppConnectBuild()) return null
      return keyExchange.pending()
    },

    /**
     * App Connect builds: start a wallet sign-in, or with `renew` a renewal
     * of the active account's keys (only it may answer). Resumes the stored
     * request of the same kind unless `fresh`. `returnTo`: the app's yap.pr
     * prefix and scheme, for the wallet's return link. The flow reports every
     * change as `session.appConnect`.
     */
    async appConnectStart(opts: { renew?: boolean; reauth?: string; fresh?: boolean; returnTo: AppConnectReturn }): Promise<AppConnectFlowDTO> {
      assertUsable()
      // A cancel (or a newer start) while this waits for the restore wins: it makes no request.
      const start = ++appConnectStarts
      await restored()
      if (start !== appConnectStarts) return appConnect.state()
      const active = registry.activeIdentityId()
      let identityHint: string | undefined
      if (opts?.renew) {
        // A renewal a revoke is waiting for (resumed after the app was killed) may go on without a ring.
        if (!active || (!appConnectSessions.current(active) && deferredRevoke !== active)) {
          throw new RpcError('Only an account signed in with a wallet can renew', 'BAD_REQUEST')
        }
        identityHint = active
      } else if (active) {
        // The wallet would register keys a sign-in here could never use: add the account first.
        throw new RpcError('Another account is signed in. Add the account (session.prepareAddAccount) and restart the engine first.', 'BAD_REQUEST')
      } else if (opts?.reauth !== undefined) {
        // Signing an account in again ("Sign in again"): only that account may answer.
        if (typeof opts.reauth !== 'string' || !isIdentityId(opts.reauth)) throw new RpcError('reauth must be an identity id', 'BAD_REQUEST')
        identityHint = opts.reauth
      }
      const started = appConnect.start({ identityHint, renew: opts?.renew === true, fresh: opts?.fresh === true, returnTo: opts?.returnTo })
      // A new flow replaces a renewal a revoke was waiting for.
      settleDeferredRevoke()
      return started
    },

    /** The App Connect flow in progress (`phase: 'idle'` when there is none). */
    async appConnectState(): Promise<AppConnectFlowDTO> {
      return appConnect.state()
    },

    /**
     * Whether a request is still waiting for its wallet (resume it after the
     * app was killed): a sign-in's, or with `renew` the active account's renewal.
     */
    async appConnectPending(opts: { renew?: boolean } = {}): Promise<boolean> {
      await restored()
      if (!opts?.renew) return appConnect.pending()
      const active = registry.activeIdentityId()
      return active !== null && appConnect.pending(active)
    },

    /** Poll now: the app came back, or the wallet's return link named `requestHash` (hex). False when no flow takes it. */
    async appConnectPollNow(opts: { requestHash?: string } = {}): Promise<boolean> {
      return appConnect.pollNow(opts?.requestHash)
    },

    /** After a timeout: poll the same request while the wallet still accepts it, else make a fresh one. */
    async appConnectCheckAgain(): Promise<void> {
      await appConnect.checkAgain()
    },

    /** "That's not me": forget every answer and the request, and show a new code. */
    async appConnectReject(): Promise<void> {
      await appConnect.reject()
    },

    /** Abandon the flow: its request and any verified answer are forgotten. */
    async appConnectCancel(): Promise<void> {
      appConnectStarts++
      appConnect.cancel()
      settleDeferredRevoke()
    },

    /**
     * The user confirmed `identityId` ("Continue as @alice"): sign in with its
     * verified grant, or renew the active account's keys with it.
     */
    async appConnectAccept(input: { identityId: string }): Promise<AppConnectAcceptDTO> {
      assertUsable()
      await restored()
      const identityId = input?.identityId
      if (typeof identityId !== 'string') throw new RpcError('identityId is required', 'BAD_REQUEST')
      try {
        return await exclusive(async () => {
          assertUsable()
          return acceptAppConnect(identityId)
        })
      } finally {
        // A renewal that did not land leaves the sign-out its revoke was owed.
        settleDeferredRevoke()
      }
    },

    /** The active App Connect session's standing (also sent as `session.appConnectStatus`). */
    async appConnectStatus(): Promise<AppConnectStatusDTO> {
      await restored()
      return currentAppConnectStatus()
    },

    /** The host showed the prompt: forget the write that asked for a renewal, or the revoke notice. */
    async appConnectDismiss(opts: { renewRequired?: boolean; signedOut?: boolean } = {}): Promise<void> {
      if (opts?.renewRequired) useAppConnectStatus.getState().dismissRenewRequired()
      if (opts?.signedOut && revokedSignOut !== null) {
        revokedSignOut = null
        emitAppConnectStatus()
      }
    },

    /** The keys the account's wallets granted Yappr, read from chain (Settings). */
    async appConnectConnections(): Promise<WalletConnectionDTO[]> {
      assertUsable()
      await restored()
      return walletConnections()
    },

    /** Wait up to `waitMs` (default 45 s, at most 120 s) for the wallet; `pending` means call again. */
    async awaitKeyExchange(requestId: string, opts: { waitMs?: number } = {}): Promise<KeyExchangeResultDTO> {
      assertUsable()
      if (isAppConnectBuild()) throw new RpcError('This network signs in with App Connect', 'NOT_SUPPORTED')
      return keyExchange.await(requestId, opts.waitMs)
    },

    /** After the wallet broadcast the key registration: wait up to `waitMs` for the keys, then sign in. */
    async awaitKeyRegistration(requestId: string, opts: { waitMs?: number } = {}): Promise<KeyExchangeResultDTO> {
      assertUsable()
      if (isAppConnectBuild()) throw new RpcError('This network signs in with App Connect', 'NOT_SUPPORTED')
      return keyExchange.awaitRegistration(requestId, opts.waitMs)
    },

    async cancelKeyExchange(requestId: string): Promise<void> {
      keyExchange.cancel(requestId)
    },

    async accounts(): Promise<AccountDTO[]> {
      await restored()
      const active = registry.activeIdentityId()
      return registry.list()
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .map(account => ({
          identityId: account.identityId,
          username: account.username,
          method: account.method,
          lastUsedAt: new Date(account.lastUsedAt),
          active: account.identityId === active,
        }))
    },

    /**
     * Switch to another signed-in account: a controlled engine restart, so
     * nothing of the current account survives in the engine's memory. This
     * saves the current account's session and stashes, puts the target's in
     * place, and resolves; the host then records the target as active and
     * restarts the engine with the target's secrets. The next boot's restore
     * reports `session.changed {reason: 'switched'}`.
     */
    switchAccount(identityId: string): Promise<void> {
      return exclusive(async () => {
        assertUsable()
        await restored()
        if (!registry.get(identityId)) throw new RpcError('That account is not signed in on this device', 'BAD_REQUEST')
        if (registry.activeIdentityId() === identityId) return
        await switchNow(identityId)
      })
    },

    /** Park the active account so another can sign in; the host restarts the engine with no secrets next. */
    prepareAddAccount(): Promise<void> {
      return exclusive(async () => {
        assertUsable()
        await restored()
        await stopDm()
        assertUsable()
        registry.switchTo(null)
        requireRestart()
      })
    },

    /**
     * Sign an account out and delete its keys, offline. The active account
     * goes through lib's logout (secrets, session, logout cleanup); another
     * account's secrets are cleared by id (the storage shim forwards deletes
     * of keys it does not hold, so the host removes them from the Keychain).
     */
    signOut(opts: { identityId?: string } = {}): Promise<void> {
      return exclusive(() => signOutNow(opts))
    },

    async refreshBalance(): Promise<{ credits: bigint }> {

      assertUsable()
      await restored()
      if (!controller.getState().user) throw new RpcError('Not signed in', 'NOT_SIGNED_IN')
      await controller.refreshBalance()
      return { credits: toCredits(controller.getState().user?.balance ?? 0) }
    },
  }
}
