import { logger } from '@/lib/logger';
import { EvoSDK } from '@dashevo/evo-sdk';
import { instrumentSdk } from '@/lib/query-inspector/capture';
import { DPNS_CONTRACT_ID, YAPPR_DM_CONTRACT_ID, YAPPR_PROFILE_CONTRACT_ID, KEY_EXCHANGE_CONTRACT_ID, YAPPR_BLOG_CONTRACT_ID, YAPPR_STOREFRONT_CONTRACT_ID, YAPPR_VAULT_CONTRACT_ID, YAPPR_AUTH_VAULT_CONTRACT_ID, POLLR_CONTRACT_ID, DAPI_ADDRESSES, DEVNET_NAME, DEVNET_QUORUM_URL, getContractTopology } from '../constants';
import type { AppNetwork } from '../constants';

export interface EvoSdkConfig {
  network: AppNetwork;
  contractId: string;
  /** Devnet only; defaults to the NEXT_PUBLIC_* values in lib/constants. */
  devnetName?: string;
  addresses?: readonly string[];
  quorumUrl?: string;
}

/**
 * Whether two configs would build the same SDK. Compares every field, not just
 * network and contract: on devnet the address pool and quorum URL also decide
 * what the instance talks to, and a change in either has to force a rebuild.
 */
function sameConfig(a: EvoSdkConfig, b: EvoSdkConfig): boolean {
  return a.network === b.network &&
    a.contractId === b.contractId &&
    a.devnetName === b.devnetName &&
    a.quorumUrl === b.quorumUrl &&
    (a.addresses ?? []).join(',') === (b.addresses ?? []).join(',');
}

class EvoSdkService {
  private sdk: EvoSDK | null = null;
  private initPromise: Promise<void> | null = null;
  private config: EvoSdkConfig | null = null;
  private _isInitialized = false;
  private _isInitializing = false;

  /**
   * Initialize the SDK with configuration
   */
  async initialize(config: EvoSdkConfig): Promise<void> {
    const unchanged = this._isInitialized && this.config !== null &&
      sameConfig(this.config, config);

    // If already initialized with same config, return immediately
    if (unchanged) {
      return;
    }

    // If currently initializing, wait for it to complete
    if (this._isInitializing && this.initPromise) {
      await this.initPromise;
      return;
    }

    // If config changed, cleanup first
    if (this._isInitialized && this.config) {
      await this.cleanup();
    }

    this.config = config;
    this._isInitializing = true;

    this.initPromise = this._performInitialization();

    try {
      await this.initPromise;
    } finally {
      this._isInitializing = false;
    }
  }

