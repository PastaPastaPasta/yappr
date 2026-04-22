import React from 'react';

type MaybePromise<T> = T | Promise<T>;
type NetworkName = 'testnet' | 'mainnet';
type EncryptionKeyType = 'derived' | 'external';
type VaultSource = 'wallet-derived' | 'direct-key' | 'password-migrated' | 'mixed';
type VaultSecretKind = 'login-key' | 'auth-key';
interface AuthPublicKey {
    id: number;
    type: number;
    purpose: number;
    securityLevel: number;
    security_level?: number;
    disabledAt?: number;
    data?: string | Uint8Array;
}
interface IdentityRecord {
    id: string;
    balance: number;
    publicKeys: AuthPublicKey[];
}
interface AuthUser {
    identityId: string;
    balance: number;
    username?: string;
    publicKeys: AuthPublicKey[];
}
interface AuthSessionSnapshot {
    user: AuthUser;
    timestamp: number;
}
interface AuthVaultBundle {
    version: number;
    identityId: string;
    network: NetworkName;
    secretKind: VaultSecretKind;
    loginKey?: Uint8Array;
    authKeyWif?: string;
    encryptionKeyWif?: string;
    transferKeyWif?: string;
    source: VaultSource;
    updatedAt: number;
}
interface AuthVaultDocumentRef {
    $id: string;
}
interface AuthVaultStatus {
    configured: boolean;
    hasVault: boolean;
    secretKind?: VaultSecretKind;
    hasPasswordAccess: boolean;
    passkeyCount: number;
    hasEncryptionKey: boolean;
    hasTransferKey: boolean;
    updatedAt?: number;
}
interface AuthVaultUnlockResult {
    identityId: string;
    vault: AuthVaultDocumentRef;
    bundle: AuthVaultBundle;
    dek: Uint8Array;
}
interface PasskeyAccess {
    $id: string;
    $ownerId: string;
    label: string;
    credentialId?: Uint8Array;
    credentialIdHash?: Uint8Array;
    prfInput?: Uint8Array;
    rpId?: string;
}
interface PasskeyCredentialDescriptor {
    credentialId: Uint8Array;
    prfInput: Uint8Array;
    rpId: string;
}
interface PasskeyPrfAssertionResult {
    credentialId: Uint8Array;
    credentialIdHash: Uint8Array;
    prfInput: Uint8Array;
    prfOutput: Uint8Array;
    rpId: string;
}
interface DiscoverablePasskeySelectionResult {
    credentialId: Uint8Array;
    credentialIdHash: Uint8Array;
    userHandle?: string;
    rpId: string;
}
interface EnrollPasskeyOptions {
    identityId: string;
    username: string;
    displayName: string;
    label: string;
    rpId?: string;
    rpName?: string;
}
interface SessionStore {
    getSession(): MaybePromise<AuthSessionSnapshot | null>;
    setSession(snapshot: AuthSessionSnapshot): MaybePromise<void>;
    clearSession(): MaybePromise<void>;
}
interface SecretStore {
    storePrivateKey(identityId: string, privateKey: string): MaybePromise<void>;
    getPrivateKey(identityId: string): MaybePromise<string | null>;
    hasPrivateKey(identityId: string): MaybePromise<boolean>;
    clearPrivateKey(identityId: string): MaybePromise<void>;
    storeEncryptionKey(identityId: string, encryptionKey: string): MaybePromise<void>;
    getEncryptionKey(identityId: string): MaybePromise<string | null>;
    hasEncryptionKey(identityId: string): MaybePromise<boolean>;
    clearEncryptionKey(identityId: string): MaybePromise<void>;
    storeEncryptionKeyType(identityId: string, type: EncryptionKeyType): MaybePromise<void>;
    clearEncryptionKeyType(identityId: string): MaybePromise<void>;
    storeTransferKey(identityId: string, transferKey: string): MaybePromise<void>;
    getTransferKey(identityId: string): MaybePromise<string | null>;
    clearTransferKey(identityId: string): MaybePromise<void>;
    storeLoginKey(identityId: string, loginKey: Uint8Array): MaybePromise<void>;
    getLoginKey(identityId: string): MaybePromise<Uint8Array | null>;
    clearLoginKey(identityId: string): MaybePromise<void>;
    storeAuthVaultDek(identityId: string, dek: Uint8Array): MaybePromise<void>;
    getAuthVaultDek(identityId: string): MaybePromise<Uint8Array | null>;
    clearAuthVaultDek(identityId: string): MaybePromise<void>;
}
interface IdentityPort {
    getIdentity(identityId: string): Promise<IdentityRecord | null>;
    getBalance(identityId: string): Promise<number>;
    clearCache?(identityId: string): MaybePromise<void>;
}
interface UsernamePort {
    resolveUsername(identityId: string): Promise<string | null>;
    resolveIdentity(identityOrUsername: string): Promise<string | null>;
    clearCache?(username?: string, identityId?: string): MaybePromise<void>;
}
interface ProfilePort {
    hasProfile(identityId: string, username?: string): Promise<boolean>;
}
interface ClientIdentityPort {
    setIdentity(identityId: string): MaybePromise<void>;
}
interface SideEffectsPort {
    runPostLogin(identityId: string, context: {
        delayMs: number;
        isSessionActive: () => boolean;
    }): MaybePromise<void>;
    runLogoutCleanup?(identityId: string): MaybePromise<void>;
}
interface LegacyPasswordLoginPort {
    kind: string;
    isConfigured(): boolean;
    loginWithPassword(identityOrUsername: string, password: string): Promise<{
        identityId: string;
        privateKey: string;
    }>;
}
interface PasskeyPort {
    getDefaultRpId(): string;
    createPasskeyWithPrf(options: EnrollPasskeyOptions): Promise<PasskeyPrfAssertionResult & {
        label: string;
    }>;
    getPrfAssertionForCredentials(credentials: PasskeyCredentialDescriptor[]): Promise<PasskeyPrfAssertionResult>;
    selectDiscoverablePasskey(rpId?: string): Promise<DiscoverablePasskeySelectionResult>;
}
interface PlatformAuthCryptoPort {
    parsePrivateKey(privateKeyWif: string): {
        privateKey: Uint8Array;
    };
    privateKeyToWif(privateKey: Uint8Array, network: NetworkName, compressed: boolean): string;
    deriveEncryptionKey(authPrivateKey: Uint8Array, identityId: string): Uint8Array;
    validateDerivedKeyMatchesIdentity(derivedKey: Uint8Array, identityId: string): Promise<boolean>;
    identityHasEncryptionKey(publicKeys: AuthPublicKey[]): boolean;
    decodeIdentityId(identityId: string): Uint8Array;
    deriveAuthKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array;
    deriveEncryptionKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array;
}
type YapprKeyExchangeNetworkName = NetworkName | 'devnet';
interface YapprKeyExchangeConfig {
    appContractId: string;
    keyExchangeContractId: string;
    network: YapprKeyExchangeNetworkName;
    label: string;
    pollIntervalMs: number;
    timeoutMs: number;
}
interface YapprKeyExchangeResponse {
    $id: string;
    $ownerId: string;
    $revision: number;
    contractId: Uint8Array;
    appEphemeralPubKeyHash: Uint8Array;
    walletEphemeralPubKey: Uint8Array;
    encryptedPayload: Uint8Array;
    keyIndex: number;
}
interface YapprDecryptedKeyExchangeResult {
    loginKey: Uint8Array;
    keyIndex: number;
    walletEphemeralPubKey: Uint8Array;
    identityId: string;
}
interface YapprKeyRegistrationRequest {
    identityId: string;
    authPrivateKey: Uint8Array;
    authPublicKey: Uint8Array;
    encryptionPrivateKey: Uint8Array;
    encryptionPublicKey: Uint8Array;
}
interface YapprUnsignedKeyRegistrationResult {
    transitionBytes: Uint8Array;
    authKeyId: number;
    encryptionKeyId: number;
    identityRevision: bigint;
}
interface YapprKeyExchangePort {
    getResponse(contractIdBytes: Uint8Array, appEphemeralPubKeyHash: Uint8Array): Promise<YapprKeyExchangeResponse | null>;
    buildUnsignedKeyRegistrationTransition(request: YapprKeyRegistrationRequest): Promise<YapprUnsignedKeyRegistrationResult>;
    checkKeysRegistered(identityId: string, authPublicKey: Uint8Array, encryptionPublicKey: Uint8Array): Promise<boolean>;
}
interface UnifiedVaultPort {
    isConfigured(): boolean;
    getStatus(identityId: string): Promise<AuthVaultStatus>;
    hasVault(identityId: string): Promise<boolean>;
    resolveIdentityId(identityOrUsername: string): Promise<string | null>;
    createOrUpdateVaultBundle(identityId: string, bundle: AuthVaultBundle, dek?: Uint8Array): Promise<AuthVaultUnlockResult>;
    mergeSecrets(identityId: string, dek: Uint8Array, partialSecrets: {
        loginKey?: Uint8Array;
        authKeyWif?: string;
        encryptionKeyWif?: string;
        transferKeyWif?: string;
        source?: VaultSource;
    }): Promise<AuthVaultUnlockResult | null>;
    unlockWithPassword(identityOrUsername: string, password: string): Promise<AuthVaultUnlockResult>;
    unlockWithPrf(identityId: string, access: PasskeyAccess, prfOutput: Uint8Array): Promise<AuthVaultUnlockResult>;
    getPasskeyAccesses(identityId: string): Promise<PasskeyAccess[]>;
    addPasswordAccess(identityId: string, input: {
        vaultId: string;
        dek: Uint8Array;
        password: string;
        iterations: number;
        label: string;
    }): Promise<void>;
    addPasskeyAccess(identityId: string, input: {
        vaultId: string;
        dek: Uint8Array;
        passkey: PasskeyPrfAssertionResult & {
            label: string;
        };
    }): Promise<void>;
}
interface PlatformAuthFeatures {
    usernameGate: boolean;
    profileGate: boolean;
    passwordLogin: boolean;
    passkeyLogin: boolean;
    keyExchangeLogin: boolean;
    authVault: boolean;
    legacyPasswordLogin: boolean;
    autoDeriveEncryptionKey: boolean;
    postLoginTasks: boolean;
    balanceRefresh: boolean;
}
interface PlatformAuthState {
    user: AuthUser | null;
    isLoading: boolean;
    isAuthRestoring: boolean;
    error: string | null;
}
type PlatformAuthIntent = {
    kind: 'ready';
    identityId: string;
} | {
    kind: 'username-required';
    identityId: string;
} | {
    kind: 'profile-required';
    identityId: string;
    username?: string;
} | {
    kind: 'logged-out';
};
interface PlatformAuthResult {
    user: AuthUser | null;
    intent: PlatformAuthIntent;
}
type PlatformAuthEvent = {
    type: 'session-restored';
    user: AuthUser;
} | {
    type: 'login-succeeded';
    user: AuthUser;
} | {
    type: 'username-required';
    identityId: string;
} | {
    type: 'profile-required';
    identityId: string;
    username?: string;
} | {
    type: 'logout';
    identityId?: string;
} | {
    type: 'background-error';
    operation: string;
    error: unknown;
};
interface PlatformAuthLogger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
interface PlatformAuthDependencies {
    network: NetworkName;
    sessionStore: SessionStore;
    secretStore: SecretStore;
    identity: IdentityPort;
    usernames?: UsernamePort;
    profiles?: ProfilePort;
    clientIdentity?: ClientIdentityPort;
    sideEffects?: SideEffectsPort;
    crypto?: PlatformAuthCryptoPort;
    yapprKeyExchange?: YapprKeyExchangePort;
    yapprKeyExchangeConfig?: Partial<YapprKeyExchangeConfig>;
    vault?: UnifiedVaultPort;
    passkeys?: PasskeyPort;
    legacyPasswordLogins?: LegacyPasswordLoginPort[];
    features?: Partial<PlatformAuthFeatures>;
    balanceRefreshMs?: number;
    now?: () => number;
    logger?: PlatformAuthLogger;
    onEvent?: (event: PlatformAuthEvent) => MaybePromise<void>;
}

