import type {
  AuthSessionSnapshot,
  AuthUser,
  AuthVaultBundle,
  AuthVaultUnlockResult,
  EncryptionKeyType,
  PasskeyAccess,
  PlatformAuthDependencies,
  PlatformAuthEvent,
  PlatformAuthFeatures,
  PlatformAuthIntent,
  PlatformAuthResult,
  PlatformAuthState,
  VaultSource,
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
  passwordLogin: true,
  passkeyLogin: true,
  keyExchangeLogin: true,
  authVault: true,
  legacyPasswordLogin: true,
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

function sameBytes(left?: Uint8Array, right?: Uint8Array): boolean {
  if (!left || !right || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
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

  public constructor(private readonly deps: PlatformAuthDependencies) {
    this.features = { ...DEFAULT_FEATURES, ...deps.features }
    this.logger = deps.logger ?? noopLogger
    this.balanceRefreshMs = deps.balanceRefreshMs ?? DEFAULT_BALANCE_REFRESH_MS
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
    this.patchState({ isAuthRestoring: true, error: null })

    try {
      const snapshot = await this.deps.sessionStore.getSession()
      if (!snapshot) {
        this.patchState({ isAuthRestoring: false })
        return null
      }

      const identityId = snapshot.user.identityId
      const hasPrivateKey = await this.deps.secretStore.hasPrivateKey(identityId)
      if (!hasPrivateKey) {
        await this.deps.sessionStore.clearSession()
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

      if (!snapshot.user.username && this.deps.usernames) {
        void this.backfillUsername(identityId)
      }

      this.startBalanceRefresh()
      this.runPostLoginTasks(identityId, 3000)
      return snapshot.user
    } catch (error) {
      this.logger.error('platform-auth: failed to restore session', error)
      await this.deps.sessionStore.clearSession()
      this.patchState({
        user: null,
        error: error instanceof Error ? error.message : 'Failed to restore session',
        isAuthRestoring: false,
      })
      return null
    }
  }

  public async loginWithAuthKey(
    identityId: string,
    privateKey: string,
    options: { skipUsernameCheck?: boolean } = {},
  ): Promise<PlatformAuthResult> {
    const skipUsernameCheck = options.skipUsernameCheck ?? false
    this.patchState({ isLoading: true, error: null })

    try {
      if (!identityId || !privateKey) {
        throw new Error('Identity ID and private key are required')
      }

      const identity = await this.deps.identity.getIdentity(identityId)
      if (!identity) {
        throw new Error('Identity not found')
      }

      const username = this.deps.usernames ? await this.deps.usernames.resolveUsername(identity.id) : null
      const user: AuthUser = {
        identityId: identity.id,
        balance: identity.balance,
        username: username ?? undefined,
        publicKeys: identity.publicKeys,
      }

      await this.persistSessionUser(user)
      await this.deps.secretStore.storePrivateKey(identity.id, privateKey)
      await this.deps.clientIdentity?.setIdentity(identity.id)

      this.patchState({
        user,
        error: null,
      })

      await this.emit({ type: 'login-succeeded', user })
      this.startBalanceRefresh()
      this.tryAutoDeriveEncryptionKey(identity.id, privateKey, user.publicKeys)

      if (this.features.usernameGate && !skipUsernameCheck && !user.username) {
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
      this.logger.error('platform-auth: auth-key login failed', error)
      this.patchState({
        error: error instanceof Error ? error.message : 'Failed to login',
      })
      throw error
    } finally {
      this.patchState({ isLoading: false })
    }
  }

  public async loginWithPassword(identityOrUsername: string, password: string): Promise<PlatformAuthResult> {
    if (!this.features.passwordLogin) {
      throw new Error('Password login is disabled')
    }

    this.patchState({ isLoading: true, error: null })

    try {
      let fallbackResult: { identityId: string; privateKey: string } | null = null
      let sawInvalidPassword = false
      let lastNonPasswordError: Error | null = null

      if (this.features.authVault && this.deps.vault?.isConfigured()) {
        try {
          const unlocked = await this.deps.vault.unlockWithPassword(identityOrUsername, password)
          return await this.restoreUnlockedVaultSession(unlocked)
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          if (message === 'Invalid password') {
            sawInvalidPassword = true
          } else if (error instanceof Error) {
            lastNonPasswordError = error
          }
        }
      }

      if (this.features.legacyPasswordLogin && this.deps.legacyPasswordLogins) {
        for (const adapter of this.deps.legacyPasswordLogins) {
          if (!adapter.isConfigured()) continue

          try {
            fallbackResult = await adapter.loginWithPassword(identityOrUsername, password)
            break
          } catch (error) {
            const message = error instanceof Error ? error.message : ''
            if (message === 'Invalid password') {
              sawInvalidPassword = true
            } else if (error instanceof Error) {
              lastNonPasswordError = error
            }
          }
        }
      }

      if (!fallbackResult) {
        if (sawInvalidPassword) {
          throw new Error('Invalid password')
        }
        throw lastNonPasswordError ?? new Error('Password login is not configured')
      }

      return await this.loginWithAuthKey(fallbackResult.identityId, fallbackResult.privateKey, {
        skipUsernameCheck: true,
      })
    } catch (error) {
      this.logger.error('platform-auth: password login failed', error)
      this.patchState({
        error: error instanceof Error ? error.message : 'Failed to login with password',
      })
      throw error
    } finally {
      this.patchState({ isLoading: false })
    }
  }

  public async loginWithPasskey(identityOrUsername?: string): Promise<PlatformAuthResult> {
    if (!this.features.passkeyLogin) {
      throw new Error('Passkey login is disabled')
    }
    if (!this.deps.vault?.isConfigured() || !this.deps.passkeys) {
      throw new Error('Passkey login is not configured')
    }

    this.patchState({ isLoading: true, error: null })

    try {
      const normalizedIdentity = identityOrUsername?.trim()
      const currentRpId = this.deps.passkeys.getDefaultRpId()
      let accesses: PasskeyAccess[] = []
      let selectedCredentialHash: Uint8Array | undefined

      if (normalizedIdentity) {
        const identityId = await this.deps.vault.resolveIdentityId(normalizedIdentity)
        if (!identityId) {
          throw new Error('Username not found')
        }

        accesses = (await this.deps.vault.getPasskeyAccesses(identityId)).filter((entry) => entry.rpId === currentRpId)
      } else {
        const selected = await this.deps.passkeys.selectDiscoverablePasskey(currentRpId)
        if (!selected.userHandle) {
          throw new Error('This passkey did not provide an account identifier. Try signing in with your username once, then use passkey login again.')
        }

        accesses = (await this.deps.vault.getPasskeyAccesses(selected.userHandle)).filter((entry) => entry.rpId === currentRpId)
        selectedCredentialHash = selected.credentialIdHash
      }

      if (accesses.length === 0) {
        if (normalizedIdentity) {
          throw new Error('No passkey login is configured for this site and account')
        }
        throw new Error('No passkey login is configured for this selected passkey on this site yet')
      }

      if (selectedCredentialHash) {
        accesses = accesses.filter((entry) => sameBytes(entry.credentialIdHash, selectedCredentialHash))
        if (accesses.length === 0) {
          throw new Error('This selected passkey is not registered for this site')
        }
      }

      const descriptors = accesses.flatMap((entry) => {
        if (!entry.credentialId || !entry.prfInput || !entry.rpId) return []
        return [{
          credentialId: entry.credentialId,
          prfInput: entry.prfInput,
          rpId: entry.rpId,
        }]
      })

      const assertion = await this.deps.passkeys.getPrfAssertionForCredentials(descriptors)
      const expectedCredentialHash = selectedCredentialHash ?? assertion.credentialIdHash
      const access = accesses.find((entry) => sameBytes(entry.credentialIdHash, expectedCredentialHash))
      if (!access) {
        throw new Error('Selected passkey is not registered for this site')
      }

      const unlocked = await this.deps.vault.unlockWithPrf(access.$ownerId, access, assertion.prfOutput)
      return await this.restoreUnlockedVaultSession(unlocked)
    } catch (error) {
      this.logger.error('platform-auth: passkey login failed', error)
      this.patchState({
        error: error instanceof Error ? error.message : 'Failed to login with passkey',
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

      await this.createOrUpdateVaultFromLoginKey(identityId, loginKey).catch((error) => {
        this.logger.warn('platform-auth: failed to create or update vault from login key', error)
      })

      await this.mergeSecretsIntoVault(identityId, {
        loginKey,
        encryptionKeyWif,
        source: 'wallet-derived',
      }).catch((error) => {
        this.logger.warn('platform-auth: failed to merge login-key secrets into vault', error)
      })

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

  public async createOrUpdateVaultFromLoginKey(identityId: string, loginKey: Uint8Array): Promise<AuthVaultUnlockResult> {
    return this.ensureVaultForCurrentSession(identityId, {
      loginKey,
      source: 'wallet-derived',
    })
  }

  public async createOrUpdateVaultFromAuthKey(identityId: string, authKeyWif: string): Promise<AuthVaultUnlockResult> {
    return this.ensureVaultForCurrentSession(identityId, {
      authKeyWif,
      source: 'direct-key',
    })
  }

  public async mergeSecretsIntoVault(
    identityId: string,
    partialSecrets: {
      loginKey?: Uint8Array
      authKeyWif?: string
      encryptionKeyWif?: string
      transferKeyWif?: string
      source?: VaultSource
    },
  ): Promise<AuthVaultUnlockResult | null> {
    if (!this.features.authVault || !this.deps.vault?.isConfigured()) {
      return null
    }

    const dek = await this.deps.secretStore.getAuthVaultDek(identityId)
    if (!dek) {
      return null
    }

    const merged = await this.deps.vault.mergeSecrets(identityId, dek, partialSecrets)
    if (!merged) {
      return null
    }

    await this.deps.secretStore.storeAuthVaultDek(identityId, merged.dek)
    if (partialSecrets.loginKey) {
      await this.deps.secretStore.storeLoginKey(identityId, partialSecrets.loginKey)
    }
    return merged
  }

  public async addPasswordAccess(password: string, iterations: number, label = 'Password'): Promise<void> {
    const user = this.requireUser('You must be logged in to add a password unlock method.')
    if (!this.deps.vault?.isConfigured()) {
      throw new Error('Auth vault is not configured')
    }

    const ensured = await this.ensureVaultForCurrentSession(user.identityId)
    await this.deps.vault.addPasswordAccess(user.identityId, {
      vaultId: ensured.vault.$id,
      dek: ensured.dek,
      password,
      iterations,
      label,
    })
  }

  public async addPasskeyAccess(label = 'Current device'): Promise<void> {
    const user = this.requireUser('You must be logged in to add a passkey.')
    if (!this.deps.vault?.isConfigured() || !this.deps.passkeys) {
      throw new Error('Passkeys are not configured')
    }

    const ensured = await this.ensureVaultForCurrentSession(user.identityId)
    const username = user.username ?? user.identityId
    const passkey = await this.deps.passkeys.createPasskeyWithPrf({
      identityId: user.identityId,
      username,
      displayName: username,
      label,
    })

    await this.deps.vault.addPasskeyAccess(user.identityId, {
      vaultId: ensured.vault.$id,
      dek: ensured.dek,
      passkey,
    })
  }

  public async logout(): Promise<PlatformAuthResult> {
    const identityId = this.state.user?.identityId

    await this.deps.sessionStore.clearSession()
    if (identityId) {
      await this.deps.secretStore.clearPrivateKey(identityId)
      await this.deps.secretStore.clearEncryptionKey(identityId)
      await this.deps.secretStore.clearEncryptionKeyType(identityId)
      await this.deps.secretStore.clearTransferKey(identityId)
      await this.deps.secretStore.clearLoginKey(identityId)
      await this.deps.secretStore.clearAuthVaultDek(identityId)
      await this.deps.sideEffects?.runLogoutCleanup?.(identityId)
    }

    await this.deps.clientIdentity?.setIdentity('')
    this.stopBalanceRefresh()
    this.patchState({
      user: null,
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
    const username = await this.deps.usernames.resolveUsername(identityId)
    if (!username || username === this.state.user?.username) {
      return
    }

    await this.updateSessionUser((current) => ({
      ...current,
      username,
    }))
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

  private async backfillUsername(identityId: string): Promise<void> {
    try {
      const username = await this.deps.usernames?.resolveUsername(identityId)
      if (!username) return
      if (!this.isSessionActive(identityId)) return

      await this.updateSessionUser((current) => ({
        ...current,
        username,
      }))
    } catch (error) {
      await this.emit({ type: 'background-error', operation: 'backfill-username', error })
    }
  }

  private async ensureVaultForCurrentSession(
    identityId: string,
    overrides: {
      loginKey?: Uint8Array
      authKeyWif?: string
      encryptionKeyWif?: string
      transferKeyWif?: string
      source?: VaultSource
    } = {},
  ): Promise<AuthVaultUnlockResult> {
    if (!this.features.authVault || !this.deps.vault?.isConfigured()) {
      throw new Error('Auth vault is not configured')
    }

    let activeDek = await this.deps.secretStore.getAuthVaultDek(identityId)

    if (!activeDek) {
      const status = await this.deps.vault.getStatus(identityId)

      if (status.hasVault && status.passkeyCount > 0) {
        if (!this.deps.passkeys) {
          throw new Error('Passkeys are required to unlock this auth vault on this device.')
        }

        const currentRpId = this.deps.passkeys.getDefaultRpId()
        const passkeyAccesses = (await this.deps.vault.getPasskeyAccesses(identityId)).filter((entry) =>
          entry.rpId === currentRpId &&
          entry.credentialId &&
          entry.credentialIdHash &&
          entry.prfInput,
        )

        if (passkeyAccesses.length === 0) {
          throw new Error('This auth vault has passkeys, but none are registered for this site. Use an existing unlock method for this site before updating it.')
        }

        const descriptors = passkeyAccesses.map((entry) => ({
          credentialId: entry.credentialId as Uint8Array,
          prfInput: entry.prfInput as Uint8Array,
          rpId: entry.rpId as string,
        }))

        const assertion = await this.deps.passkeys.getPrfAssertionForCredentials(descriptors)
        const matchingAccess = passkeyAccesses.find((entry) => sameBytes(entry.credentialIdHash, assertion.credentialIdHash))
        if (!matchingAccess) {
          throw new Error('The selected passkey is not registered for this account on this site.')
        }

        const unlocked = await this.deps.vault.unlockWithPrf(identityId, matchingAccess, assertion.prfOutput)
        await this.deps.secretStore.storeAuthVaultDek(identityId, unlocked.dek)
        activeDek = unlocked.dek
      } else if (status.hasVault && status.hasPasswordAccess) {
        throw new Error('This auth vault already has a password unlock method. Sign in once with that auth-vault password or an existing passkey on this device before adding another unlock method.')
      }
    }

    if (activeDek) {
      const merged = await this.deps.vault.mergeSecrets(identityId, activeDek, {
        loginKey: overrides.loginKey,
        authKeyWif: overrides.authKeyWif,
        encryptionKeyWif: overrides.encryptionKeyWif,
        transferKeyWif: overrides.transferKeyWif,
        source: overrides.source,
      })

      if (merged) {
        await this.deps.secretStore.storeAuthVaultDek(identityId, merged.dek)
        if (overrides.loginKey) {
          await this.deps.secretStore.storeLoginKey(identityId, overrides.loginKey)
        }
        return merged
      }
    }

    const hasExistingVault = await this.deps.vault.hasVault(identityId)
    if (hasExistingVault && !activeDek) {
      throw new Error('This auth vault already exists but is not unlocked on this device. Unlock it once with its current password or passkey, then try again.')
    }

    const loginKey = overrides.loginKey ?? (await this.deps.secretStore.getLoginKey(identityId)) ?? undefined
    const authKeyWif = overrides.authKeyWif ?? (await this.deps.secretStore.getPrivateKey(identityId)) ?? undefined
    const encryptionKeyWif = overrides.encryptionKeyWif ?? (await this.deps.secretStore.getEncryptionKey(identityId)) ?? undefined
    const transferKeyWif = overrides.transferKeyWif ?? (await this.deps.secretStore.getTransferKey(identityId)) ?? undefined

    if (!loginKey && !authKeyWif) {
      throw new Error('No active login secret is available for auth vault enrollment.')
    }

    const bundle: AuthVaultBundle = {
      version: 1,
      identityId,
      network: this.deps.network,
      secretKind: loginKey ? 'login-key' : 'auth-key',
      loginKey,
      authKeyWif,
      encryptionKeyWif,
      transferKeyWif,
      source: overrides.source ?? (loginKey ? 'wallet-derived' : 'direct-key'),
      updatedAt: this.now(),
    }

    const created = await this.deps.vault.createOrUpdateVaultBundle(identityId, bundle, activeDek ?? undefined)
    await this.deps.secretStore.storeAuthVaultDek(identityId, created.dek)
    if (loginKey) {
      await this.deps.secretStore.storeLoginKey(identityId, loginKey)
    }
    return created
  }

  private async restoreUnlockedVaultSession(unlocked: AuthVaultUnlockResult): Promise<PlatformAuthResult> {
    await this.deps.secretStore.storeAuthVaultDek(unlocked.identityId, unlocked.dek)

    let authKeyWif = unlocked.bundle.authKeyWif
    let encryptionKeyWif = unlocked.bundle.encryptionKeyWif
    let encryptionKeyType: EncryptionKeyType = 'external'

    if (unlocked.bundle.secretKind === 'login-key') {
      if (!this.deps.crypto || !unlocked.bundle.loginKey) {
        throw new Error('Auth vault is missing the wallet login secret.')
      }

      const identityIdBytes = this.deps.crypto.decodeIdentityId(unlocked.identityId)
      const authKey = this.deps.crypto.deriveAuthKeyFromLogin(unlocked.bundle.loginKey, identityIdBytes)
      const derivedEncryptionKey = this.deps.crypto.deriveEncryptionKeyFromLogin(unlocked.bundle.loginKey, identityIdBytes)
      authKeyWif = this.deps.crypto.privateKeyToWif(authKey, this.deps.network, true)
      const derivedEncryptionKeyWif = this.deps.crypto.privateKeyToWif(derivedEncryptionKey, this.deps.network, true)
      encryptionKeyWif = unlocked.bundle.encryptionKeyWif ?? derivedEncryptionKeyWif
      encryptionKeyType = !unlocked.bundle.encryptionKeyWif || unlocked.bundle.encryptionKeyWif === derivedEncryptionKeyWif
        ? 'derived'
        : 'external'

      await this.deps.secretStore.storeLoginKey(unlocked.identityId, unlocked.bundle.loginKey)
    } else if (authKeyWif && encryptionKeyWif && this.deps.crypto) {
      try {
        const parsed = this.deps.crypto.parsePrivateKey(authKeyWif)
        const derived = this.deps.crypto.deriveEncryptionKey(parsed.privateKey, unlocked.identityId)
        const derivedWif = this.deps.crypto.privateKeyToWif(derived, this.deps.network, true)
        encryptionKeyType = derivedWif === encryptionKeyWif ? 'derived' : 'external'
      } catch {
        encryptionKeyType = 'external'
      }
    }

    if (!authKeyWif) {
      throw new Error('Auth vault is missing the authentication key.')
    }

    const result = await this.loginWithAuthKey(unlocked.identityId, authKeyWif, {
      skipUsernameCheck: true,
    })

    if (encryptionKeyWif) {
      await this.deps.secretStore.storeEncryptionKey(unlocked.identityId, encryptionKeyWif)
      await this.deps.secretStore.storeEncryptionKeyType(unlocked.identityId, encryptionKeyType)
    }

    if (unlocked.bundle.transferKeyWif) {
      await this.deps.secretStore.storeTransferKey(unlocked.identityId, unlocked.bundle.transferKeyWif)
    }

    return result
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

        const dek = await this.deps.secretStore.getAuthVaultDek(identityId)
        if (dek && this.deps.vault?.isConfigured()) {
          await this.deps.vault.mergeSecrets(identityId, dek, {
            encryptionKeyWif: derivedKeyWif,
          })
        }
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

  private requireUser(message: string): AuthUser {
    if (!this.state.user) {
      throw new Error(message)
    }
    return this.state.user
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
