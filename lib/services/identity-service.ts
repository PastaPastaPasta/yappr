import { getEvoSdk } from './evo-sdk-service';
import { signerService } from './signer-service';
// WASM SDK imports with dynamic initialization
import initWasm, * as wasmSdk from '@dashevo/wasm-sdk/compressed';

let wasmInitialized = false;
async function ensureWasmInitialized() {
  if (!wasmInitialized) {
    await initWasm();
    wasmInitialized = true;
  }
  return wasmSdk;
}

export interface IdentityPublicKey {
  id: number;
  type: number;
  purpose: number;
  securityLevel: number;              // Now required (normalized in getIdentity)
  security_level?: number;            // SDK may return snake_case variant
  readOnly?: boolean;
  read_only?: boolean;                // SDK may return snake_case variant
  disabledAt?: number;
  disabled_at?: number;               // SDK may return snake_case variant
  contractBounds?: unknown;
  contract_bounds?: unknown;          // SDK may return snake_case variant
  data: string | Uint8Array;
}

export interface IdentityInfo {
  id: string;
  balance: number;
  publicKeys: IdentityPublicKey[];
  revision: number;
}

export interface IdentityBalance {
  confirmed: number;
  total: number;
}

class IdentityService {
  private identityCache: Map<string, { data: IdentityInfo; timestamp: number }> = new Map();
  private balanceCache: Map<string, { data: IdentityBalance; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute cache

  /**
   * Fetch identity information
   */
  async getIdentity(identityId: string): Promise<IdentityInfo | null> {
    try {
      // Check cache
      const cached = this.identityCache.get(identityId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.data;
      }

      const sdk = await getEvoSdk();

      // Fetch identity using EvoSDK facade
      console.log(`Fetching identity: ${identityId}`);
      const identityResponse = await sdk.identities.fetch(identityId);
      
      if (!identityResponse) {
        console.warn(`Identity not found: ${identityId}`);
        return null;
      }

      // identity_fetch returns an object with a toJSON method
      const identity = identityResponse.toJSON();
      
      console.log('Raw identity response:', JSON.stringify(identity, null, 2));
      console.log('Public keys from identity:', identity.publicKeys);

      // Normalize public keys to ensure all fields are present
      const rawPublicKeys = (identity.publicKeys || identity.public_keys || []) as IdentityPublicKey[];
      const normalizedPublicKeys: IdentityPublicKey[] = rawPublicKeys.map((key: IdentityPublicKey) => ({
        id: key.id,
        type: key.type,
        purpose: key.purpose,
        securityLevel: key.securityLevel ?? key.security_level ?? 2, // Default to HIGH (2) if missing
        readOnly: key.readOnly ?? key.read_only ?? false,
        disabledAt: key.disabledAt ?? key.disabled_at,
        contractBounds: key.contractBounds ?? key.contract_bounds,
        data: key.data
      }));

      const identityInfo: IdentityInfo = {
        id: (identity.id as string) || identityId,
        balance: (identity.balance as number) || 0,
        publicKeys: normalizedPublicKeys,
        revision: (identity.revision as number) || 0
      };

      // Cache the result
      this.identityCache.set(identityId, {
        data: identityInfo,
        timestamp: Date.now()
      });

      return identityInfo;
    } catch (error) {
      console.error('Error fetching identity:', error);
      throw error;
    }
  }

  /**
   * Get identity balance
   */
  async getBalance(identityId: string): Promise<IdentityBalance> {
    try {
      // Check cache
      const cached = this.balanceCache.get(identityId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.data;
      }

      const sdk = await getEvoSdk();

      // Fetch balance using EvoSDK facade (v3 SDK returns bigint | null)
      console.log(`Fetching balance for: ${identityId}`);
      const balanceResponse = await sdk.identities.balance(identityId);

      // Convert bigint to number, handle null
      const confirmedBalance = balanceResponse ? Number(balanceResponse) : 0;

      console.log(`Balance for ${identityId}: ${confirmedBalance} credits`);

      const balanceInfo: IdentityBalance = {
        confirmed: confirmedBalance,
        total: confirmedBalance
      };

      // Cache the result
      this.balanceCache.set(identityId, {
        data: balanceInfo,
        timestamp: Date.now()
      });

      return balanceInfo;
    } catch (error) {
      console.error('Error fetching balance:', error);
      // Return zero balance on error
      return { confirmed: 0, total: 0 };
    }
  }

  /**
   * Verify if identity exists
   */
  async verifyIdentity(identityId: string): Promise<boolean> {
    try {
      const identity = await this.getIdentity(identityId);
      return identity !== null;
    } catch (error) {
      console.error('Error verifying identity:', error);
      return false;
    }
  }

  /**
   * Get identity public keys
   */
  async getPublicKeys(identityId: string): Promise<IdentityPublicKey[]> {
    try {
      const identity = await this.getIdentity(identityId);
      return identity?.publicKeys || [];
    } catch (error) {
      console.error('Error fetching public keys:', error);
      return [];
    }
  }

  /**
   * Clear cache for an identity
   */
  clearCache(identityId?: string): void {
    if (identityId) {
      this.identityCache.delete(identityId);
      this.balanceCache.delete(identityId);
    } else {
      this.identityCache.clear();
      this.balanceCache.clear();
    }
  }

  /**
   * Clear expired cache entries
   */
  cleanupCache(): void {
    const now = Date.now();
    
    // Clean identity cache
    for (const [key, value] of Array.from(this.identityCache.entries())) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.identityCache.delete(key);
      }
    }
    