  private async _performInitialization(): Promise<void> {
    if (!this.config) {
      throw new Error('SDK configuration is missing');
    }

    try {
      logger.info('EvoSdkService: Creating EvoSDK instance...');

      // Create SDK with trusted mode based on network
      if (this.config.network === 'devnet') {
        // Devnets have no public masternode discovery, so the address pool is
        // configured explicitly. The typed constructor is used rather than
        // EvoSDK.devnetTrusted() because that factory takes no `addresses`.
        //
        // Proof verification is not optional here: wasm-sdk 4.2.0-dev.2 panics on
        // `proofs: false` ("queries without proofs are not supported yet") and
        // rejects non-trusted proofs outright ("Non-trusted mode is not supported
        // in WASM"), so every devnet read needs a trusted context prefetched from
        // a quorum service. Configure it with NEXT_PUBLIC_QUORUM_URL.
        const devnetName = this.config.devnetName ?? DEVNET_NAME;
        const addresses = [...(this.config.addresses ?? DAPI_ADDRESSES)];
        const quorumUrl = this.config.quorumUrl ?? DEVNET_QUORUM_URL;
        if (addresses.length === 0) {
          throw new Error(
            'Devnet requires an explicit DAPI address pool — set NEXT_PUBLIC_DAPI_ADDRESSES'
          );
        }
        logger.info(`EvoSdkService: Building devnet (${devnetName}) SDK with ${addresses.length} addresses...`);
        this.sdk = new EvoSDK({
          network: 'devnet',
          devnetName,
          addresses,
          trusted: true,
          ...(quorumUrl ? { quorumUrl } : {}),
          settings: {
            timeoutMs: 8000,
          }
        });
      } else if (this.config.network === 'testnet') {
        logger.info('EvoSdkService: Building testnet SDK in trusted mode...');
        this.sdk = EvoSDK.testnetTrusted({
          settings: {
            timeoutMs: 8000,
          }
        });
      } else {
        logger.info('EvoSdkService: Building mainnet SDK in trusted mode...');
        this.sdk = EvoSDK.mainnetTrusted({
          settings: {
            timeoutMs: 8000,
          }
        });
      }

      // Shadow the facade methods so the query inspector can observe every
      // DAPI call (pass-through no-op while the inspector is disabled).
      instrumentSdk(this.sdk);

      logger.info('EvoSdkService: Connecting to network...');
      await this.sdk.connect();
      logger.info('EvoSdkService: Connected successfully');

      // PROTOCOL-VERSION RATCHET: rs-sdk starts devnet connections at PV12 and
      // only ratchets up from verified response metadata. The v4+ contracts use
      // PV14 ranked-index grammar (`rankedCountable` et al.), so the FIRST
      // proved query that touches one fails deserialization ("value wrong type
      // error: unexpected property name") — and a failed verification bans the
      // address without ever ratcheting. One proved warm-up query that does NOT
      // touch the social contract (DPNS is on every chain) ratchets the
      // connection to the chain's real protocol version before any social-
      // contract read can race it.
      await this._warmUpProtocolVersion();

      // Resolve the configured contracts once, before _isInitialized flips, so a
      // missing or misconfigured contract is reported here rather than surfacing
      // as an opaque failure in whichever query happens to need it first. One
      // batched request, so this costs a single round trip.
      await this._preloadContracts();

      this._isInitialized = true;
      logger.info('EvoSdkService: SDK initialized successfully');
    } catch (error) {
      logger.error('EvoSdkService: Failed to initialize SDK:', error);
      logger.error('EvoSdkService: Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      this.initPromise = null;
      this._isInitialized = false;
      throw error;
    }
  }

  /**
   * See the call site: ratchet the SDK's negotiated protocol version with a
   * proved query that cannot touch the social contract, so the parallel preload
   * below never races a PV14 contract fetch against a PV12 connection. Needed
   * on every topology whose contract uses the ranked-index grammar (v4 and
   * everything after it — only v2/v3 predate it); failures are non-fatal (the
   * preload's own fetches would then surface the real problem).
   */
  private async _warmUpProtocolVersion(): Promise<void> {
    const topology = getContractTopology();
    if (topology === 'v2' || topology === 'v3' || !this.sdk) return;
    try {
      await this.sdk.contracts.fetch(DPNS_CONTRACT_ID);
      logger.info('EvoSdkService: protocol-version warm-up query completed');
    } catch (error) {
      logger.warn('EvoSdkService: protocol-version warm-up query failed:', error);
    }
  }

  /**
   * Preload the app's contracts, so a missing or unreachable contract surfaces
   * once here instead of as a confusing failure inside the first query needing it.
   *
   * This is ONE batched `getDataContracts` round trip rather than a request per
   * contract. The app configures ten of them, and ten concurrent requests spread
   * over a five-node pool spend far longer in failover retries than one request
   * does — on a cold devnet load the individual-fetch burst stretched past two
   * seconds, all of it in front of the first feed query.
   *
   * This does NOT populate any contract cache, and never did: neither
   * `contracts.fetch()` nor `contracts.getMany()` registers anything with the
   * trusted context provider, and wasm-sdk exposes no API to seed it (only
   * `removeCachedContract`). rs-sdk fills that cache itself, lazily, while
   * verifying the first proof that needs each contract. Preload failures are
   * therefore non-fatal — they cost a log line, not a query.
   */
  private async _preloadContracts(): Promise<void> {
    const sdk = this.sdk;
    if (!this.config || !sdk) {
      return;
    }

    // Build list of contracts to fetch
    const contractsToFetch: Array<{ id: string; name: string }> = [
      { id: this.config.contractId, name: 'Yappr' },
      { id: DPNS_CONTRACT_ID, name: 'DPNS' },
      { id: YAPPR_PROFILE_CONTRACT_ID, name: 'Profile' },
    ];

    // Add optional contracts if configured
    if (YAPPR_DM_CONTRACT_ID && !YAPPR_DM_CONTRACT_ID.includes('PLACEHOLDER')) {
      contractsToFetch.push({ id: YAPPR_DM_CONTRACT_ID, name: 'DM' });
    }
    if (YAPPR_BLOG_CONTRACT_ID) {
      contractsToFetch.push({ id: YAPPR_BLOG_CONTRACT_ID, name: 'Blog' });
    }
    if (YAPPR_STOREFRONT_CONTRACT_ID) {
      contractsToFetch.push({ id: YAPPR_STOREFRONT_CONTRACT_ID, name: 'Storefront' });
    }
    if (POLLR_CONTRACT_ID) {
      contractsToFetch.push({ id: POLLR_CONTRACT_ID, name: 'Pollr' });
    }

    // Add Key Exchange contract if configured
    if (KEY_EXCHANGE_CONTRACT_ID && !KEY_EXCHANGE_CONTRACT_ID.includes('PLACEHOLDER')) {
      contractsToFetch.push({ id: KEY_EXCHANGE_CONTRACT_ID, name: 'KeyExchange' });
    }

    // Add Vault contract if configured
    if (YAPPR_VAULT_CONTRACT_ID && !YAPPR_VAULT_CONTRACT_ID.includes('PLACEHOLDER')) {
      contractsToFetch.push({ id: YAPPR_VAULT_CONTRACT_ID, name: 'Vault' });
    }
    if (YAPPR_AUTH_VAULT_CONTRACT_ID && !YAPPR_AUTH_VAULT_CONTRACT_ID.includes('PLACEHOLDER')) {
      contractsToFetch.push({ id: YAPPR_AUTH_VAULT_CONTRACT_ID, name: 'AuthVault' });
    }

    logger.info(`EvoSdkService: Preloading ${contractsToFetch.length} contracts in one request...`);

    // A contract that does not resolve comes back as an absent map entry rather
    // than a rejection, so one bad optional contract ID cannot sink the batch.
    let contracts: Map<string, unknown>;
    try {
      contracts = await sdk.contracts.getMany(contractsToFetch.map(({ id }) => id));
    } catch (error) {
      logger.warn('EvoSdkService: contract preload failed:', error);
      return;
    }

    const missing = contractsToFetch.filter(({ id }) => !contracts.get(id));
    logger.info(
      `EvoSdkService: ${contractsToFetch.length - missing.length}/${contractsToFetch.length} contracts resolved`
    );
    for (const { id, name } of missing) {
      logger.warn(`EvoSdkService: ${name} contract (${id}) not found on network`);
    }
  }

  /**
   * Get the SDK instance, initializing if necessary
   */
  async getSdk(): Promise<EvoSDK> {
    if (!this._isInitialized || !this.sdk) {
      if (!this.config) {
        throw new Error('SDK not configured. Call initialize() first.');
      }
      await this.initialize(this.config);
    }
    if (!this.sdk) {
      throw new Error('SDK initialization failed');
    }
    return this.sdk;
  }

  /**
   * Check if SDK is initialized and ready for use
   */
  isReady(): boolean {
    return this._isInitialized && this.sdk !== null;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    this.sdk = null;
    this._isInitialized = false;
    this._isInitializing = false;
    this.initPromise = null;
    this.config = null;
  }

  /**
   * Check if error is a "no available addresses" error that requires reconnection
   */
  isNoAvailableAddressesError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : null) ||
      ((error as { message?: string })?.message) ||
      String(error);
    return message.toLowerCase().includes('no available addresses') ||
           message.toLowerCase().includes('noavailableaddressesforretry');
  }

  /**
   * Check if error is a stale trusted-context error: devnet DKG rotations
   * outlive the static quorum prefetch, after which every proof fails with
   * "invalid quorum: Quorum not found in cache for hash: …" and addresses get
   * banned. There is no refresh API — the only recovery is a rebuild, which
   * re-prefetches the current quorums.
   */
  isStaleQuorumError(error: unknown): boolean {
    const message = ((error instanceof Error ? error.message : null) ||
      ((error as { message?: string })?.message) ||
      String(error)).toLowerCase();
    return message.includes('quorum not found in cache') ||
           message.includes('invalid quorum');
  }

  /**
   * Handle connection errors by reinitializing the SDK
   * Returns true if recovery was attempted
   */
  async handleConnectionError(error: unknown): Promise<boolean> {
    if (this.isNoAvailableAddressesError(error) || this.isStaleQuorumError(error)) {
      logger.info('EvoSdkService: Detected connection-level error (address pool exhausted or stale quorum cache), attempting to reconnect...');
      try {
        const savedConfig = this.config;
        await this.cleanup();
        if (savedConfig) {
          // Wait a bit before reconnecting to avoid immediate rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
          await this.initialize(savedConfig);
          logger.info('EvoSdkService: Reconnected successfully');
          return true;
        }
      } catch (reconnectError) {
        logger.error('EvoSdkService: Failed to reconnect:', reconnectError);
      }
    }
    return false;
  }

  /**
   * Get current configuration
   */
  getConfig(): EvoSdkConfig | null {
    return this.config;
  }

  /**
   * Reinitialize with new configuration
   */
  async reinitialize(config: EvoSdkConfig): Promise<void> {
    await this.cleanup();
    await this.initialize(config);
  }
}

// Singleton instance
export const evoSdkService = new EvoSdkService();

// Export helper to ensure SDK is initialized
export async function getEvoSdk(): Promise<EvoSDK> {
  return evoSdkService.getSdk();
}

// Re-export EvoSDK type for convenience
export type { EvoSDK };
