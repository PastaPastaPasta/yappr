import { PlatformAuthController, type AuthUser } from 'platform-auth'
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
import { logger } from '@/lib/logger'
import { RpcError } from '../protocol/envelope'
import { createAccountRegistry, type SignInMethod } from '../session/accounts'
import { createKeyExchange, type KeyExchangeRequestDTO, type KeyExchangeStep } from '../session/key-exchange'
import { verifySignInKey } from '../session/keys'
import type { AppLifecycleState } from '../shims/lifecycle'
import type { TicketStore } from '../writes/tickets'

export type { KeyExchangeRequestDTO, KeyToRegister } from '../session/key-exchange'
export type { SignInMethod } from '../session/accounts'

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

export type SessionChangeReason = 'restored' | 'signed-in' | 'switched' | 'signed-out' | 'key-invalid' | 'balance'

export interface SessionEvents {
  'session.changed': { session: SessionDTO | null; reason: SessionChangeReason }
  'session.keyRequired': { identityId: string | null; purpose: 'auth' | 'encryption' }
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
 */
export function createMobileAuthController(): PlatformAuthController {
  const deps = createYapprPlatformAuthDependencies()
  return new PlatformAuthController({
    ...deps,
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
  const controller = options.controller ?? createMobileAuthController()
  const registry = createAccountRegistry(storage)
  const stopDm = options.stopDm ?? (async () => stopDmEngine())

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
    async complete(identityId, loginKey, keyIndex) {
      assertUsable()
      return exclusive(async () => {
        // The wallet answered for an account parked here: switch to it with its saved keys. Logging
        // in again would put them at risk: a failed login-key login clears the identity's keys by
        // name, and the host then purges the parked account's secrets it never hydrated.
        if (isParked(identityId)) {
          await switchNow(identityId)
          return { status: 'switch', identityId }
        }
        assertSlotFree(identityId)
        await controller.completeYapprKeyExchangeLogin({ identityId, loginKey, keyIndex })
        return { status: 'signed-in', session: await signedIn(identityId, 'key-exchange') }
      })
    },
  })

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

    /** Sign in with a private key (WIF or hex). Arguments are sensitive: never logged. */
    async signInWithKey(input: { key: string }): Promise<SessionDTO> {
      assertUsable()
      await restored()
      const verified = await verifySignInKey(input.key)
      return exclusiveSignIn(verified.identityId, () => controller.loginWithAuthKey(verified.identityId, verified.wif, { skipUsernameCheck: true }), 'key')
    },

    async startKeyExchange(): Promise<KeyExchangeRequestDTO> {
      assertUsable()
      await restored()
      return keyExchange.start()
    },

    /** A wallet request that is still waiting (resume it after an app restart). */
    async pendingKeyExchange(): Promise<KeyExchangeRequestDTO | null> {
      return keyExchange.pending()
    },

    /** Wait up to `waitMs` (default 45 s, at most 120 s) for the wallet; `pending` means call again. */
    async awaitKeyExchange(requestId: string, opts: { waitMs?: number } = {}): Promise<KeyExchangeResultDTO> {
      assertUsable()
      return keyExchange.await(requestId, opts.waitMs)
    },

    /** After the wallet broadcast the key registration: wait up to `waitMs` for the keys, then sign in. */
    async awaitKeyRegistration(requestId: string, opts: { waitMs?: number } = {}): Promise<KeyExchangeResultDTO> {
      assertUsable()
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
