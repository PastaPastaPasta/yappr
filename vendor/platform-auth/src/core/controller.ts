import type {
  AuthSessionSnapshot,
  AuthUser,
  PlatformAuthDependencies,
  PlatformAuthEvent,
  PlatformAuthFeatures,
  PlatformAuthIntent,
  PlatformAuthResult,
  PlatformAuthState,
  YapprDecryptedKeyExchangeResult,
  YapprKeyExchangeConfig,
  YapprKeyRegistrationRequest,
  YapprUnsignedKeyRegistrationResult,
} from './types'
import {
  DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG,
  decodeYapprContractId,
  pollForYapprKeyExchangeResponse,
} from '../key-exchange/yappr-protocol'

const DEFAULT_FEATURES: PlatformAuthFeatures = {
  usernameGate: true,
  profileGate: true,
  keyExchangeLogin: true,
  autoDeriveEncryptionKey: true,
  postLoginTasks: true,
  balanceRefresh: true,
}

const DEFAULT_BALANCE_REFRESH_MS = 300_000

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * A sign-in overtaken while it read the identity: another sign-in stored its
 * session, the tab signed out, or (key-ring sign-ins) its keys stopped being
 * the tab's. It stops before it stores or publishes anything, so whatever
 * overtook it stands.
 */
export class SupersededSignInError extends Error {
  public constructor() {
    super('Another sign-in or a sign-out happened first. Please try again.')
    this.name = 'SupersededSignInError'
  }
}

/** Options for a key-ring sign-in. */
export interface KeyRingLoginOptions {
  skipUsernameCheck?: boolean
  /**
   * Asked once the identity has been read, right before the session is
   * stored: false means the keys this sign-in was started for are no longer
   * the tab's, and it rejects with {@link SupersededSignInError} instead.
   */
  stillCurrent?: () => boolean
  /**
   * The {@link PlatformAuthController.sessionEpoch} the sign-in began on, when
   * it began before this call (say, before its keys were stored). Any sign-in
   * or sign-out since then supersedes it. Defaults to the epoch at this call.
   */
  since?: number
  /**
   * Key sign-ins only. Runs inside the session commit, after the session was
   * saved, immediately before the key is stored; never for a superseded or
   * failed commit. For metadata a stored key must never lack (say, that it
   * came from a passkey).
   */
  beforeStore?: () => void
  /**
   * Key sign-ins only. Runs inside the commit immediately after the key was
   * stored, so a failed store leaves the previous key's metadata as it was.
   */
  afterStore?: () => void
}

function buildIntent(kind: PlatformAuthIntent['kind'], identityId: string, username?: string): PlatformAuthIntent {
  if (kind === 'profile-required') {
    return { kind, identityId, username }
  }
  return { kind, identityId }
}

export class PlatformAuthController {
  private readonly features: PlatformAuthFeatures

  private readonly listeners = new Set<(state: PlatformAuthState) => void>()

  private readonly logger

  private readonly balanceRefreshMs: number

  private state: PlatformAuthState = {
    user: null,
    isLoading: false,
    isAuthRestoring: true,
    error: null,
  }

  private balanceInterval: ReturnType<typeof setInterval> | null = null

  /** Bumped whenever a session is stored or ended, so a sign-in can tell it was overtaken. */
  private epoch = 0

  private restoringIdentityId: string | null = null