declare function getDefaultRpId(): string;
declare function createPasskeyWithPrf(options: EnrollPasskeyOptions): Promise<PasskeyPrfAssertionResult & {
    label: string;
}>;
declare function getPrfAssertionForCredentials(credentials: PasskeyCredentialDescriptor[]): Promise<PasskeyPrfAssertionResult>;
declare function selectDiscoverablePasskey(rpId?: string): Promise<DiscoverablePasskeySelectionResult>;
declare function getPasskeyAllowCredentialIds(credentials: PasskeyCredentialDescriptor[]): Uint8Array[];

type PasskeyPlatformHint = 'apple' | 'android' | 'windows' | 'desktop-other' | 'unknown';
interface PasskeyPrfSupport {
    webauthnAvailable: boolean;
    conditionalUiAvailable: boolean;
    likelyPrfCapable: boolean;
    platformHint: PasskeyPlatformHint;
    blockedReason?: string;
}
declare function getPasskeyPrfSupport(): Promise<PasskeyPrfSupport>;

interface BrowserSecretStoreCrypto {
    parsePrivateKey(privateKey: string): {
        privateKey: Uint8Array;
    };
    privateKeyToWif(privateKey: Uint8Array, network: NetworkName, compressed: boolean): string;
    isLikelyWif(value: string): boolean;
}
interface BrowserSecretStoreOptions {
    prefix?: string;
    network: NetworkName;
    crypto: BrowserSecretStoreCrypto;
}
type BrowserStoredKeyType = EncryptionKeyType;
declare class BrowserStorage {
    private readonly prefix;
    constructor(prefix: string);
    private getKeysWithPrefix;
    private getStorage;
    private getLegacyStorage;
    private isAvailable;
    set(key: string, value: unknown): void;
    get(key: string): unknown;
    has(key: string): boolean;
    delete(key: string): boolean;
    clear(): void;
    keys(): string[];
    size(): number;
}
declare function generatePrfInput(): Uint8Array;
declare function createBrowserSecretStore(options: BrowserSecretStoreOptions): {
    secureStorage: BrowserStorage;
    storePrivateKey: (identityId: string, privateKey: string) => void;
    getPrivateKey: (identityId: string) => string | null;
    clearPrivateKey: (identityId: string) => boolean;
    hasPrivateKey: (identityId: string) => boolean;
    clearAllPrivateKeys: () => void;
    storeLoginKey: (identityId: string, loginKey: Uint8Array) => void;
    getLoginKey: (identityId: string) => string | null;
    getLoginKeyBytes: (identityId: string) => Uint8Array | null;
    hasLoginKey: (identityId: string) => boolean;
    clearLoginKey: (identityId: string) => boolean;
    storeAuthVaultDek: (identityId: string, dek: Uint8Array) => void;
    getAuthVaultDek: (identityId: string) => string | null;
    getAuthVaultDekBytes: (identityId: string) => Uint8Array | null;
    hasAuthVaultDek: (identityId: string) => boolean;
    clearAuthVaultDek: (identityId: string) => boolean;
    storeEncryptionKey: (identityId: string, encryptionKey: string) => void;
    getEncryptionKey: (identityId: string) => string | null;
    getEncryptionKeyBytes: (identityId: string) => Uint8Array | null;
    hasEncryptionKey: (identityId: string) => boolean;
    clearEncryptionKey: (identityId: string) => boolean;
    storeEncryptionKeyType: (identityId: string, type: BrowserStoredKeyType) => void;
    getEncryptionKeyType: (identityId: string) => BrowserStoredKeyType | null;
    clearEncryptionKeyType: (identityId: string) => boolean;
    storeTransferKey: (identityId: string, transferKey: string) => void;
    getTransferKey: (identityId: string) => string | null;
    getTransferKeyBytes: (identityId: string) => Uint8Array | null;
    hasTransferKey: (identityId: string) => boolean;
    clearTransferKey: (identityId: string) => boolean;
};

