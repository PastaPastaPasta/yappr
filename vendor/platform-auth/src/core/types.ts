export type MaybePromise<T> = T | Promise<T>

export type NetworkName = 'testnet' | 'mainnet'

export type EncryptionKeyType = 'derived' | 'external'

export interface AuthPublicKey {
  id: number
  type: number
  purpose: number
  securityLevel: number
  security_level?: number
  disabledAt?: number
  data?: string | Uint8Array
}

export interface IdentityRecord {
  id: string
  balance: number
  publicKeys: AuthPublicKey[]
}

export interface AuthUser {
  identityId: string
  balance: number
  username?: string
  publicKeys: AuthPublicKey[]
}

export interface AuthSessionSnapshot {
  user: AuthUser
  timestamp: number
}

export interface PasskeyCredentialDescriptor {
  credentialId: Uint8Array
  prfInput: Uint8Array
  rpId: string
}

export interface PasskeyPrfAssertionResult {
  credentialId: Uint8Array
  credentialIdHash: Uint8Array
  prfInput: Uint8Array
  prfOutput: Uint8Array
  rpId: string
}

export interface DiscoverablePasskeySelectionResult {
  credentialId: Uint8Array
  credentialIdHash: Uint8Array
  userHandle?: string
  rpId: string
}

export interface EnrollPasskeyOptions {
  identityId: string
  username: string
  displayName: string
  label: string
  rpId?: string
  rpName?: string
}

export interface SessionStore {
  getSession(): MaybePromise<AuthSessionSnapshot | null>
  setSession(snapshot: AuthSessionSnapshot): MaybePromise<void>
  clearSession(): MaybePromise<void>
}

export interface SecretStore {
  storePrivateKey(identityId: string, privateKey: string): MaybePromise<void>
  getPrivateKey(identityId: string): MaybePromise<string | null>
  hasPrivateKey(identityId: string): MaybePromise<boolean>
  clearPrivateKey(identityId: string): MaybePromise<void>

  storeEncryptionKey(identityId: string, encryptionKey: string): MaybePromise<void>
  getEncryptionKey(identityId: string): MaybePromise<string | null>
  hasEncryptionKey(identityId: string): MaybePromise<boolean>
  clearEncryptionKey(identityId: string): MaybePromise<void>

  storeEncryptionKeyType(identityId: string, type: EncryptionKeyType): MaybePromise<void>
  clearEncryptionKeyType(identityId: string): MaybePromise<void>

  storeTransferKey(identityId: string, transferKey: string): MaybePromise<void>
  getTransferKey(identityId: string): MaybePromise<string | null>
  clearTransferKey(identityId: string): MaybePromise<void>

  storeLoginKey(identityId: string, loginKey: Uint8Array): MaybePromise<void>
  getLoginKey(identityId: string): MaybePromise<Uint8Array | null>
  clearLoginKey(identityId: string): MaybePromise<void>
}

export interface IdentityPort {
  getIdentity(identityId: string): Promise<IdentityRecord | null>
  getBalance(identityId: string): Promise<number>
  clearCache?(identityId: string): MaybePromise<void>
}

export interface UsernamePort {
  /** Resolves null only when the identity provably has no name; rejects when the lookup fails. */
  resolveUsername(identityId: string): Promise<string | null>
  resolveIdentity(identityOrUsername: string): Promise<string | null>
  clearCache?(username?: string, identityId?: string): MaybePromise<void>
}

export interface ProfilePort {
  hasProfile(identityId: string, username?: string): Promise<boolean>
}

export interface ClientIdentityPort {
  setIdentity(identityId: string): MaybePromise<void>
}

export interface SideEffectsPort {
  runPostLogin(identityId: string, context: { delayMs: number; isSessionActive: () => boolean }): MaybePromise<void>
  runLogoutCleanup?(identityId: string): MaybePromise<void>
}

export interface PlatformAuthCryptoPort {
  parsePrivateKey(privateKeyWif: string): { privateKey: Uint8Array }
  privateKeyToWif(privateKey: Uint8Array, network: NetworkName, compressed: boolean): string
  deriveEncryptionKey(authPrivateKey: Uint8Array, identityId: string): Uint8Array
  validateDerivedKeyMatchesIdentity(derivedKey: Uint8Array, identityId: string): Promise<boolean>
  identityHasEncryptionKey(publicKeys: AuthPublicKey[]): boolean
  decodeIdentityId(identityId: string): Uint8Array
  deriveAuthKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array
  deriveEncryptionKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array
}

