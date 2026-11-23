import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { getEvoSdk } from './evo-sdk-service';
import { signerService } from './signer-service';
import { ContractBounds, IdentityPublicKeyInCreation, PrivateKey } from '@dashevo/wasm-sdk';
import { appConnectPins, isAppConnectBuild } from '@/lib/app-connect/config';
import { isBoundToContract } from '@/lib/crypto/encryption-key-lookup';
import { DEVNET_NAME, getConfiguredNetwork, keyNetwork } from '@/lib/constants'
import { bytesEqual, requireBytes } from '@/lib/bytes'
import { findMatchingKeyIndex, getPublicKey } from '@/lib/crypto/keys'
import { extractErrorMessage, sentWriteOutcomeUnknown } from '@/lib/error-utils'
import { getSecurityLevelName, KeyPurpose, KeyType, SecurityLevel, resolveKeyPurpose, resolveKeyType } from '@/lib/crypto/identity-keys'
import { crossTabLocks, withIdentityUpdateLock } from '@/lib/identity-write-lock'
import { sleep } from '@/lib/retry-utils'
import { Identifier } from '@dashevo/wasm-sdk'

/**
 * Where the revision floor is kept: by chain and identity, never under a
 * deployment's storage scope. The identity update lock is one per origin, so
 * every build on it for one chain (root, /staging, /testing) must read the
 * same floor.
 */
const chainName = () => (getConfiguredNetwork() === 'devnet' ? `devnet-${DEVNET_NAME}` : getConfiguredNetwork())
const provedRevisionKey = (identityId: string) => `yappr:identity-revision:${chainName()}:${identityId}`
const FRESH_READS = 5
const FRESH_READ_PAUSE_MS = 1500
export const STALE_IDENTITY_ERROR = "Your account's latest change hasn't reached the network yet. Try again in a moment."

/** The revision the last identity update this browser proved left the identity at, or null. */
function provedIdentityRevision(identityId: string): number | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(provedRevisionKey(identityId))
  } catch {
    // Storage blocked: nothing was noted.
  }
  const revision = raw === null ? NaN : Number(raw)
  return Number.isSafeInteger(revision) ? revision : null
}

/** Records a proved identity update, so the next one (any tab) waits for a read that has it. */
export function noteProvedIdentityRevision(identityId: string, revision: unknown): void {
  const value = Number(revision)
  if (!Number.isSafeInteger(value) || value <= (provedIdentityRevision(identityId) ?? -1)) return
  try {
    localStorage.setItem(provedRevisionKey(identityId), String(value))
  } catch {
    // Storage blocked: the next update reads without a floor.
  }
}

/**
 * Under {@link withIdentityUpdateLock}: the identity to build an update on,
 * read at least as fresh as the last update this browser proved and as
 * `seenRevision`, a revision the caller already read (a node a block behind
 * would hand back a key id and revision already taken), with the SDK's cached
 * identity nonce refreshed (another tab may have used it). Null when there is
 * no such identity; rejects with {@link STALE_IDENTITY_ERROR} when no read
 * catches up.
 */