    // Clean balance cache
    for (const [key, value] of Array.from(this.balanceCache.entries())) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.balanceCache.delete(key);
      }
    }
  }

  /**
   * Check if identity has an active (non-disabled) encryption key (purpose=1, type=0)
   */
  async hasEncryptionKey(identityId: string): Promise<boolean> {
    try {
      const identity = await this.getIdentity(identityId);
      if (!identity) return false;
      return identity.publicKeys.some(
        key => key.purpose === 1 && key.type === 0 && !key.disabledAt
      );
    } catch (error) {
      console.error('Error checking encryption key:', error);
      return false;
    }
  }

  /**
   * Validate that a private key has sufficient security level for identity updates
   * Identity modifications REQUIRE a MASTER (0) security level key    * CRITICAL keys are NOT sufficient for identity updates.
   *
   * @param privateKeyWif - The WIF-encoded private key to validate
   * @param identityId - The identity to validate against
   * @returns Validation result with security level info
   */
  async validateKeySecurityLevel(
    privateKeyWif: string,
    identityId: string
  ): Promise<{
    isValid: boolean;
    securityLevel?: number;
    keyId?: number;
    error?: string;
  }> {
    try {
      const { findMatchingKeyIndex, getSecurityLevelName } = await import('@/lib/crypto/keys');
      const identity = await this.getIdentity(identityId);

      if (!identity) {
        return { isValid: false, error: 'Identity not found' };
      }

      // Convert identity public keys to the format expected by findMatchingKeyIndex
      const publicKeys = identity.publicKeys.map(key => ({
        id: key.id,
        type: key.type,
        purpose: key.purpose,
        securityLevel: key.securityLevel ?? key.security_level ?? 0,
        data: typeof key.data === 'string'
          ? Uint8Array.from(atob(key.data), c => c.charCodeAt(0))
          : key.data as Uint8Array
      }));

      const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet';
      const match = findMatchingKeyIndex(privateKeyWif, publicKeys, network);

      if (!match) {
        return { isValid: false, error: 'Private key does not match any key on this identity' };
      }

      // For identity updates in SDK 3.0.0, we REQUIRE MASTER (0) security level
      // The WASM SDK explicitly checks: key.security_level() == SecurityLevel::MASTER
      // CRITICAL (1) and below are NOT sufficient for identity updates
      if (match.securityLevel !== 0) {
        const levelName = getSecurityLevelName(match.securityLevel);
        return {
          isValid: false,
          securityLevel: match.securityLevel,
          keyId: match.keyId,
          error: `Identity modifications require a MASTER key. You provided a ${levelName} key.`
        };
      }

      return {
        isValid: true,
        securityLevel: match.securityLevel,
        keyId: match.keyId
      };
    } catch (error) {
      console.error('Error validating key security level:', error);
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Failed to validate key'
      };
    }
  }

  /**
   * Add an encryption public key to an identity
   * This creates an identity update state transition
   *
   * NOTE: Identity modifications on Dash Platform REQUIRE a MASTER (0) security level key
   * for signing in SDK 3.0.0. CRITICAL (1) and HIGH (2) keys are NOT sufficient.
   * This is enforced by the WASM SDK which verifies the signer has a private key
   * matching one of the identity's MASTER keys.
   *
   * @param identityId - The identity to update
   * @param encryptionPrivateKey - The private key bytes (32 bytes)
   * @param signingPrivateKeyWif - The MASTER level key for signing (in WIF format)
   * @param contractId - Optional contract ID to bind the key to
   * @returns Result with success status and the new key ID
   */
  async addEncryptionKey(
    identityId: string,
    encryptionPrivateKey: Uint8Array,
    signingPrivateKeyWif: string,
    _contractId?: string // Reserved for future use: contract-bound keys
  ): Promise<{ success: boolean; keyId?: number; error?: string }> {
    try {
      const sdk = await getEvoSdk();

      // Ensure WASM module is initialized
      const wasm = await ensureWasmInitialized();

      // Fetch current identity
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) {
        return { success: false, error: 'Identity not found' };
      }

      // Check if encryption key already exists
      const existingKey = identity.getPublicKeys().find(
        (key) => key.purpose === 'ENCRYPTION' && key.keyType === 'ECDSA_SECP256K1'
      );
      if (existingKey) {
        return { success: false, error: 'Identity already has an encryption key' };
      }

      // Get the next available key ID
      const currentKeys = identity.getPublicKeys();
      const maxKeyId = currentKeys.reduce((max, key) => Math.max(max, key.keyId), 0);
      const newKeyId = maxKeyId + 1;

      // Derive public key from private key
      const { privateFeedCryptoService } = await import('./index');
      const publicKeyBytes = privateFeedCryptoService.getPublicKey(encryptionPrivateKey);

      // Create IdentityPublicKeyInCreation using the constructor directly
      // The constructor takes: (id, purpose, securityLevel, keyType, readOnly, data, signature, contractBounds)
      // - purpose: can be number (1 = ENCRYPTION) or string ("ENCRYPTION")
      // - securityLevel: can be number (3 = MEDIUM) or string ("MEDIUM")
      // - keyType: can be number (0 = ECDSA_SECP256K1) or string ("ECDSA_SECP256K1")
      // - data: must be Uint8Array (not base64 string)
      // - signature: null for new keys
      // - contractBounds: null or ContractBounds object

      console.log(`Creating IdentityPublicKeyInCreation: id=${newKeyId}, purpose=ENCRYPTION, securityLevel=MEDIUM, keyType=ECDSA_SECP256K1`);
      console.log(`Public key bytes length: ${publicKeyBytes.length}`);

      const newKey = new wasm.IdentityPublicKeyInCreation(
        newKeyId,           // id
        'ENCRYPTION',       // purpose (string format works)
        'MEDIUM',           // securityLevel (string format works)
        'ECDSA_SECP256K1',  // keyType (string format works)
        false,              // readOnly
        publicKeyBytes,     // data as Uint8Array
        null,               // signature (null for new keys)
        null                // contractBounds (null = no contract binding)
      );
      console.log('IdentityPublicKeyInCreation created successfully');

      // Validate signing key has sufficient security level before calling SDK
      const validation = await this.validateKeySecurityLevel(signingPrivateKeyWif, identityId);
      if (!validation.isValid) {
        console.error('Signing key validation failed:', validation.error);
        return { success: false, error: validation.error };
      }
      console.log(`Signing key validated: keyId=${validation.keyId}, securityLevel=${validation.securityLevel}`);

      console.log(`Adding encryption key (id=${newKeyId}) to identity ${identityId}...`);

      // Log identity revision for debugging
      const identityJson = identity.toJSON();
      console.log('Identity revision before update:', identityJson.revision);

      // Create signer for the identity update using the master key
      const signer = await signerService.createSigner(signingPrivateKeyWif);

      // Update the identity using typed API
      console.log('Calling sdk.identities.update...');
      try {
        await sdk.identities.update({
          identity,
          addPublicKeys: [newKey],
          signer
        });
        console.log('sdk.identities.update completed successfully');
      } catch (updateError) {
        console.error('sdk.identities.update failed:', updateError);
        // Try to extract WasmSdkError properties (they are getters in WASM)
        if (updateError && typeof updateError === 'object') {
          const wasmErr = updateError as Record<string, unknown>;
          // WasmSdkError has getters: kind, name, message, code, retriable
          console.error('WasmSdkError properties:');
          try {
            console.error('  - kind:', wasmErr.kind);
            console.error('  - name:', wasmErr.name);
            console.error('  - message:', wasmErr.message);
            console.error('  - code:', wasmErr.code);
            console.error('  - retriable:', wasmErr.retriable);
          } catch (e) {
            console.error('  - Could not read properties:', e);
          }
          // List all own property names
          console.error('  - All properties:', Object.getOwnPropertyNames(wasmErr));
          // List all properties including inherited
          const allProps: string[] = [];
          let obj = wasmErr;
          while (obj && obj !== Object.prototype) {
            allProps.push(...Object.getOwnPropertyNames(obj));
            obj = Object.getPrototypeOf(obj);
          }
          console.error('  - All props (incl. prototype):', Array.from(new Set(allProps)));
        }
        throw updateError;
      }

      console.log('Encryption key added successfully');

      // Clear cache to reflect the update
      this.clearCache(identityId);

      return { success: true, keyId: newKeyId };
    } catch (error) {
      console.error('Error adding encryption key:', error);
      // Extract more detailed error info
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
        console.error('Error stack:', error.stack);
        console.error('Error name:', error.name);
        // Check for WASM error properties
        const wasmError = error as { code?: string; data?: unknown; kind?: string | number };
        if (wasmError.code) console.error('Error code:', wasmError.code);
        if (wasmError.data) console.error('Error data:', JSON.stringify(wasmError.data, null, 2));
        if (wasmError.kind !== undefined) console.error('Error kind:', wasmError.kind);
        // Log all enumerable properties
        console.error('Error properties:', Object.keys(error));
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Add a transfer key (purpose=3) to an identity.
   * Transfer keys are used for credit transfer operations (tips, etc.).
   *
   * IMPORTANT: This operation requires a MASTER security level (0) key
   * for signing in SDK 3.0.0. CRITICAL (1) and HIGH (2) keys are NOT sufficient.
   *
   * @param identityId - The identity to update
   * @param transferPrivateKey - The private key bytes (32 bytes)
   * @param signingPrivateKeyWif - The MASTER level key for signing (in WIF format)
   * @returns Result with success status and the new key ID
   */
  async addTransferKey(
    identityId: string,
    transferPrivateKey: Uint8Array,
    signingPrivateKeyWif: string
  ): Promise<{ success: boolean; keyId?: number; error?: string }> {
    try {
      const sdk = await getEvoSdk();

      // Ensure WASM module is initialized
      const wasm = await ensureWasmInitialized();

      // Fetch current identity
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) {
        return { success: false, error: 'Identity not found' };
      }

      // Check if transfer key already exists (purpose='TRANSFER')
      const existingKey = identity.getPublicKeys().find(
        (key) => key.purpose === 'TRANSFER' && key.keyType === 'ECDSA_SECP256K1'
      );
      if (existingKey) {
        return { success: false, error: 'Identity already has a transfer key' };
      }

      // Get the next available key ID
      const currentKeys = identity.getPublicKeys();
      const maxKeyId = currentKeys.reduce((max, key) => Math.max(max, key.keyId), 0);
      const newKeyId = maxKeyId + 1;

      // Derive public key from private key
      const { privateFeedCryptoService } = await import('./index');
      const publicKeyBytes = privateFeedCryptoService.getPublicKey(transferPrivateKey);

      // Create IdentityPublicKeyInCreation
      // Transfer keys use:
      // - purpose: 'TRANSFER' (3)
      // - securityLevel: 'HIGH' (2) - required for credit transfers
      // - keyType: 'ECDSA_SECP256K1' (0)
      console.log(`Creating IdentityPublicKeyInCreation: id=${newKeyId}, purpose=TRANSFER, securityLevel=HIGH, keyType=ECDSA_SECP256K1`);
      console.log(`Public key bytes length: ${publicKeyBytes.length}`);

      const newKey = new wasm.IdentityPublicKeyInCreation(
        newKeyId,           // id
        'TRANSFER',         // purpose (string format works)
        'HIGH',             // securityLevel (HIGH for transfer operations)
        'ECDSA_SECP256K1',  // keyType (string format works)
        false,              // readOnly
        publicKeyBytes,     // data as Uint8Array
        null,               // signature (null for new keys)
        null                // contractBounds (null = no contract binding)
      );
      console.log('IdentityPublicKeyInCreation created successfully');

      // Validate signing key has sufficient security level before calling SDK
      const validation = await this.validateKeySecurityLevel(signingPrivateKeyWif, identityId);
      if (!validation.isValid) {
        console.error('Signing key validation failed:', validation.error);
        return { success: false, error: validation.error };
      }
      console.log(`Signing key validated: keyId=${validation.keyId}, securityLevel=${validation.securityLevel}`);

      console.log(`Adding transfer key (id=${newKeyId}) to identity ${identityId}...`);

      // Log identity revision for debugging
      const identityJson = identity.toJSON();
      console.log('Identity revision before update:', identityJson.revision);

      // Create signer for the identity update using the master key
      const signer = await signerService.createSigner(signingPrivateKeyWif);

      // Update the identity using typed API
      console.log('Calling sdk.identities.update...');
      try {
        await sdk.identities.update({
          identity,
          addPublicKeys: [newKey],
          signer
        });
        console.log('sdk.identities.update completed successfully');
      } catch (updateError) {
        console.error('sdk.identities.update failed:', updateError);
        if (updateError && typeof updateError === 'object') {
          const wasmErr = updateError as Record<string, unknown>;
          console.error('WasmSdkError properties:');
          try {
            console.error('  - kind:', wasmErr.kind);
            console.error('  - name:', wasmErr.name);
            console.error('  - message:', wasmErr.message);
            console.error('  - code:', wasmErr.code);
            console.error('  - retriable:', wasmErr.retriable);
          } catch (e) {
            console.error('  - Could not read properties:', e);
          }
        }
        throw updateError;
      }

      console.log('Transfer key added successfully');

      // Clear cache to reflect the update
      this.clearCache(identityId);

      return { success: true, keyId: newKeyId };
    } catch (error) {
      console.error('Error adding transfer key:', error);
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
        console.error('Error stack:', error.stack);
        console.error('Error name:', error.name);
        const wasmError = error as { code?: string; data?: unknown; kind?: string | number };
        if (wasmError.code) console.error('Error code:', wasmError.code);
        if (wasmError.data) console.error('Error data:', JSON.stringify(wasmError.data, null, 2));
        if (wasmError.kind !== undefined) console.error('Error kind:', wasmError.kind);
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }
}

// Singleton instance
export const identityService = new IdentityService();

// Set up periodic cache cleanup
if (typeof window !== 'undefined') {
  setInterval(() => {
    identityService.cleanupCache();
  }, 60000); // Clean up every minute
}