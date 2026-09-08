import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { getEvoSdk } from './evo-sdk-service';
import { signerService } from './signer-service';
import { IdentityPublicKeyInCreation, PrivateKey } from '@dashevo/evo-sdk';
import { keyNetwork } from '@/lib/constants'
import { requireBytes } from '@/lib/bytes'
import { findMatchingKeyIndex, getPublicKey } from '@/lib/crypto/keys'
import { getSecurityLevelName, KeyPurpose, KeyType, SecurityLevel, resolveKeyPurpose, resolveKeyType } from '@/lib/crypto/identity-keys'

export interface IdentityPublicKey {
  id: number;
  type: number;
  purpose: number;
  securityLevel: number;              // Required (normalized in getIdentity)
  readOnly?: boolean;
  disabledAt?: number;
  contractBounds?: unknown;
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

type IdentityPublicKeyLike = {
  purpose?: unknown;
  purposeNumber?: unknown;
  keyType?: unknown;
  keyTypeNumber?: unknown;
  type?: unknown;
};

function isIdentityKeyForPurpose(key: IdentityPublicKeyLike, purpose: number): boolean {
  return (
    resolveKeyPurpose(key.purposeNumber ?? key.purpose) === purpose &&
    resolveKeyType(key.keyTypeNumber ?? key.keyType ?? key.type) === KeyType.ECDSA_SECP256K1
  );
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === 'bigint') {
          return `${current.toString()}n`;
        }

        if (typeof current === 'object' && current !== null) {
          if (seen.has(current)) {
            return '[Circular]';
          }
          seen.add(current);
        }

        return current;
      },
      2
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable value]';
    }
  }
}

class IdentityService {
  private static readonly CACHE_TTL_MS = 60_000;
  private identityCache = new TtlMap<string, IdentityInfo>(IdentityService.CACHE_TTL_MS);
  private balanceCache = new TtlMap<string, IdentityBalance>(IdentityService.CACHE_TTL_MS);