declare class PlatformAuthController {
    private readonly deps;
    private readonly features;
    private readonly listeners;
    private readonly logger;
    private readonly balanceRefreshMs;
    private state;
    private balanceInterval;
    constructor(deps: PlatformAuthDependencies);
    getState(): PlatformAuthState;
    subscribe(listener: (state: PlatformAuthState) => void): () => void;
    dispose(): void;
    getYapprKeyExchangeConfig(overrides?: Partial<YapprKeyExchangeConfig>): YapprKeyExchangeConfig;
    pollYapprKeyExchangeResponse(appEphemeralPubKeyHash: Uint8Array, appEphemeralPrivateKey: Uint8Array, overrides?: Partial<YapprKeyExchangeConfig>, options?: {
        signal?: AbortSignal;
        onPoll?: () => void;
    }): Promise<YapprDecryptedKeyExchangeResult>;
    checkYapprKeysRegistered(identityId: string, authPublicKey: Uint8Array, encryptionPublicKey: Uint8Array, overrides?: Partial<YapprKeyExchangeConfig>): Promise<boolean>;
    buildYapprUnsignedKeyRegistrationTransition(request: YapprKeyRegistrationRequest, overrides?: Partial<YapprKeyExchangeConfig>): Promise<YapprUnsignedKeyRegistrationResult>;
    completeYapprKeyExchangeLogin(input: {
        identityId: string;
        loginKey: Uint8Array;
        keyIndex: number;
    }): Promise<PlatformAuthResult>;
    restoreSession(): Promise<AuthUser | null>;
    loginWithAuthKey(identityId: string, privateKey: string, options?: {
        skipUsernameCheck?: boolean;
    }): Promise<PlatformAuthResult>;
    loginWithPassword(identityOrUsername: string, password: string): Promise<PlatformAuthResult>;
    loginWithPasskey(identityOrUsername?: string): Promise<PlatformAuthResult>;
    loginWithLoginKey(identityId: string, loginKey: Uint8Array, keyIndex: number): Promise<PlatformAuthResult>;
    createOrUpdateVaultFromLoginKey(identityId: string, loginKey: Uint8Array): Promise<AuthVaultUnlockResult>;
    createOrUpdateVaultFromAuthKey(identityId: string, authKeyWif: string): Promise<AuthVaultUnlockResult>;
    mergeSecretsIntoVault(identityId: string, partialSecrets: {
        loginKey?: Uint8Array;
        authKeyWif?: string;
        encryptionKeyWif?: string;
        transferKeyWif?: string;
        source?: VaultSource;
    }): Promise<AuthVaultUnlockResult | null>;
    addPasswordAccess(password: string, iterations: number, label?: string): Promise<void>;
    addPasskeyAccess(label?: string): Promise<void>;
    logout(): Promise<PlatformAuthResult>;
    refreshUsername(): Promise<void>;
    setUsername(username: string): Promise<void>;
    refreshBalance(): Promise<void>;
    private backfillUsername;
    private ensureVaultForCurrentSession;
    private restoreUnlockedVaultSession;
    private tryAutoDeriveEncryptionKey;
    private runPostLoginTasks;
    private startBalanceRefresh;
    private stopBalanceRefresh;
    private requireYapprKeyExchange;
    private requireUser;
    private isSessionActive;
    private persistSessionUser;
    private updateSessionUser;
    private patchState;
    private now;
    private emit;
}

