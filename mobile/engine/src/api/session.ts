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
import { RpcError } from '../protocol/envelope'
import { createAccountRegistry, type SignInMethod } from '../session/accounts'
import { createKeyExchange, type KeyExchangeRequestDTO, type KeyExchangeStep } from '../session/key-exchange'
import { verifySignInKey } from '../session/keys'
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
  /** Tests inject a controller with stubbed dependencies. */
  controller?: PlatformAuthController
}

/** AuthUser.balance (a number of credits) as the DTOs carry credits. */
const toCredits = (balance: number): bigint => BigInt(Math.trunc(balance))

/**
 * Mobile 1.0 signs in with a wallet (key exchange) or a private key only
 * (ADR-001 E5): no vaults, passwords or passkeys, no username or profile
 * gate (DPNS registration links out to web). Post-login tasks (block data,
 * private-feed key sync), the encryption-key auto-derive and the balance
 * refresh stay on, as on web.
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
    },
    vault: undefined,
    passkeys: undefined,
    legacyPasswordLogins: undefined,
  })
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

  /** Sign-ins run one at a time, so two can never race for lib's single session slot. */
  let signInQueue: Promise<unknown> = Promise.resolve()
  function exclusiveSignIn(identityId: string, login: () => Promise<unknown>, method: SignInMethod): Promise<SessionDTO> {
    const run = signInQueue.then(async () => {
      assertSlotFree(identityId)
      await login()
      return signedIn(identityId, method)
    })
    signInQueue = run.catch(() => undefined)
    return run
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

  const keyExchange = createKeyExchange<SessionDTO>({
    controller,
    storage,
    async complete(identityId, loginKey, keyIndex) {
      assertUsable()
      return exclusiveSignIn(identityId, () => controller.completeYapprKeyExchangeLogin({ identityId, loginKey, keyIndex }), 'key-exchange')
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
    async switchAccount(identityId: string): Promise<void> {
      assertUsable()
      await restored()
      if (!registry.get(identityId)) throw new RpcError('That account is not signed in on this device', 'BAD_REQUEST')
      if (registry.activeIdentityId() === identityId) return
      stopDmEngine()
      registry.switchTo(identityId)
      requireRestart()
    },

    /** Park the active account so another can sign in; the host restarts the engine with no secrets next. */
    async prepareAddAccount(): Promise<void> {
      assertUsable()
      await restored()
      stopDmEngine()
      registry.switchTo(null)
      requireRestart()
    },

    /**
     * Sign an account out and delete its keys, offline. The active account
     * goes through lib's logout (secrets, session, logout cleanup); another
     * account's secrets are cleared by id (the storage shim forwards deletes
     * of keys it does not hold, so the host removes them from the Keychain).
     */
    async signOut(opts: { identityId?: string } = {}): Promise<void> {
      assertUsable()
      await restored()
      const active = registry.activeIdentityId()
      const identityId = opts.identityId ?? active
      if (!identityId) return
      const isActive = identityId === active
      if (isActive) {
        // Keys and session first: if logout fails, the account stays fully signed in.
        stopDmEngine()
        await controller.logout()
      } else {
        for (const clear of [clearPrivateKey, clearEncryptionKey, clearEncryptionKeyType, clearTransferKey, clearLoginKey, clearAuthVaultDek]) {
          clear(identityId)
        }
      }
      options.tickets?.forgetIdentity(identityId)
      registry.remove(identityId, { live: isActive })
      await options.secureDurable?.()
      if (isActive) announce('signed-out')
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
