import { getEvoSdk } from './evo-sdk-service';
import {
  IdentityPublicKeyInCreation,
} from '@dashevo/wasm-sdk';

export interface IdentityPublicKey {
  id: number;
  type: number;
  purpose: number;
  securityLevel: number;
  security_level?: number;  // SDK may return snake_case variant
  disabledAt?: number;
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
      
      const identityInfo: IdentityInfo = {
        id: identity.id || identityId,
        balance: identity.balance || 0,
        publicKeys: identity.publicKeys || identity.public_keys || [],
        revision: identity.revision || 0
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
   * Check if identity has an encryption key (purpose=1, type=0)
   */
  async hasEncryptionKey(identityId: string): Promise<boolean> {
    try {
      const identity = await this.getIdentity(identityId);
      if (!identity) return false;
      return identity.publicKeys.some(
        key => key.purpose === 1 && key.type === 0
      );
    } catch (error) {
      console.error('Error checking encryption key:', error);
      return false;
    }
  }

  /**
   * Add an encryption public key to an identity
   * This creates an identity update state transition
   *
   * @param identityId - The identity to update
   * @param encryptionPrivateKey - The private key bytes (32 bytes)
   * @param authPrivateKeyWif - The authentication key for signing (in WIF format)
   * @param contractId - Optional contract ID to bind the key to
   * @returns Result with success status and the new key ID
   */
  async addEncryptionKey(
    identityId: string,
    encryptionPrivateKey: Uint8Array,
    authPrivateKeyWif: string,
    contractId?: string
  ): Promise<{ success: boolean; keyId?: number; error?: string }> {
    try {
      const sdk = await getEvoSdk();

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

      // Create the new key object for IdentityPublicKeyInCreation.fromObject()
      const newKeyObj: Record<string, unknown> = {
        $version: 0,
        id: newKeyId,
        purpose: 1,          // ENCRYPTION
        securityLevel: 2,    // MEDIUM
        type: 0,             // ECDSA_SECP256K1
        readOnly: false,
        data: Array.from(publicKeyBytes),
      };

      // Add contract bounds if specified
      if (contractId) {
        newKeyObj.contractBounds = {
          type: 0,  // singleContract
          id: contractId
        };
      }

      // Create IdentityPublicKeyInCreation from object
      const newKey = IdentityPublicKeyInCreation.fromObject(newKeyObj);

      console.log(`Adding encryption key (id=${newKeyId}) to identity ${identityId}...`);

      // Update the identity
      await sdk.identities.update({
        identityId,
        addPublicKeys: [newKey],
        privateKeyWif: authPrivateKeyWif,
      });

      console.log('Encryption key added successfully');

      // Clear cache to reflect the update
      this.clearCache(identityId);

      return { success: true, keyId: newKeyId };
    } catch (error) {
      console.error('Error adding encryption key:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
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