type YapprKeyExchangeState = 'idle' | 'generating' | 'waiting' | 'decrypting' | 'checking' | 'registering' | 'complete' | 'error' | 'timeout';
interface YapprKeyExchangeLoginResult {
    loginKey: Uint8Array;
    authKey: Uint8Array;
    encryptionKey: Uint8Array;
    keyIndex: number;
    needsKeyRegistration: boolean;
    identityId: string;
}
interface StartYapprKeyExchangeOptions {
    label?: string;
}
interface UseYapprKeyExchangeLoginReturn {
    state: YapprKeyExchangeState;
    uri: string | null;
    remainingTime: number | null;
    keyIndex: number;
    needsKeyRegistration: boolean;
    error: string | null;
    result: YapprKeyExchangeLoginResult | null;
    start: (options?: StartYapprKeyExchangeOptions) => void;
    cancel: () => void;
    retry: () => void;
}
type YapprKeyRegistrationState = 'idle' | 'building' | 'waiting' | 'verifying' | 'complete' | 'error';
interface YapprKeyRegistrationResult {
    authKeyId: number;
    encryptionKeyId: number;
}
interface UseYapprKeyRegistrationReturn {
    state: YapprKeyRegistrationState;
    uri: string | null;
    remainingTime: number | null;
    error: string | null;
    result: YapprKeyRegistrationResult | null;
    start: (identityId: string, authKey: Uint8Array, encryptionKey: Uint8Array) => void;
    cancel: () => void;
    retry: () => void;
}
interface UseYapprKeyExchangeOptions {
    config?: Partial<YapprKeyExchangeConfig>;
}
declare function useYapprKeyExchangeLogin(controller: PlatformAuthController, options?: UseYapprKeyExchangeOptions): UseYapprKeyExchangeLoginReturn;
declare function useYapprKeyRegistration(controller: PlatformAuthController, onComplete?: () => void, options?: UseYapprKeyExchangeOptions): UseYapprKeyRegistrationReturn;

