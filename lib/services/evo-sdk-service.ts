import { logger } from '@/lib/logger';
import { DataContract, EvoSDK, PlatformVersion } from '@dashevo/evo-sdk';
import { bundleKey, bundledContractsFor, staleContractIds } from '@/lib/contracts/bundled-contracts';
import { instrumentSdk } from '@/lib/query-inspector/capture';
import { YAPPR_DM_CONTRACT_ID, YAPPR_DM_V5_CONTRACT_ID, dmIsV5, YAPPR_PROFILE_CONTRACT_ID, KEY_EXCHANGE_CONTRACT_ID, YAPPR_BLOG_CONTRACT_ID, YAPPR_STOREFRONT_CONTRACT_ID, YAPPR_VAULT_CONTRACT_ID, YAPPR_AUTH_VAULT_CONTRACT_ID, POLLR_CONTRACT_ID, TOKEN_HISTORY_CONTRACT_ID, DAPI_ADDRESSES, DEVNET_NAME, DEVNET_QUORUM_URL } from '../constants';
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
      logger.debug('EvoSdkService: Creating EvoSDK instance...');

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
        logger.debug(`EvoSdkService: Building devnet (${devnetName}) SDK with ${addresses.length} addresses...`);
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
        logger.debug('EvoSdkService: Building testnet SDK in trusted mode...');
        this.sdk = EvoSDK.testnetTrusted({
          settings: {
            timeoutMs: 8000,
          }
        });
      } else {
        logger.debug('EvoSdkService: Building mainnet SDK in trusted mode...');
        this.sdk = EvoSDK.mainnetTrusted({
          settings: {
            timeoutMs: 8000,
          }
        });
      }

      // Shadow the facade methods so the query inspector can observe every
      // DAPI call (pass-through no-op while the inspector is disabled).
      instrumentSdk(this.sdk);

      logger.debug('EvoSdkService: Connecting to network...');
      await this.sdk.connect();
      logger.debug('EvoSdkService: Connected successfully');

      // Resolve the configured contracts once, before _isInitialized flips, so a
      // missing or misconfigured contract is reported here rather than surfacing
      // as an opaque failure in whichever query happens to need it first. One
      // batched request, so this costs a single round trip.
      await this._preloadContracts();

      this._isInitialized = true;
      logger.debug('EvoSdkService: SDK initialized successfully');
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
      { id: YAPPR_PROFILE_CONTRACT_ID, name: 'Profile' },
    ];

    // Add optional contracts if configured
    if (YAPPR_DM_CONTRACT_ID && !YAPPR_DM_CONTRACT_ID.includes('PLACEHOLDER')) {
      contractsToFetch.push({ id: YAPPR_DM_CONTRACT_ID, name: 'DM' });
    }
    if (dmIsV5()) {
      contractsToFetch.push({ id: YAPPR_DM_V5_CONTRACT_ID, name: 'DM v5' });
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
    // System token-history contract — where proved YAPP tips are read from.
    if (TOKEN_HISTORY_CONTRACT_ID) {
      contractsToFetch.push({ id: TOKEN_HISTORY_CONTRACT_ID, name: 'TokenHistory' });
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

    // Contracts snapshotted at build time need no round trip: seed them and
    // fetch only the rest. The bundle is revalidated off the critical path.
    const seeded = await this._seedBundledContracts(sdk, contractsToFetch.map(({ id }) => id));
    const toFetch = contractsToFetch.filter(({ id }) => !seeded.has(id));
    if (toFetch.length === 0) {
      logger.debug(`EvoSdkService: all ${contractsToFetch.length} contracts seeded from the bundle`);
      this._revalidateBundledContracts(sdk, [...seeded]);
      return;
    }
    logger.debug(
      `EvoSdkService: Preloading ${toFetch.length} contracts in one request (${seeded.size} seeded from the bundle)...`
    );

    // A contract that does not resolve comes back as an absent map entry rather
    // than a rejection, so one bad optional contract ID cannot sink the batch.
    let contracts: Map<string, unknown>;
    try {
      contracts = await sdk.contracts.getMany(toFetch.map(({ id }) => id));
    } catch (error) {
      logger.warn('EvoSdkService: contract preload failed:', error);
      this._revalidateBundledContracts(sdk, [...seeded]);
      return;
    }

    const missing = toFetch.filter(({ id }) => !contracts.get(id));
    logger.debug(`EvoSdkService: ${toFetch.length - missing.length}/${toFetch.length} contracts resolved`);
    for (const { id, name } of missing) {
      logger.warn(`EvoSdkService: ${name} contract (${id}) not found on network`);
    }
    this._revalidateBundledContracts(sdk, [...seeded]);
  }

  /** The bundle for the configured network, when there is one. */
  private async _bundle() {
    if (!this.config) return undefined;
    try {
      return await bundledContractsFor(bundleKey(this.config.network, this.config.devnetName ?? DEVNET_NAME));
    } catch (error) {
      logger.warn('EvoSdkService: contract bundle did not load:', error);
      return undefined;
    }
  }

  /**
   * Seed the SDK with every bundled contract among `ids`. Returns the ids that
   * were seeded. A no-op when nothing is bundled for the network.
   */
  private async _seedBundledContracts(sdk: EvoSDK, ids: readonly string[]): Promise<Set<string>> {
    const seeded = new Set<string>();
    const bundle = await this._bundle();
    if (!bundle) return seeded;
    const platformVersion = PlatformVersion.latest();
    for (const id of ids) {
      const entry = bundle.contracts[id];
      if (!entry) continue;
      try {
        // Structural validation applies today's rules to a contract the chain
        // accepted under older ones (a deployed contract can fail a rule added
        // since), and the fetch path skips it too; the snapshot is trusted.
        const contract = DataContract.fromBase64(entry.bytes, false, platformVersion);
        if (await sdk.contracts.addKnown(contract)) seeded.add(id);
      } catch (error) {
        logger.warn(`EvoSdkService: bundled contract ${id} did not load, fetching it instead:`, error);
      }
    }
    return seeded;
  }

  /**
   * Ask the network, proved and off the critical path, whether the seeded
   * bundle versions are still current, and refetch the ones that are not.
   * Versions only, so the check gets cheaper as the versions proof does. A
   * stale seed is also caught without it: the SDK drops a cached contract on
   * the first document stamped with a newer `$contractVersion`.
   */
  private _revalidateBundledContracts(sdk: EvoSDK, ids: readonly string[]): void {
    if (ids.length === 0) return;
    void (async () => {
      try {
        const bundle = await this._bundle();
        if (!bundle) return;
        // Versions only: from protocol version 14 the proof covers the
        // contracts' version items, a few hundred bytes per contract.
        const latest = await sdk.contracts.getLatestVersions({ contractIds: [...ids] });
        const stale = staleContractIds(bundle.contracts, latest, ids);
        if (stale.length === 0) {
          logger.debug(`EvoSdkService: ${ids.length} bundled contract(s) are current`);
          return;
        }
        logger.info(`EvoSdkService: ${stale.length} bundled contract(s) are stale, refetching:`, stale);
        // The fetch replaces the seeded entries in the SDK's cache.
        await sdk.contracts.getMany(stale);
      } catch (error) {
        // Nodes below the query's protocol version answer UNIMPLEMENTED; the
        // seeded contracts stay in use and the SDK's own staleness guard applies.
        const message = error instanceof Error ? error.message : String(error);
        if (/not implemented|not supported/i.test(message)) {
          logger.debug('EvoSdkService: node does not serve the contract versions query; skipping revalidation');
        } else {
          logger.warn('EvoSdkService: bundled contract revalidation failed:', error);
        }
      }
    })();
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
      logger.debug('EvoSdkService: Detected connection-level error (address pool exhausted or stale quorum cache), attempting to reconnect...');
      try {
        const savedConfig = this.config;
        await this.cleanup();
        if (savedConfig) {
          // Wait a bit before reconnecting to avoid immediate rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
          await this.initialize(savedConfig);
          logger.debug('EvoSdkService: Reconnected successfully');
          return true;
        }
      } catch (reconnectError) {
        logger.error('EvoSdkService: Failed to reconnect:', reconnectError);
      }
    }
    return false;
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
