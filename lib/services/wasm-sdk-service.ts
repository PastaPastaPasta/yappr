import { EvoSDK } from '@dashevo/evo-sdk';

export interface WasmSdkConfig {
  network: 'testnet' | 'mainnet';
  contractId: string;
}

class WasmSdkService {
  private sdk: EvoSDK | null = null;
  private initPromise: Promise<void> | null = null;
  private config: WasmSdkConfig | null = null;
  private _isInitialized = false;
  private _isInitializing = false;

  /**
   * Initialize the SDK with configuration
   */
  async initialize(config: WasmSdkConfig): Promise<void> {
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
    try {
      console.log('WasmSdkService: Creating EvoSDK instance...');

      // Create SDK with trusted mode based on network
      if (this.config!.network === 'testnet') {
        console.log('WasmSdkService: Building testnet SDK in trusted mode...');
        this.sdk = EvoSDK.testnetTrusted({
          settings: {
            timeoutMs: 8000,
          }
        });
      } else {
        console.log('WasmSdkService: Building mainnet SDK in trusted mode...');
        this.sdk = EvoSDK.mainnetTrusted({
          settings: {
            timeoutMs: 8000,
          }
        });
      }

      console.log('WasmSdkService: Connecting to network...');
      await this.sdk.connect();
      console.log('WasmSdkService: Connected successfully');

      this._isInitialized = true;
      console.log('WasmSdkService: SDK initialized successfully');

      // Preload the yappr contract into the trusted context
      await this._preloadYapprContract();
    } catch (error) {
      console.error('WasmSdkService: Failed to initialize SDK:', error);
      console.error('WasmSdkService: Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      this.initPromise = null;
      this._isInitialized = false;
      throw error;
    }
  }

  /**
   * Preload the yappr contract to cache it
   */
  private async _preloadYapprContract(): Promise<void> {
    if (!this.config || !this.sdk) {
      return;
    }

    try {
      console.log('WasmSdkService: Adding yappr contract to trusted context...');

      const contractId = this.config.contractId;

      try {
        await this.sdk.contracts.fetch(contractId);
        console.log('WasmSdkService: Yappr contract found on network and cached');
      } catch (error) {
        console.log('WasmSdkService: Contract not found on network (expected for local development)');
        console.log('WasmSdkService: Local contract operations will be handled gracefully');
      }

    } catch (error) {
      console.error('WasmSdkService: Error during contract setup:', error);
      // Don't throw - we can still operate
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
    return this.sdk!;
  }

  /**
   * Check if SDK is initialized
   */
  isReady(): boolean {
    return this._isInitialized && this.sdk !== null;
  }

  /**
   * Check if SDK is initialized
   */
  isInitialized(): boolean {
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
   * Get current configuration
   */
  getConfig(): WasmSdkConfig | null {
    return this.config;
  }

  /**
   * Reinitialize with new configuration
   */
  async reinitialize(config: WasmSdkConfig): Promise<void> {
    await this.cleanup();
    await this.initialize(config);
  }
}

// Singleton instance
export const wasmSdkService = new WasmSdkService();

// Export helper to ensure SDK is initialized
export async function getWasmSdk(): Promise<EvoSDK> {
  return wasmSdkService.getSdk();
}

// Re-export EvoSDK type for convenience
export type { EvoSDK };