declare const YAPPR_KEY_EXCHANGE_VERSION = 1;
declare const YAPPR_STATE_TRANSITION_VERSION = 1;
declare const YAPPR_NETWORK_IDS: {
    readonly mainnet: "m";
    readonly testnet: "t";
    readonly devnet: "d";
};
declare const DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG: Pick<YapprKeyExchangeConfig, 'label' | 'pollIntervalMs' | 'timeoutMs'>;
interface YapprKeyExchangeRequest {
    appEphemeralPubKey: Uint8Array;
    contractId: Uint8Array;
    label?: string;
}
interface YapprEphemeralKeyPair {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
}
interface PollForYapprKeyExchangeResponseOptions {
    pollIntervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onPoll?: () => void;
    logger?: PlatformAuthLogger;
}
declare function hash160(data: Uint8Array): Uint8Array;
declare function generateYapprEphemeralKeyPair(): YapprEphemeralKeyPair;
declare function deriveYapprSharedSecret(appEphemeralPrivateKey: Uint8Array, walletEphemeralPublicKey: Uint8Array): Uint8Array;
declare function decryptYapprLoginKey(encryptedPayload: Uint8Array, sharedSecret: Uint8Array): Promise<Uint8Array>;
declare function deriveYapprAuthKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array;
declare function deriveYapprEncryptionKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array;
declare function getYapprPublicKey(privateKey: Uint8Array): Uint8Array;
declare function clearSensitiveBytes(bytes: Uint8Array): void;
declare function decodeYapprIdentityId(identityIdBase58: string): Uint8Array;
declare function decodeYapprContractId(contractIdBase58: string): Uint8Array;
declare function serializeYapprKeyExchangeRequest(request: YapprKeyExchangeRequest): Uint8Array;
declare function buildYapprKeyExchangeUri(request: YapprKeyExchangeRequest, network?: YapprKeyExchangeNetworkName): string;
declare function parseYapprKeyExchangeUri(uri: string): {
    request: YapprKeyExchangeRequest;
    network: YapprKeyExchangeNetworkName;
    version: number;
} | null;
declare function buildYapprStateTransitionUri(transitionBytes: Uint8Array, network?: YapprKeyExchangeNetworkName): string;
declare function parseYapprStateTransitionUri(uri: string): {
    transitionBytes: Uint8Array;
    network: YapprKeyExchangeNetworkName;
    version: number;
} | null;
declare function pollForYapprKeyExchangeResponse(port: YapprKeyExchangePort, contractIdBytes: Uint8Array, appEphemeralPubKeyHash: Uint8Array, appEphemeralPrivateKey: Uint8Array, options?: PollForYapprKeyExchangeResponseOptions): Promise<YapprDecryptedKeyExchangeResult>;
declare function decryptYapprKeyExchangeResponse(response: YapprKeyExchangeResponse, appEphemeralPrivateKey: Uint8Array): Promise<YapprDecryptedKeyExchangeResult>;

