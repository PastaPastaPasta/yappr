/**
 * CDN Loader for @dashevo/evo-sdk
 *
 * This module loads the evo-sdk from a CDN instead of bundling it with the application.
 * This significantly reduces the initial bundle size and improves load times by leveraging
 * CDN caching.
 *
 * The SDK is loaded once and cached for subsequent use.
 */

// CDN URLs for the SDK
const EVO_SDK_VERSION = '3.0.0';
const CDN_BASE_URL = 'https://cdn.jsdelivr.net/npm';
const EVO_SDK_URL = `${CDN_BASE_URL}/@dashevo/evo-sdk@${EVO_SDK_VERSION}/dist/evo-sdk.module.js`;

// Type definitions for the SDK exports we use
// These match the actual exports from @dashevo/evo-sdk
export interface EvoSdkModule {
  EvoSDK: EvoSDKClass;
  IdentitySigner: IdentitySignerClass;
  PrivateKey: PrivateKeyClass;
  IdentityPublicKey: IdentityPublicKeyClass;
  Document: DocumentClass;
  wallet: WalletModule;
}

// EvoSDK class type
export interface EvoSDKClass {
  testnetTrusted(config?: { settings?: { timeoutMs?: number } }): EvoSDKInstance;
  mainnetTrusted(config?: { settings?: { timeoutMs?: number } }): EvoSDKInstance;
}

export interface EvoSDKInstance {
  connect(): Promise<void>;
  documents: {
    query(query: unknown): Promise<Map<unknown, unknown>>;
    get(contractId: string, docType: string, docId: string): Promise<unknown>;
    create(params: { document: unknown; identityKey: unknown; signer: unknown }): Promise<unknown>;
    replace(params: { document: unknown; identityKey: unknown; signer: unknown }): Promise<unknown>;
    delete(params: { document: unknown; identityKey: unknown; signer: unknown }): Promise<unknown>;
  };
  identities: {
    fetch(identityId: string): Promise<Identity | null>;
    balance(identityId: string): Promise<unknown>;
    update(params: unknown): Promise<unknown>;
    creditTransfer(params: unknown): Promise<unknown>;
  };
  contracts: {
    fetch(contractId: string): Promise<unknown>;
  };
  dpns: {
    usernames(params: { identityId: string; limit?: number }): Promise<string[]>;
    resolve(name: string): Promise<unknown>;
    resolveName(name: string): Promise<string | null>;
    register(params: unknown): Promise<unknown>;
    registerName(params: unknown): Promise<unknown>;
    isContestedUsername(label: string): Promise<boolean>;
    isNameAvailable(name: string): Promise<boolean>;
    isValidUsername(label: string): Promise<boolean>;
    convertToHomographSafe(input: string): Promise<string>;
  };
  wasm: {
    waitForStateTransitionResult(hash: string): Promise<unknown>;
  };
}

// Identity type returned by identities.fetch
export interface Identity {
  toJSON(): Record<string, unknown>;
  getPublicKeys(): WasmPublicKey[];
}

// WASM public key type
export interface WasmPublicKey {
  keyId: number;
  keyTypeNumber: number;
  purposeNumber: number;
  securityLevelNumber: number;
  securityLevel: number;
  purpose: string;
  keyType: string;
  data: string;
  disabledAt?: number;
}

// IdentitySigner class type
export interface IdentitySignerClass {
  new (): IdentitySignerInstance;
}

export interface IdentitySignerInstance {
  addKeyFromWif(wif: string): void;
  addKey(key: unknown): void;
}

// PrivateKey class type
export interface PrivateKeyClass {
  fromHex(hex: string, network: 'testnet' | 'mainnet'): unknown;
}

// IdentityPublicKey class type
export interface IdentityPublicKeyClass {
  fromJSON(data: unknown): unknown;
}

// Document class type
export interface DocumentClass {
  new (
    data: Record<string, unknown>,
    documentTypeName: string,
    revision: bigint,
    contractId: string,
    ownerId: string,
    documentId?: string
  ): DocumentInstance;
}

export interface DocumentInstance {
  id: unknown;
  toJSON(): Record<string, unknown>;
}

// Wallet module type
export interface WalletModule {
  keyPairFromWif(wif: string): Promise<{ publicKey: string; privateKey: string } | null>;
}

// Cached SDK module
let cachedModule: EvoSdkModule | null = null;
let loadPromise: Promise<EvoSdkModule> | null = null;

/**
 * Load the evo-sdk from CDN
 *
 * This function dynamically imports the SDK from jsdelivr CDN.
 * The module is cached after the first load.
 *
 * @returns Promise resolving to the SDK module exports
 */
export async function loadEvoSdk(): Promise<EvoSdkModule> {
  // Return cached module if available
  if (cachedModule) {
    return cachedModule;
  }

  // Return existing load promise if one is in progress
  if (loadPromise) {
    return loadPromise;
  }

  // Start loading
  loadPromise = (async () => {
    try {
      console.log('CDN Loader: Loading evo-sdk from CDN...');
      const startTime = performance.now();

      // Dynamic import from CDN
      // Note: This works because the SDK is published as an ES module
      const sdkModule = await import(/* webpackIgnore: true */ EVO_SDK_URL);

      const loadTime = Math.round(performance.now() - startTime);
      console.log(`CDN Loader: evo-sdk loaded from CDN in ${loadTime}ms`);

      // Cache the module
      cachedModule = sdkModule as EvoSdkModule;
      return cachedModule;
    } catch (error) {
      console.error('CDN Loader: Failed to load evo-sdk from CDN:', error);
      loadPromise = null; // Reset so we can retry
      throw error;
    }
  })();

  return loadPromise;
}

/**
 * Check if the SDK is already loaded
 */
export function isEvoSdkLoaded(): boolean {
  return cachedModule !== null;
}

/**
 * Get the cached SDK module (returns null if not loaded)
 */
export function getCachedEvoSdk(): EvoSdkModule | null {
  return cachedModule;
}

/**
 * Preload the SDK without waiting for it
 * Useful for starting the load early in the application lifecycle
 */
export function preloadEvoSdk(): void {
  if (!cachedModule && !loadPromise) {
    loadEvoSdk().catch(error => {
      console.error('CDN Loader: Preload failed:', error);
    });
  }
}

// Re-export the CDN URL for use in preload hints
export const EVO_SDK_CDN_URL = EVO_SDK_URL;
