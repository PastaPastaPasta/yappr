import { logger } from '@/lib/logger';
import { EvoSDK } from '@dashevo/evo-sdk';
import { DPNS_CONTRACT_ID, YAPPR_DM_CONTRACT_ID, YAPPR_PROFILE_CONTRACT_ID, YAPPR_BLOG_CONTRACT_ID, YAPPR_STOREFRONT_CONTRACT_ID } from '../constants';

export interface EvoSdkConfig {
  network: 'testnet' | 'mainnet';
  contractId: string;
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
    // If already initialized with same config, return immediately
    if (this._isInitialized && this.config &&
        this.config.network === config.network &&
        this.config.contractId === config.contractId) {
      return;
    }

    // If currently initializing, wait for it to complete
    if (this._isInitializing && this.initPromise) {
      await this.initPromise;
      return;
    }

    // If config changed, cleanup first
    if (this._isInitialized && this.config &&
        (this.config.network !== config.network || this.config.contractId !== config.contractId)) {
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
      if (this.config.network === 'testnet') {
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

      logger.info('EvoSdkService: Connecting to network...');
      await this.sdk.connect();
      logger.info('EvoSdkService: Connected successfully');

      // Preload contracts to avoid repeated fetches.
      // Must happen BEFORE setting _isInitialized so that getSdk()
      // callers don't get an SDK instance without cached contracts.
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
   * Preload contracts to cache them and avoid repeated fetches
   * Fetches all contracts in parallel for faster initialization
   */
  private async _preloadContracts(): Promise<void> {
    if (!this.config || !this.sdk) {
      return;
    }

    logger.info('EvoSdkService: Preloading contracts in parallel...');

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

    // Fetch all contracts in parallel
    const results = await Promise.allSettled(
      contractsToFetch.map(async ({ id, name }) => {
        await this.sdk!.contracts.fetch(id);
        return name;
      })
    );

    // Log results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const contract = contractsToFetch[i];
      if (result.status === 'fulfilled') {
        logger.info(`EvoSdkService: ${contract.name} contract cached`);
      } else {
        logger.info(`EvoSdkService: ${contract.name} contract fetch failed:`, result.reason);
      }
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
   * Handle connection errors by reinitializing the SDK
   * Returns true if recovery was attempted
   */
  async handleConnectionError(error: unknown): Promise<boolean> {
    if (this.isNoAvailableAddressesError(error)) {
      logger.info('EvoSdkService: Detected "no available addresses" error, attempting to reconnect...');
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