interface PlatformAuthContextValue extends PlatformAuthState {
    controller: PlatformAuthController;
    restoreSession(): Promise<AuthUser | null>;
    loginWithAuthKey(identityId: string, privateKey: string, options?: {
        skipUsernameCheck?: boolean;
    }): Promise<PlatformAuthResult>;
    loginWithPassword(identityOrUsername: string, password: string): Promise<PlatformAuthResult>;
    loginWithPasskey(identityOrUsername?: string): Promise<PlatformAuthResult>;
    loginWithLoginKey(identityId: string, loginKey: Uint8Array, keyIndex: number): Promise<PlatformAuthResult>;
    createOrUpdateVaultFromLoginKey(identityId: string, loginKey: Uint8Array): Promise<AuthVaultUnlockResult>;
    createOrUpdateVaultFromAuthKey(identityId: string, authKeyWif: string): Promise<AuthVaultUnlockResult>;
    addPasswordAccess(password: string, iterations: number, label?: string): Promise<void>;
    addPasskeyAccess(label?: string): Promise<void>;
    logout(): Promise<PlatformAuthResult>;
    setUsername(username: string): Promise<void>;
    refreshUsername(): Promise<void>;
    refreshBalance(): Promise<void>;
}
declare function PlatformAuthProvider({ controller, children, }: {
    controller: PlatformAuthController;
    children: React.ReactNode;
}): JSX.Element;
declare function usePlatformAuth(): PlatformAuthContextValue;