  /**
   * Fetch identity information
   */
  async getIdentity(identityId: string): Promise<IdentityInfo | null> {
    try {
      // Check cache
      const cached = this.identityCache.get(identityId);
      if (cached) return cached;

      const sdk = await getEvoSdk();

      // Fetch identity using EvoSDK facade
      logger.debug(`Fetching identity: ${identityId}`);
      const identityResponse = await sdk.identities.fetch(identityId);
      
      if (!identityResponse) {
        logger.warn(`Identity not found: ${identityId}`);
        return null;
      }

      // identity_fetch returns an object with a toJSON method
      const identity = identityResponse.toJSON();
      
      logger.debug('Raw identity response:', safeStringify(identity));
      logger.debug('Public keys from identity:', identity.publicKeys);

      // Normalize public keys so every field is present
      const rawPublicKeys = identity.publicKeys || [];
      const normalizedPublicKeys: IdentityPublicKey[] = rawPublicKeys.map((key: IdentityPublicKey) => ({
        id: key.id,
        type: key.type,
        purpose: key.purpose,
        securityLevel: key.securityLevel ?? 2, // Default to HIGH (2) if missing
        readOnly: key.readOnly ?? false,
        disabledAt: key.disabledAt,
        contractBounds: key.contractBounds,
        data: key.data
      }));

      const identityInfo: IdentityInfo = {
        id: identity.id || identityId,
        balance: Number(identity.balance ?? 0),
        publicKeys: normalizedPublicKeys,
        revision: Number(identity.revision ?? 0)
      };

      // Cache the result
      this.identityCache.set(identityId, identityInfo);

      return identityInfo;
    } catch (error) {
      logger.error('Error fetching identity:', error);
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
      if (cached) return cached;

      const sdk = await getEvoSdk();

      logger.debug(`Fetching balance for: ${identityId}`);
      const balanceResponse = await sdk.identities.balance(identityId);

      // Convert bigint to number, handle undefined.
      // Warn if the value exceeds Number.MAX_SAFE_INTEGER to avoid silent truncation.
      let confirmedBalance = 0;
      if (balanceResponse !== undefined && balanceResponse !== null) {
        if (balanceResponse > BigInt(Number.MAX_SAFE_INTEGER)) {
          logger.warn(`Balance ${balanceResponse} credits exceeds Number.MAX_SAFE_INTEGER; precision may be lost`);
        }
        confirmedBalance = Number(balanceResponse);
      }

      logger.debug(`Balance for ${identityId}: ${confirmedBalance} credits`);

      const balanceInfo: IdentityBalance = {
        confirmed: confirmedBalance,
        total: confirmedBalance
      };

      // Cache the result
      this.balanceCache.set(identityId, balanceInfo);

      return balanceInfo;
    } catch (error) {
      logger.error('Error fetching balance:', error);
      // Rethrow so callers can tell "balance unknown" from a real zero —
      // returning 0 here made transient DAPI failures block valid purchases
      // ("Not enough DASH credits") and report "You have 0 DASH" on tips.
      throw error;
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
    this.identityCache.prune();
    this.balanceCache.prune();
  }

  /**
   * Check if identity has an active (non-disabled) encryption key (purpose=1, type=0)
   */
  async hasEncryptionKey(identityId: string): Promise<boolean> {
    try {
      const { hasEncryptionKeyOnIdentity } = await import('@/lib/crypto/encryption-key-lookup');
      const identity = await this.getIdentity(identityId);
      if (!identity) return false;
      return hasEncryptionKeyOnIdentity(identity.publicKeys);
    } catch (error) {
      logger.error('Error checking encryption key:', error);
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
      const identity = await this.getIdentity(identityId);

      if (!identity) {
        return { isValid: false, error: 'Identity not found' };
      }

      // Match against every key first so a non-MASTER match can be named in
      // the error, then require MASTER: identity updates accept nothing less.
      const keyInfos = identity.publicKeys.map(key => ({
        id: key.id,
        type: key.type,
        purpose: key.purpose,
        securityLevel: key.securityLevel,
        data: requireBytes(key.data, 'identity key data')
      }));
      const match = findMatchingKeyIndex(privateKeyWif, keyInfos, keyNetwork());

      if (!match) {
        return { isValid: false, error: 'Private key does not match any key on this identity' };
      }

      if (match.securityLevel !== SecurityLevel.MASTER) {
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
      logger.error('Error validating key security level:', error);
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

      // Fetch current identity
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) {
        return { success: false, error: 'Identity not found' };
      }

      // Check if encryption key already exists
      const existingKey = identity.publicKeys.find(
        (key) => isIdentityKeyForPurpose(key, KeyPurpose.ENCRYPTION)
      );
      if (existingKey) {
        return { success: false, error: 'Identity already has an encryption key' };
      }

      // Get the next available key ID
      const currentKeys = identity.publicKeys;
      const maxKeyId = currentKeys.reduce((max, key) => Math.max(max, key.keyId), 0);
      const newKeyId = maxKeyId + 1;

      // Derive public key from private key
      const publicKeyBytes = getPublicKey(encryptionPrivateKey);

      // IMPORTANT: Use IdentityPublicKeyInCreation from @dashevo/evo-sdk (not @dashevo/wasm-sdk)
      // so the WASM object shares the same linear memory as sdk.identities.update().
      logger.debug(`Creating IdentityPublicKeyInCreation: id=${newKeyId}, purpose=ENCRYPTION, securityLevel=MEDIUM, keyType=ECDSA_SECP256K1`);
      logger.debug(`Public key bytes length: ${publicKeyBytes.length}`);

      // dev.8 narrowed PurposeLike/SecurityLevelLike/KeyTypeLike to require
      // lowercase string variants (or numeric enum values).
      const newKey = new IdentityPublicKeyInCreation({
        keyId: newKeyId,
        purpose: 'encryption',
        securityLevel: 'medium',
        keyType: 'ecdsa_secp256k1',
        isReadOnly: false,
        data: publicKeyBytes,
      });
      logger.debug('IdentityPublicKeyInCreation created successfully');

      // Validate signing key has sufficient security level before calling SDK
      const validation = await this.validateKeySecurityLevel(signingPrivateKeyWif, identityId);
      if (!validation.isValid) {
        logger.error('Signing key validation failed:', validation.error);
        return { success: false, error: validation.error };
      }
      logger.debug(`Signing key validated: keyId=${validation.keyId}, securityLevel=${validation.securityLevel}`);

      logger.debug(`Adding encryption key (id=${newKeyId}) to identity ${identityId}...`);

      // Log identity revision for debugging
      const identityJson = identity.toJSON();
      logger.debug('Identity revision before update:', identityJson.revision);

      // Create signer with the master key (for signing the update transition)
      const signer = await signerService.createSigner(signingPrivateKeyWif);

      // Also add the NEW encryption key's private key to the signer.
      // Dash Platform requires a "key proof" signature from each new key being added,
      // proving ownership of the private key. The SDK looks up the private key by
      // Hash160(compressed_public_key) in the signer, so it must contain both:
      // 1. The master key (to authorize the identity update)
      // 2. The new key (to generate the key proof)
      if (encryptionPrivateKey.length !== 32) {
        return { success: false, error: `Invalid encryption private key: expected 32 bytes, got ${encryptionPrivateKey.length}` };
      }
      const network = keyNetwork();
      const encryptionKeyHex = Array.from(encryptionPrivateKey).map(b => b.toString(16).padStart(2, '0')).join('');
      const encryptionPrivateKeyObj = PrivateKey.fromHex(encryptionKeyHex, network);
      signer.addKey(encryptionPrivateKeyObj);
      logger.debug(`Signer now has ${signer.keyCount} keys (master + new encryption key)`);

      // Update the identity using typed API
      logger.debug('Calling sdk.identities.update...');
      try {
        await sdk.identities.update({
          identity,
          addPublicKeys: [newKey],
          signer
        });
        logger.debug('sdk.identities.update completed successfully');
      } catch (updateError) {
        logger.error('sdk.identities.update failed:', updateError);
        if (updateError && typeof updateError === 'object') {
          const wasmErr = updateError as Record<string, unknown>;
          logger.error('WasmSdkError properties:');
          try {
            logger.error('  - kind:', wasmErr.kind);
            logger.error('  - name:', wasmErr.name);
            logger.error('  - message:', wasmErr.message);
            logger.error('  - code:', wasmErr.code);
            logger.error('  - retriable:', wasmErr.retriable);
          } catch (e) {
            logger.error('  - Could not read properties:', e);
          }
        }
        throw updateError;
      }

      logger.debug('Encryption key added successfully');

      // Clear cache to reflect the update
      this.clearCache(identityId);

      return { success: true, keyId: newKeyId };
    } catch (error) {
      logger.error('Error adding encryption key:', error);
      // Extract more detailed error info
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
        logger.error('Error stack:', error.stack);
        logger.error('Error name:', error.name);
        // Check for WASM error properties
        const wasmError = error as { code?: string; data?: unknown; kind?: string | number };
        if (wasmError.code) logger.error('Error code:', wasmError.code);
        if (wasmError.data) logger.error('Error data:', safeStringify(wasmError.data));
        if (wasmError.kind !== undefined) logger.error('Error kind:', wasmError.kind);
        // Log all enumerable properties
        logger.error('Error properties:', Object.keys(error));
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