  /** The tail of the session commits and logouts, which run one at a time and never interleave. */
  private lifecycle: Promise<unknown> = Promise.resolve()

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(run, run)
    this.lifecycle = next.catch(() => undefined)
    return next
  }

  public constructor(private readonly deps: PlatformAuthDependencies) {
    this.features = { ...DEFAULT_FEATURES, ...deps.features }
    this.logger = deps.logger ?? noopLogger
    this.balanceRefreshMs = deps.balanceRefreshMs ?? DEFAULT_BALANCE_REFRESH_MS
  }

  /**
   * Changes whenever a sign-in stores its session or the tab signs out. A
   * caller holding an action back for the current session compares it later,
   * so the action never lands on a session that replaced that one.
   */
  public sessionEpoch(): number {
    return this.epoch
  }

  public getState(): PlatformAuthState {
    return this.state
  }

  public subscribe(listener: (state: PlatformAuthState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public dispose(): void {
    if (this.balanceInterval) {
      clearInterval(this.balanceInterval)
      this.balanceInterval = null
    }
    this.listeners.clear()
  }

  public getYapprKeyExchangeConfig(overrides: Partial<YapprKeyExchangeConfig> = {}): YapprKeyExchangeConfig {
    const configured = this.deps.yapprKeyExchangeConfig ?? {}

    const appContractId = overrides.appContractId ?? configured.appContractId
    const keyExchangeContractId = overrides.keyExchangeContractId ?? configured.keyExchangeContractId
    if (!appContractId || !keyExchangeContractId) {
      throw new Error('Yappr key exchange is not configured')
    }

    return {
      appContractId,
      keyExchangeContractId,
      network: overrides.network ?? configured.network ?? this.deps.network,
      label: overrides.label ?? configured.label ?? DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.label,
      pollIntervalMs: overrides.pollIntervalMs ?? configured.pollIntervalMs ?? DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.pollIntervalMs,
      timeoutMs: overrides.timeoutMs ?? configured.timeoutMs ?? DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.timeoutMs,
    }
  }

  public async pollYapprKeyExchangeResponse(
    appEphemeralPubKeyHash: Uint8Array,
    appEphemeralPrivateKey: Uint8Array,
    overrides: Partial<YapprKeyExchangeConfig> = {},
    options: { signal?: AbortSignal; onPoll?: () => void } = {},
  ): Promise<YapprDecryptedKeyExchangeResult> {
    const { port, config } = this.requireYapprKeyExchange(overrides)
    const contractIdBytes = decodeYapprContractId(config.appContractId)

    return pollForYapprKeyExchangeResponse(
      port,
      contractIdBytes,
      appEphemeralPubKeyHash,
      appEphemeralPrivateKey,
      {
        pollIntervalMs: config.pollIntervalMs,
        timeoutMs: config.timeoutMs,
        signal: options.signal,
        onPoll: options.onPoll,
        logger: this.logger,
      },
    )
  }

  public async checkYapprKeysRegistered(
    identityId: string,
    authPublicKey: Uint8Array,
    encryptionPublicKey: Uint8Array,
    overrides: Partial<YapprKeyExchangeConfig> = {},
  ): Promise<boolean> {
    const { port } = this.requireYapprKeyExchange(overrides)
    return port.checkKeysRegistered(identityId, authPublicKey, encryptionPublicKey)
  }

  public async buildYapprUnsignedKeyRegistrationTransition(
    request: YapprKeyRegistrationRequest,
    overrides: Partial<YapprKeyExchangeConfig> = {},
  ): Promise<YapprUnsignedKeyRegistrationResult> {
    const { port } = this.requireYapprKeyExchange(overrides)
    return port.buildUnsignedKeyRegistrationTransition(request)
  }

  public async completeYapprKeyExchangeLogin(input: {
    identityId: string
    loginKey: Uint8Array
    keyIndex: number
  }): Promise<PlatformAuthResult> {
    return this.loginWithLoginKey(input.identityId, input.loginKey, input.keyIndex)
  }

  public async restoreSession(): Promise<AuthUser | null> {
    const startedAt = this.epoch
    this.patchState({ isAuthRestoring: true, error: null })

    try {
      const snapshot = await this.deps.sessionStore.getSession()
      if (startedAt !== this.epoch) return null
      if (!snapshot) {
        this.patchState({ isAuthRestoring: false })
        return null
      }

      const identityId = snapshot.user.identityId
      this.restoringIdentityId = identityId
      const hasPrivateKey = await this.deps.secretStore.hasPrivateKey(identityId)
      if (startedAt !== this.epoch) return null
      if (!hasPrivateKey) {
        // A different tab may hold a tab-only key for this shared snapshot.
        // Failure to restore here does not end its session. Only logout removes it.
        // Metadata may outlive lost keys; consumers must use the live controller state.
        this.patchState({ isAuthRestoring: false, user: null })
        return null
      }

      this.patchState({
        user: snapshot.user,
        isAuthRestoring: false,
        error: null,
      })

      await this.deps.clientIdentity?.setIdentity(identityId)
      await this.emit({ type: 'session-restored', user: snapshot.user })

      if (this.deps.usernames) {
        void this.syncUsername(identityId)
      }

      this.startBalanceRefresh()
      this.runPostLoginTasks(identityId, 3000)
      return snapshot.user
    } catch (error) {
      this.logger.error('platform-auth: failed to restore session', error)
      if (startedAt !== this.epoch) return null
      this.patchState({
        user: null,
        error: error instanceof Error ? error.message : 'Failed to restore session',
        isAuthRestoring: false,
      })
      return null
    } finally {
      if (startedAt === this.epoch) this.restoringIdentityId = null
    }
  }

  /** `since`: as for {@link loginWithKeyRing}, when the sign-in began before this call (say, with a check of the key). */
  public async loginWithAuthKey(
    identityId: string,
    privateKey: string,
    options: Pick<KeyRingLoginOptions, 'skipUsernameCheck' | 'since' | 'beforeStore' | 'afterStore'> = {},
  ): Promise<PlatformAuthResult> {
    if (!identityId || !privateKey) {
      this.patchState({ error: 'Identity ID and private key are required' })
      throw new Error('Identity ID and private key are required')
    }
    return this.establishSession(identityId, privateKey, options)
  }

  /**
   * Signs in an identity whose signing keys the platform already holds outside
   * the secret store's single private key (an App Connect key ring, stored by
   * the caller before this call). `secretStore.hasPrivateKey` must answer true
   * for it, or a later restore drops the session. `stillCurrent` binds the
   * sign-in to the keys it was started for (see {@link KeyRingLoginOptions}).
   */
  public async loginWithKeyRing(
    identityId: string,
    options: KeyRingLoginOptions = {},
  ): Promise<PlatformAuthResult> {
    if (!identityId) {
      this.patchState({ error: 'Identity ID is required' })
      throw new Error('Identity ID is required')
    }
    return this.establishSession(identityId, null, options)
  }

  private async establishSession(
    identityId: string,
    privateKey: string | null,
    options: KeyRingLoginOptions,
  ): Promise<PlatformAuthResult> {
    const skipUsernameCheck = options.skipUsernameCheck ?? false
    const startedAt = options.since ?? this.epoch
    this.patchState({ isLoading: true, error: null })

    try {
      const identity = await this.deps.identity.getIdentity(identityId)
      if (!identity) {
        throw new Error('Identity not found')
      }

      let username: string | null = null
      let usernameKnown = true
      if (this.deps.usernames) {
        try {
          username = await this.deps.usernames.resolveUsername(identity.id)
        } catch (error) {
          // A failed lookup is not "no username": skip the gate and retry in the background.
          this.logger.warn('platform-auth: username lookup failed during login', error)
          usernameKnown = false
        }
      }
      const user: AuthUser = {
        identityId: identity.id,
        balance: identity.balance,
        username: username ?? undefined,
        publicKeys: identity.publicKeys,
      }

      // The commit (session, key, publication) runs whole, never interleaved with a logout or
      // another commit. Checked as it starts, after the last read: an overtaken sign-in stores nothing.
      await this.exclusive(async () => {
        if (this.epoch !== startedAt || (options.stillCurrent && !options.stillCurrent())) throw new SupersededSignInError()
        this.epoch += 1
        await this.persistSessionUser(user)
        if (privateKey !== null) {
          options.beforeStore?.()
          await this.deps.secretStore.storePrivateKey(identity.id, privateKey)
          options.afterStore?.()
        }
        await this.deps.clientIdentity?.setIdentity(identity.id)
        this.restoringIdentityId = null
        this.patchState({
          user,
          isAuthRestoring: false,
          error: null,
        })
      })

      await this.emit({ type: 'login-succeeded', user })
      this.startBalanceRefresh()
      if (privateKey !== null) this.tryAutoDeriveEncryptionKey(identity.id, privateKey, user.publicKeys)
      if (!usernameKnown) {
        void this.syncUsername(identity.id)
      }

      if (this.features.usernameGate && !skipUsernameCheck && usernameKnown && !user.username) {
        await this.emit({ type: 'username-required', identityId: identity.id })
        return {
          user,
          intent: buildIntent('username-required', identity.id),
        }
      }

      if (this.features.profileGate && this.deps.profiles) {
        const hasProfile = await this.deps.profiles.hasProfile(identity.id, user.username)
        if (!hasProfile) {
          await this.emit({ type: 'profile-required', identityId: identity.id, username: user.username })
          return {
            user,
            intent: buildIntent('profile-required', identity.id, user.username),
          }
        }
      }

      this.runPostLoginTasks(identity.id, 2000)
      return {
        user,
        intent: buildIntent('ready', identity.id),
      }
    } catch (error) {
      // A superseded sign-in leaves the state to the session that replaced it.
      if (error instanceof SupersededSignInError) throw error
      this.logger.error('platform-auth: auth-key login failed', error)
      this.patchState({
        error: error instanceof Error ? error.message : 'Failed to login',
      })
      throw error
    } finally {
      this.patchState({ isLoading: false })
    }
  }

  public async loginWithLoginKey(identityId: string, loginKey: Uint8Array, keyIndex: number): Promise<PlatformAuthResult> {
    if (!this.features.keyExchangeLogin) {
      throw new Error('Login-key login is disabled')
    }
    if (!this.deps.crypto) {
      throw new Error('Login-key login requires crypto adapters')
    }

    this.patchState({ isLoading: true, error: null })

    try {
      const identityIdBytes = this.deps.crypto.decodeIdentityId(identityId)
      const authKey = this.deps.crypto.deriveAuthKeyFromLogin(loginKey, identityIdBytes)
      const encryptionKey = this.deps.crypto.deriveEncryptionKeyFromLogin(loginKey, identityIdBytes)
      const authKeyWif = this.deps.crypto.privateKeyToWif(authKey, this.deps.network, true)
      const encryptionKeyWif = this.deps.crypto.privateKeyToWif(encryptionKey, this.deps.network, true)

      await this.deps.secretStore.storeLoginKey(identityId, loginKey)
      this.logger.info(`platform-auth: login-key login using keyIndex=${keyIndex}`)

      const result = await this.loginWithAuthKey(identityId, authKeyWif, {
        skipUsernameCheck: false,
      })

      await this.deps.secretStore.storeEncryptionKey(identityId, encryptionKeyWif)
      await this.deps.secretStore.storeEncryptionKeyType(identityId, 'derived')

      return result
    } catch (error) {
      await this.deps.secretStore.clearPrivateKey(identityId)
      await this.deps.secretStore.clearEncryptionKey(identityId)
      await this.deps.secretStore.clearEncryptionKeyType(identityId)
      await this.deps.secretStore.clearLoginKey(identityId)

      this.logger.error('platform-auth: login-key login failed', error)
      this.patchState({
        error: error instanceof Error ? error.message : 'Failed to login with key exchange',
      })
      throw error
    } finally {
      this.patchState({ isLoading: false })
    }
  }

  /** Signs out whoever is signed in once any session commit under way has finished, so none outlives it. */
  public logout(): Promise<PlatformAuthResult> {
    return this.exclusive(() => this.logoutNow())
  }

  /** Another tab already cleared shared storage. Do not erase a newer login or its keys. */
  public logoutLocally(since = this.epoch): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.epoch !== since || (!this.state.user && !this.state.isAuthRestoring)) return false
      await this.logoutNow(true)
      return true
    })
  }

  private async logoutNow(localOnly = false): Promise<PlatformAuthResult> {
    const identityId = this.state.user?.identityId ?? this.restoringIdentityId ?? undefined
    this.restoringIdentityId = null
    this.epoch += 1

    if (!localOnly) await this.deps.sessionStore.clearSession()
    if (identityId && localOnly) await this.deps.secretStore.clearTabSecrets?.(identityId)
    if (identityId && !localOnly) {
      await this.deps.secretStore.clearPrivateKey(identityId)
      await this.deps.secretStore.clearEncryptionKey(identityId)
      await this.deps.secretStore.clearEncryptionKeyType(identityId)
      await this.deps.secretStore.clearTransferKey(identityId)
      await this.deps.secretStore.clearLoginKey(identityId)
    }
    if (identityId) {
      if (localOnly) await this.deps.sideEffects?.runLocalLogoutCleanup?.(identityId)
      else await this.deps.sideEffects?.runLogoutCleanup?.(identityId)
    }

    await this.deps.clientIdentity?.setIdentity('')
    this.stopBalanceRefresh()
    this.patchState({
      user: null,
      isAuthRestoring: false,
      error: null,
    })

    await this.emit({ type: 'logout', identityId })
    return {
      user: null,
      intent: { kind: 'logged-out' },
    }
  }

  public async refreshUsername(): Promise<void> {
    const identityId = this.state.user?.identityId
    if (!identityId || !this.deps.usernames) {
      return
    }

    await this.deps.usernames.clearCache?.(undefined, identityId)
    await this.applyResolvedUsername(identityId)
  }

  public async setUsername(username: string): Promise<void> {
    if (!this.state.user) {
      return
    }

    await this.updateSessionUser((current) => ({
      ...current,
      username,
    }))
  }

  public async refreshBalance(): Promise<void> {
    const identityId = this.state.user?.identityId
    if (!identityId) {
      return
    }

    await this.deps.identity.clearCache?.(identityId)
    const balance = await this.deps.identity.getBalance(identityId)
    await this.updateSessionUser((current) => ({
      ...current,
      balance,
    }))
  }

  private async syncUsername(identityId: string): Promise<void> {
    try {
      await this.applyResolvedUsername(identityId)
    } catch (error) {
      await this.emit({ type: 'background-error', operation: 'sync-username', error })
    }
  }

  /**
   * A successful lookup replaces the stored username, or clears it when the identity has none.
   * A failed lookup rejects before touching the session, so the stored username is kept.
   */
  private async applyResolvedUsername(identityId: string): Promise<void> {
    const usernames = this.deps.usernames
    if (!usernames) return

    const stored = this.state.user?.username
    const username = (await usernames.resolveUsername(identityId)) ?? undefined
    // Skip if the session changed hands or setUsername() ran while the lookup was in flight.
    if (!this.isSessionActive(identityId) || this.state.user?.username !== stored) return
    if (username === stored) return

    await this.updateSessionUser((current) => ({
      ...current,
      username,
    }))
  }

  private tryAutoDeriveEncryptionKey(identityId: string, privateKey: string, publicKeys: AuthUser['publicKeys']): void {
    if (!this.features.autoDeriveEncryptionKey || !this.deps.crypto) {
      return
    }

    const crypto = this.deps.crypto

    void (async () => {
      try {
        const hasEncryptionKeyOnIdentity = crypto.identityHasEncryptionKey(publicKeys)
        const hasStoredEncryptionKey = await this.deps.secretStore.hasEncryptionKey(identityId)
        if (!hasEncryptionKeyOnIdentity || hasStoredEncryptionKey) {
          return
        }

        const parsed = crypto.parsePrivateKey(privateKey)
        const derivedKey = crypto.deriveEncryptionKey(parsed.privateKey, identityId)
        const matches = await crypto.validateDerivedKeyMatchesIdentity(derivedKey, identityId)
        if (!matches || !this.isSessionActive(identityId)) {
          return
        }

        const derivedKeyWif = crypto.privateKeyToWif(derivedKey, this.deps.network, true)
        await this.deps.secretStore.storeEncryptionKey(identityId, derivedKeyWif)
        await this.deps.secretStore.storeEncryptionKeyType(identityId, 'derived')
      } catch (error) {
        await this.emit({ type: 'background-error', operation: 'derive-encryption-key', error })
      }
    })()
  }

  private runPostLoginTasks(identityId: string, delayMs: number): void {
    if (!this.features.postLoginTasks || !this.deps.sideEffects) {
      return
    }

    void Promise.resolve(
      this.deps.sideEffects.runPostLogin(identityId, {
        delayMs,
        isSessionActive: () => this.isSessionActive(identityId),
      }),
    ).catch(async (error) => {
      await this.emit({ type: 'background-error', operation: 'post-login-tasks', error })
    })
  }

  private startBalanceRefresh(): void {
    if (!this.features.balanceRefresh || !this.state.user) {
      return
    }

    this.stopBalanceRefresh()
    this.balanceInterval = setInterval(() => {
      void this.refreshBalance().catch((error) => {
        this.logger.error('platform-auth: balance refresh failed', error)
      })
    }, this.balanceRefreshMs)
  }

  private stopBalanceRefresh(): void {
    if (!this.balanceInterval) {
      return
    }

    clearInterval(this.balanceInterval)
    this.balanceInterval = null
  }

  private requireYapprKeyExchange(overrides: Partial<YapprKeyExchangeConfig> = {}): {
    port: NonNullable<PlatformAuthDependencies['yapprKeyExchange']>
    config: YapprKeyExchangeConfig
  } {
    if (!this.features.keyExchangeLogin) {
      throw new Error('Yappr key exchange login is disabled')
    }
    if (!this.deps.yapprKeyExchange) {
      throw new Error('Yappr key exchange is not configured')
    }

    return {
      port: this.deps.yapprKeyExchange,
      config: this.getYapprKeyExchangeConfig(overrides),
    }
  }

  private isSessionActive(identityId: string): boolean {
    return this.state.user?.identityId === identityId
  }

  private async persistSessionUser(user: AuthUser): Promise<void> {
    const snapshot: AuthSessionSnapshot = {
      user,
      timestamp: this.now(),
    }
    await this.deps.sessionStore.setSession(snapshot)
    this.patchState({ user })
  }

  private async updateSessionUser(updater: (user: AuthUser) => AuthUser): Promise<void> {
    const current = this.state.user
    if (!current) return

    const updated = updater(current)
    await this.deps.sessionStore.setSession({
      user: updated,
      timestamp: this.now(),
    })
    this.patchState({ user: updated })
  }

  private patchState(patch: Partial<PlatformAuthState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private async emit(event: PlatformAuthEvent): Promise<void> {
    await this.deps.onEvent?.(event)
  }
}