export type YapprKeyExchangeNetworkName = NetworkName | 'devnet'

export interface YapprKeyExchangeConfig {
  appContractId: string
  keyExchangeContractId: string
  network: YapprKeyExchangeNetworkName
  label: string
  pollIntervalMs: number
  timeoutMs: number
}

export interface YapprKeyExchangeResponse {
  $id: string
  $ownerId: string
  $revision: number
  contractId: Uint8Array
  appEphemeralPubKeyHash: Uint8Array
  walletEphemeralPubKey: Uint8Array
  encryptedPayload: Uint8Array
  keyIndex: number
}

export interface YapprDecryptedKeyExchangeResult {
  loginKey: Uint8Array
  keyIndex: number
  walletEphemeralPubKey: Uint8Array
  identityId: string
}

export interface YapprKeyRegistrationRequest {
  identityId: string
  authPrivateKey: Uint8Array
  authPublicKey: Uint8Array
  encryptionPrivateKey: Uint8Array
  encryptionPublicKey: Uint8Array
}

/** A key a first-login registration adds to the identity. */
export interface YapprRegisteredKey {
  keyId: number
  purpose: 'authentication' | 'encryption'
  securityLevel: 'high' | 'medium'
}

export interface YapprUnsignedKeyRegistrationResult {
  transitionBytes: Uint8Array
  /** The keys the transition adds, in key id order. */
  keys: YapprRegisteredKey[]
  identityRevision: bigint
}

export interface YapprKeyExchangePort {
  getResponse(
    contractIdBytes: Uint8Array,
    appEphemeralPubKeyHash: Uint8Array,
  ): Promise<YapprKeyExchangeResponse | null>
  buildUnsignedKeyRegistrationTransition(
    request: YapprKeyRegistrationRequest,
  ): Promise<YapprUnsignedKeyRegistrationResult>
  checkKeysRegistered(
    identityId: string,
    authPublicKey: Uint8Array,
    encryptionPublicKey: Uint8Array,
  ): Promise<boolean>
}

export interface PlatformAuthFeatures {
  usernameGate: boolean
  profileGate: boolean
  keyExchangeLogin: boolean
  autoDeriveEncryptionKey: boolean
  postLoginTasks: boolean
  balanceRefresh: boolean
}

export interface PlatformAuthState {
  user: AuthUser | null
  isLoading: boolean
  isAuthRestoring: boolean
  error: string | null
}

export type PlatformAuthIntent =
  | { kind: 'ready'; identityId: string }
  | { kind: 'username-required'; identityId: string }
  | { kind: 'profile-required'; identityId: string; username?: string }
  | { kind: 'logged-out' }

export interface PlatformAuthResult {
  user: AuthUser | null
  intent: PlatformAuthIntent
}

export type PlatformAuthEvent =
  | { type: 'session-restored'; user: AuthUser }
  | { type: 'login-succeeded'; user: AuthUser }
  | { type: 'username-required'; identityId: string }
  | { type: 'profile-required'; identityId: string; username?: string }
  | { type: 'logout'; identityId?: string }
  | { type: 'background-error'; operation: string; error: unknown }

export interface PlatformAuthLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface PlatformAuthDependencies {
  network: NetworkName
  sessionStore: SessionStore
  secretStore: SecretStore
  identity: IdentityPort
  usernames?: UsernamePort
  profiles?: ProfilePort
  clientIdentity?: ClientIdentityPort
  sideEffects?: SideEffectsPort
  crypto?: PlatformAuthCryptoPort
  yapprKeyExchange?: YapprKeyExchangePort
  yapprKeyExchangeConfig?: Partial<YapprKeyExchangeConfig>
  features?: Partial<PlatformAuthFeatures>
  balanceRefreshMs?: number
  now?: () => number
  logger?: PlatformAuthLogger
  onEvent?: (event: PlatformAuthEvent) => MaybePromise<void>
}