export async function identityForUpdate(identityId: string, seenRevision?: bigint | number) {
  const sdk = await getEvoSdk()
  try { await sdk.wasm.refreshIdentityNonce(new Identifier(identityId)) } catch { /* best effort */ }
  const proved = provedIdentityRevision(identityId)
  const seen = seenRevision !== undefined && Number.isSafeInteger(Number(seenRevision)) ? Number(seenRevision) : null
  const floor = proved === null ? seen : seen === null ? proved : Math.max(proved, seen)
  for (let attempt = 0; ; attempt++) {
    const identity = await sdk.identities.fetch(identityId)
    if (!identity || floor === null || Number(identity.revision ?? 0) >= floor) return identity
    if (attempt + 1 >= FRESH_READS) throw new Error(STALE_IDENTITY_ERROR)
    await sleep(FRESH_READ_PAUSE_MS)
  }
}

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
   * Fetch identity information. Cached for a minute; `fresh` skips the cache
   * (and refreshes it with what it reads), for a decision that must see the
   * keys as they are now, such as which encryption key a secret is sealed to.
   * Throws when the read fails.
   */
  async getIdentity(identityId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<IdentityInfo | null> {
    try {
      // Check cache
      const cached = fresh ? undefined : this.identityCache.get(identityId);
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
   * Find the identity that holds a public key, by the key's hash160. Platform
   * indexes ECDSA_SECP256K1 keys as unique and ECDSA_HASH160 keys as
   * non-unique; a non-unique hash shared by several identities is ambiguous,
   * so it resolves to null. Returns the identity ID, or null.
   */
  async getIdentityIdByPublicKeyHash(publicKeyHash: Uint8Array): Promise<string | null> {
    const sdk = await getEvoSdk();
    const identity = await sdk.identities.byPublicKeyHash(publicKeyHash);
    if (identity) return identity.id.toBase58();
    const shared = await sdk.identities.byNonUniquePublicKeyHash(publicKeyHash);
    return shared.length === 1 ? shared[0].id.toBase58() : null;
  }

  /**
   * Find the identity whose unique key has this hash160, or null when none
   * does. For a recovery phrase's DIP-13 master key, which wallets register as
   * an ECDSA_SECP256K1 key and Platform indexes as unique, so the non-unique
   * index is never consulted (on testnet it answers a hash nobody holds with
   * "no proof in result" instead of an empty list).
   */
  async getIdentityIdByMasterKeyHash(publicKeyHash: Uint8Array): Promise<string | null> {
    const sdk = await getEvoSdk();
    const identity = await sdk.identities.byPublicKeyHash(publicKeyHash);
    return identity ? identity.id.toBase58() : null;
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
   * Record a credit balance a write's wait result carried (`ownerBalance`,
   * platform#4887: from protocol 14 the proof of an owned, fee-paying
   * transition includes the owner's balance after it), so the next
   * `getBalance` skips a round-trip. The value is a snapshot at the proof's
   * block and may already include later writes of the same identity; the
   * cache's TTL bounds how long it is trusted.
   */
  recordBalance(identityId: string, credits: bigint): void {
    if (credits > BigInt(Number.MAX_SAFE_INTEGER)) {
      // A number would round it; leave the cache to the exact query path.
      logger.warn(`Balance ${credits} credits exceeds Number.MAX_SAFE_INTEGER; not caching the proof's owner balance`);
      this.balanceCache.delete(identityId);
      return;
    }
    const confirmed = Number(credits);
    this.balanceCache.set(identityId, { confirmed, total: confirmed });
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

  /** The revision of one fresh read whose identity has a key with exactly `data` (and id `keyId` when given), or null. */
  private async keyRevision(identityId: string, data: Uint8Array, keyId?: number): Promise<number | null> {
    const sdk = await getEvoSdk();
    const identity = await sdk.identities.fetch(identityId);
    const key = identity?.publicKeys.find((candidate) =>
      (keyId === undefined || candidate.keyId === keyId) && bytesEqual(requireBytes(candidate.data, 'identity key data'), data));
    return identity && key ? Number(identity.revision ?? 0) : null;
  }

  /**
   * The revision of the first fresh read (a few, paced) whose identity has key `keyId` with exactly `data`,
   * or null when none does.
   */
  private async keyReadBackRevision(identityId: string, keyId: number, data: Uint8Array): Promise<number | null> {
    for (let read = 0; read < FRESH_READS; read++) {
      if (read > 0) await sleep(FRESH_READ_PAUSE_MS);
      try {
        const revision = await this.keyRevision(identityId, data, keyId);
        if (revision !== null) return revision;
      } catch (error) {
        logger.warn(`Could not read back key ${keyId} of ${identityId}:`, extractErrorMessage(error));
      }
    }
    return null;
  }

  /**
   * For a key confirmed outside the update lock: under the lock, one fresh identity read, and when it has
   * the key, its revision is recorded so the next update (any tab) builds on it. Returns whether the read
   * had the key. Where the lock is unavailable nothing is recorded: no update is signed here to read it.
   */
  async recordKeyRevision(identityId: string, data: Uint8Array): Promise<boolean> {
    if (!crossTabLocks()) return await this.keyRevision(identityId, data) !== null;
    return await withIdentityUpdateLock(identityId, async () => {
      const revision = await this.keyRevision(identityId, data);
      if (revision === null) return false;
      noteProvedIdentityRevision(identityId, revision);
      return true;
    });
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
   * @param options.cancelled - Asked once the identity update lock is held (it may wait behind another
   *   tab's update) and again right before the broadcast: when it answers true nothing is sent and the
   *   result is `{ success: false, cancelled: true }`
   * @returns Result with success status and the new key ID
   */
  async addEncryptionKey(
    identityId: string,
    encryptionPrivateKey: Uint8Array,
    signingPrivateKeyWif: string,
    _contractId?: string, // Reserved for future use: contract-bound keys
    options: { cancelled?: () => boolean } = {}
  ): Promise<{ success: boolean; keyId?: number; error?: string; cancelled?: boolean }> {
    return withIdentityUpdateLock(identityId, () => this.addEncryptionKeyLocked(identityId, encryptionPrivateKey, signingPrivateKeyWif, options))
      .catch((error: unknown) => ({ success: false, error: extractErrorMessage(error) }));
  }

  private async addEncryptionKeyLocked(
    identityId: string,
    encryptionPrivateKey: Uint8Array,
    signingPrivateKeyWif: string,
    options: { cancelled?: () => boolean }
  ): Promise<{ success: boolean; keyId?: number; error?: string; cancelled?: boolean }> {
    if (options.cancelled?.()) return { success: false, cancelled: true };
    try {
      const sdk = await getEvoSdk();

      const identity = await identityForUpdate(identityId);
      if (!identity) {
        return { success: false, error: 'Identity not found' };
      }

      // On App Connect builds the messaging key is bound to the yappr-app
      // anchor (the only key peers look up there); other encryption keys,
      // such as DashPay's, neither count nor stand in for it.
      const anchorId = isAppConnectBuild() ? appConnectPins()?.appId : undefined;
      if (isAppConnectBuild() && !anchorId) {
        return { success: false, error: 'Encryption keys can\'t be added on this build' };
      }

      // Check if encryption key already exists
      const existingKey = identity.publicKeys.find(
        (key) => isIdentityKeyForPurpose(key, KeyPurpose.ENCRYPTION)
          && !key.disabledAt
          && (!anchorId || isBoundToContract(key.contractBounds, anchorId))
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

      // Use IdentityPublicKeyInCreation from the shared WASM instance.
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
        ...(anchorId ? { contractBounds: ContractBounds.SingleContract(anchorId) } : {}),
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

      if (options.cancelled?.()) return { success: false, cancelled: true };

      if (encryptionPrivateKey.length !== 32) {
        return { success: false, error: `Invalid encryption private key: expected 32 bytes, got ${encryptionPrivateKey.length}` };
      }
      const encryptionKeyHex = Array.from(encryptionPrivateKey).map(b => b.toString(16).padStart(2, '0')).join('');

      // Create signer with the master key (for signing the update transition)
      const signer = await signerService.createSigner(signingPrivateKeyWif);
      let unanswered: { error: unknown } | null = null;
      let encryptionPrivateKeyObj: PrivateKey | undefined;
      try {
        // Also add the NEW encryption key's private key to the signer.
        // Dash Platform requires a "key proof" signature from each new key being added,
        // proving ownership of the private key. The SDK looks up the private key by
        // Hash160(compressed_public_key) in the signer, so it must contain both:
        // 1. The master key (to authorize the identity update)
        // 2. The new key (to generate the key proof)
        encryptionPrivateKeyObj = PrivateKey.fromHex(encryptionKeyHex, keyNetwork());
        signer.addKey(encryptionPrivateKeyObj);
        logger.debug(`Signer now has ${signer.keyCount} keys (master + new encryption key)`);

        // The last moment a caller can still back out: everything after this may be on chain.
        if (options.cancelled?.()) return { success: false, cancelled: true };

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
          // No verdict (a timeout, or a result proof that could not be checked
          // during a quorum rotation): the key may be on the identity already.
          if (!sentWriteOutcomeUnknown(updateError)) throw updateError;
          unanswered = { error: updateError };
        }
      } finally {
        encryptionPrivateKeyObj?.free();
        signer.free();
      }

      if (unanswered) {
        // Still under the lock: the next update must not read a revision before this key's.
        const revision = await this.keyReadBackRevision(identityId, newKeyId, publicKeyBytes);
        if (revision === null) throw unanswered.error;
        logger.warn(`Adding key ${newKeyId} reported "${extractErrorMessage(unanswered.error)}" but the identity has it`);
        noteProvedIdentityRevision(identityId, revision);
        this.clearCache(identityId);
        return { success: true, keyId: newKeyId };
      }

      logger.debug('Encryption key added successfully');
      noteProvedIdentityRevision(identityId, Number(identity.revision ?? 0) + 1);

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