export { type AuthPublicKey, type AuthSessionSnapshot, type AuthUser, type AuthVaultBundle, type AuthVaultDocumentRef, type AuthVaultStatus, type AuthVaultUnlockResult, type BrowserSecretStoreCrypto, type BrowserSecretStoreOptions, type BrowserStoredKeyType, type ClientIdentityPort, DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG, type DiscoverablePasskeySelectionResult, type EncryptionKeyType, type EnrollPasskeyOptions, type IdentityPort, type IdentityRecord, type LegacyPasswordLoginPort, type MaybePromise, type NetworkName, type PasskeyAccess, type PasskeyCredentialDescriptor, type PasskeyPlatformHint, type PasskeyPort, type PasskeyPrfAssertionResult, type PasskeyPrfSupport, type PlatformAuthContextValue, PlatformAuthController, type PlatformAuthCryptoPort, type PlatformAuthDependencies, type PlatformAuthEvent, type PlatformAuthFeatures, type PlatformAuthIntent, type PlatformAuthLogger, PlatformAuthProvider, type PlatformAuthResult, type PlatformAuthState, type PollForYapprKeyExchangeResponseOptions, type ProfilePort, type SecretStore, type SessionStore, type SideEffectsPort, type StartYapprKeyExchangeOptions, type UnifiedVaultPort, type UseYapprKeyExchangeLoginReturn, type UseYapprKeyRegistrationReturn, type UsernamePort, type VaultSecretKind, type VaultSource, YAPPR_KEY_EXCHANGE_VERSION, YAPPR_NETWORK_IDS, YAPPR_STATE_TRANSITION_VERSION, type YapprDecryptedKeyExchangeResult, type YapprEphemeralKeyPair, type YapprKeyExchangeConfig, type YapprKeyExchangeLoginResult, type YapprKeyExchangeNetworkName, type YapprKeyExchangePort, type YapprKeyExchangeRequest, type YapprKeyExchangeResponse, type YapprKeyExchangeState, type YapprKeyRegistrationRequest, type YapprKeyRegistrationResult, type YapprKeyRegistrationState, type YapprUnsignedKeyRegistrationResult, buildYapprKeyExchangeUri, buildYapprStateTransitionUri, clearSensitiveBytes, createBrowserSecretStore, createPasskeyWithPrf, decodeYapprContractId, decodeYapprIdentityId, decryptYapprKeyExchangeResponse, decryptYapprLoginKey, deriveYapprAuthKeyFromLogin, deriveYapprEncryptionKeyFromLogin, deriveYapprSharedSecret, generatePrfInput, generateYapprEphemeralKeyPair, getDefaultRpId, getPasskeyAllowCredentialIds, getPasskeyPrfSupport, getPrfAssertionForCredentials, getYapprPublicKey, hash160, parseYapprKeyExchangeUri, parseYapprStateTransitionUri, pollForYapprKeyExchangeResponse, selectDiscoverablePasskey, serializeYapprKeyExchangeRequest, usePlatformAuth, useYapprKeyExchangeLogin, useYapprKeyRegistration };
