import { logger } from '@/lib/logger';
import { chunk, mapLimit } from './pagination-utils';
import { TtlMap } from '@/lib/caches/ttl-map';
import { getEvoSdk } from './evo-sdk-service';
import { signerService } from './signer-service';
import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE, YAPPR_PROFILE_CONTRACT_ID, keyNetwork } from '../constants';
import { documentToPlainObject, identifierToBase58, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose, SecurityLevel, getPurposeName, getSecurityLevelName } from '@/lib/crypto/identity-keys';
import type { UsernameCheckResult, UsernameRegistrationResult } from '../types';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import { getPrimaryUsername, sortUsernames } from '@/lib/utils/username';

/**
 * Extract documents array from SDK response (handles Map, Array, and object formats)
 */
function extractDocuments(response: unknown): Record<string, unknown>[] {
  if (response instanceof Map) {
    return Array.from(response.values())
      .filter(Boolean)
      .map(documentToPlainObject);
  }
  if (Array.isArray(response)) {
    return response.map(documentToPlainObject);
  }
  const maybeDocument = response as { toObject?: () => unknown };
  if (typeof maybeDocument.toObject === 'function') {
    return [documentToPlainObject(response)];
  }
  const respObj = response as { documents?: unknown[]; toJSON?: () => unknown };
  if (respObj?.documents) {
    return respObj.documents.map(documentToPlainObject);
  }
  if (respObj?.toJSON) {
    const json = respObj.toJSON() as { documents?: unknown[] } | unknown[];
    if (Array.isArray(json)) return json.map(documentToPlainObject);
    return ((json as { documents?: unknown[] }).documents || []).map(documentToPlainObject);
  }
  return [];
}

class DpnsService {
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000;
  /** lower-cased username -> identity id */
  private cache = new TtlMap<string, string>(DpnsService.CACHE_TTL_MS);
  /** identity id -> primary username */
  private reverseCache = new TtlMap<string, string>(DpnsService.CACHE_TTL_MS);

  /** Cache only complete DPNS lookup results; null records a proven absence. */
  private reverseMissCache = new TtlMap<string, true>(5 * 60 * 1000);

  private aliasCache = new TtlMap<string, string[]>(5 * 60 * 1000);

  hasCachedUsername(identityId: string): boolean {
    return this.reverseCache.has(identityId) || this.reverseMissCache.has(identityId);
  }

  seedUsernames(usernames: ReadonlyMap<string, string | null>): void {
    usernames.forEach((username, identityId) => {
      if (username) {
        this._cacheEntry(username, identityId);
      } else {
        this.reverseCache.delete(identityId);
        this.reverseMissCache.set(identityId, true);
      }
    });
  }

  /**
   * Helper method to cache entries in both directions
   */
  private _cacheEntry(username: string, identityId: string): void {
    this.cache.set(username.toLowerCase(), identityId);
    this.reverseCache.set(identityId, username);
    this.reverseMissCache.delete(identityId);
  }

  /**
   * Get all usernames for an identity ID
   */
  async getAllUsernames(identityId: string): Promise<string[]> {
    return (await this.getAllUsernamesSortedBatch([identityId])).get(identityId) ?? [];
  }

  async getAllUsernamesSorted(identityId: string): Promise<string[]> {
    return this.getAllUsernames(identityId);
  }

  /** Complete alias sets, chunked below the IN/row budgets and cursor-paged
   * for crowded identities. Never seed a partial set or a transport failure. */
  async getAllUsernamesSortedBatch(identityIds: string[]): Promise<Map<string, string[]>> {
    const ids = Array.from(new Set(identityIds.filter(Boolean)));
    const result = new Map<string, string[]>();
    const missing = ids.filter(id => {
      const cached = this.aliasCache.get(id);
      if (cached !== undefined) result.set(id, [...cached]);
      return cached === undefined;
    });
    if (missing.length === 0) return result;
    let sdk: Awaited<ReturnType<typeof getEvoSdk>>;
    try {
      sdk = await getEvoSdk();
    } catch (error) {
      logger.error('DPNS: SDK unavailable for aliases', error);
      return result;
    }
    // Leave headroom for absent branches and multiple aliases per identity.
    await mapLimit(chunk(missing, 40), 2, async batch => {
      try {
        let documents = extractDocuments(await sdk.documents.query({
          dataContractId: DPNS_CONTRACT_ID,
          documentTypeName: DPNS_DOCUMENT_TYPE,
          where: [['records.identity', 'in', batch]],
          orderBy: [['records.identity', 'asc']],
          limit: 100,
        }));
        if (documents.length + batch.length >= 100) {
          documents = [];
          for (const id of batch) {
            let startAfter: string | undefined;
            while (true) {
              const page = extractDocuments(await sdk.documents.query({
                dataContractId: DPNS_CONTRACT_ID,
                documentTypeName: DPNS_DOCUMENT_TYPE,
                where: [['records.identity', '==', id]],
                orderBy: [['records.identity', 'asc']],
                limit: 100,
                ...(startAfter ? { startAfter } : {}),
              }));
              documents.push(...page);
              if (page.length < 100) break;
              const last = page[page.length - 1];
              const next = identifierToBase58(last.$id || last.id);
              if (!next || next === startAfter) throw new Error('DPNS: alias cursor did not advance');
              startAfter = next;
            }
          }
        }
        const names = new Map<string, string[]>(batch.map(id => [id, []]));
        for (const doc of documents) {
          const data = (doc.data || doc) as Record<string, unknown>;
          const records = data.records as Record<string, unknown> | undefined;
          const id = identifierToBase58(records?.identity || records?.dashUniqueIdentityId);
          const label = data.label || data.normalizedLabel;
          if (id && typeof label === 'string') {
            names.get(id)?.push(`${label}.${data.normalizedParentDomainName || 'dash'}`);
          }
        }
        names.forEach((aliases, id) => {
          const sorted = sortUsernames(Array.from(new Set(aliases)));
          result.set(id, sorted);
          this.aliasCache.set(id, sorted);
          // Forward lookup knows every alias; reverse lookup knows the PRIMARY.
          sorted.forEach(name => this.cache.set(name.toLowerCase(), id));
          this.seedUsernames(new Map([[id, sorted[0] ?? null]]));
        });
      } catch (error) {
        logger.error('DPNS: Batch alias resolution error:', error);
      }
    });
    return result;
  }

  /** Primary names reuse complete alias reads; composite seeds remain valid. */
  async resolveUsernamesBatch(identityIds: string[]): Promise<Map<string, string | null>> {
    const ids = Array.from(new Set(identityIds.filter(Boolean)));
    const results = new Map<string, string | null>();
    const missing = ids.filter(id => {
      const name = this.reverseCache.get(id);
      if (name !== undefined) results.set(id, name);
      else if (this.reverseMissCache.has(id)) results.set(id, null);
      return !results.has(id);
    });
    const aliases = await this.getAllUsernamesSortedBatch(missing);
    missing.forEach(id => results.set(id, aliases.get(id)?.[0] ?? null));
    return results;
  }

  /**
   * Resolve a username for an identity ID (reverse lookup)
   * Returns the best username (contested usernames are preferred)
   */
  async resolveUsername(identityId: string): Promise<string | null> {
    try {
      // Check cache
      const cached = this.reverseCache.get(identityId);
      if (cached !== undefined) return cached;
      if (this.reverseMissCache.has(identityId)) return null;

      // Get all usernames for this identity and pick the primary one
      const allUsernames = await this.getAllUsernames(identityId);
      const bestUsername = getPrimaryUsername(allUsernames);

      if (!bestUsername) {
        return null;
      }

      this._cacheEntry(bestUsername, identityId);
      return bestUsername;
    } catch (error) {
      logger.error('DPNS: Error resolving username:', error);
      return null;
    }
  }

  /**
   * Resolve an identity ID from a username
   */
  async resolveIdentity(username: string): Promise<string | null> {
    try {
      // Normalize: lowercase and remove .dash suffix
      const normalizedUsername = username.toLowerCase().replace(/\.dash$/, '');

      // Check cache first
      const cached = this.cache.get(normalizedUsername);
      if (cached !== undefined) return cached;

      const sdk = await getEvoSdk();

      // Try native resolution first using EvoSDK facade (v3 SDK returns string directly)
      try {
        if (sdk.dpns?.resolveName) {
          const identityId = await sdk.dpns.resolveName(normalizedUsername);

          if (identityId) {
            this._cacheEntry(normalizedUsername, identityId);
            return identityId;
          }
        }
      } catch (error) {
        logger.warn('DPNS: Native resolver failed, falling back to document query:', error);
      }

      // Fallback: Query DPNS documents directly
      const parts = normalizedUsername.split('.');
      const label = parts[0];
      const parentDomain = parts.slice(1).join('.') || 'dash';

      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [
          ['normalizedLabel', '==', label.toLowerCase()],
          ['normalizedParentDomainName', '==', parentDomain.toLowerCase()]
        ],
        limit: 1
      });

      const documents = extractDocuments(response);
      if (documents.length > 0) {
        const doc = documents[0];
        const data = (doc.data || doc) as Record<string, unknown>;
        const records = data.records as Record<string, unknown> | undefined;
        const rawId = records?.identity || records?.dashUniqueIdentityId || records?.dashAliasIdentityId;
        const identityId = identifierToBase58(rawId);

        if (identityId) {
          this._cacheEntry(normalizedUsername, identityId);
          return identityId;
        }
      }

      return null;
    } catch (error) {
      logger.error('DPNS: Error resolving identity:', error);
      return null;
    }
  }

  /**
   * Check if a username is available
   */
  async isUsernameAvailable(username: string): Promise<boolean> {
    try {
      const normalizedUsername = username.toLowerCase().replace(/\.dash$/, '');

      // Try native availability check first (more efficient)
      try {
        const sdk = await getEvoSdk();
        return await sdk.dpns.isNameAvailable(normalizedUsername);
      } catch {
        // Fallback to identity resolution
      }

      // Fallback: Check by trying to resolve identity
      const identity = await this.resolveIdentity(normalizedUsername);
      return identity === null;
    } catch (error) {
      logger.error('DPNS: Error checking username availability:', error);
      // If error, assume not available to be safe
      return false;
    }
  }

  /**
   * Search for usernames by prefix with full details
   */
  async searchUsernamesWithDetails(prefix: string, limit: number = 10): Promise<Array<{ username: string; ownerId: string }>> {
    try {
      const sdk = await getEvoSdk();

      // Remove .dash suffix if present for search
      const cleanPrefix = prefix.toLowerCase().replace(/\.dash$/, '');

      // Normalize the search prefix to match how DPNS stores normalizedLabel
      const searchPrefix = await sdk.dpns.convertToHomographSafe(cleanPrefix);

      const query = {
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [
          ['normalizedLabel', 'startsWith', searchPrefix],
          ['normalizedParentDomainName', '==', 'dash'],
        ] as DocumentWhereClause[],
        orderBy: [['normalizedLabel', 'asc']] as DocumentOrderByClause[], limit,
      };
      let documents: Record<string, unknown>[] | undefined;
      if (likesAreIndexOnly()) {
        try {
          const result = await sdk.documents.composite({
            dataContractId: DPNS_CONTRACT_ID, documentType: DPNS_DOCUMENT_TYPE,
            where: query.where, orderBy: query.orderBy, limit,
            subQueries: [{ dataContractId: YAPPR_PROFILE_CONTRACT_ID, documentType: 'profile',
              bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } }],
          });
          const profiles = result.subResults?.[0];
          if (!Array.isArray(result.pageDocuments) || result.subResults.length !== 1 ||
              profiles?.kind !== 'documents' || !Array.isArray(profiles.documents)) {
            throw new Error('DPNS search: incomplete composite response');
          }
          documents = result.pageDocuments.map(documentToPlainObject);
          const owners = documents.map(doc => String(doc.$ownerId || doc.ownerId));
          const { unifiedProfileService } = await import('./unified-profile-service');
          unifiedProfileService.seedProfileDocuments(profiles.documents.map(documentToPlainObject), owners);
        } catch (error) {
          logger.warn('DPNS search composite failed; using ordinary search', error);
        }
      }
      documents ??= extractDocuments(await sdk.documents.query(query));
      return documents.map((doc) => {
        const data = (doc.data || doc) as Record<string, unknown>;
        const label = (data.label || data.normalizedLabel || 'unknown') as string;
        const parentDomain = (data.normalizedParentDomainName || 'dash') as string;
        const ownerId = (doc.ownerId || doc.$ownerId || '') as string;

        return {
          username: `${label}.${parentDomain}`,
          ownerId: ownerId
        };
      });
    } catch (error) {
      logger.error('DPNS: Error searching usernames with details:', error);
      return [];
    }
  }

  /**
   * The enabled CRITICAL or HIGH authentication key the private key corresponds
   * to. DPNS registration may not be signed with MASTER.
   */
  private findMatchingSigningKey(
    privateKeyWif: string,
    wasmPublicKeys: WasmIdentityPublicKey[]
  ): WasmIdentityPublicKey | null {
    const result = matchIdentityKey(privateKeyWif, wasmPublicKeys, {
      network: keyNetwork(),
      purpose: KeyPurpose.AUTHENTICATION,
      allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
    });
    if (!result.ok) {
      logger.error(
        result.reason === 'rejected'
          ? `DPNS: Private key matches key id=${result.match.keyId} (purpose ${getPurposeName(result.match.purpose)}, level ${getSecurityLevelName(result.match.securityLevel)}), which cannot sign this operation: CRITICAL or HIGH AUTHENTICATION required`
          : `DPNS: Private key does not match any enabled key on this identity`
      );
      return null;
    }
    logger.debug(`DPNS: Matched private key to identity key: id=${result.match.keyId}, securityLevel=${getSecurityLevelName(result.match.securityLevel)}`);
    return result.key;
  }

  /**
   * Register a new username using the SDK API
   */
  async registerUsername(
    label: string,
    identityId: string,
    privateKeyWif: string,
    onPreorderSuccess?: () => void
  ): Promise<{ success: boolean }> {
    try {
      const sdk = await getEvoSdk();

      // Validate the username first using SDK
      const isValid = await sdk.dpns.isValidUsername(label);
      if (!isValid) {
        throw new Error(`Invalid username format: ${label}`);
      }

      // Check if it's contested
      const isContested = await sdk.dpns.isContestedUsername(label);
      if (isContested) {
        logger.warn(`Username ${label} is contested and will require masternode voting`);
      }

      // Check availability
      const isAvailable = await sdk.dpns.isNameAvailable(label);
      if (!isAvailable) {
        throw new Error(`Username ${label} is already taken`);
      }

      // Fetch identity to validate and get public key info
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      // Get WASM public keys to find the matching signing key
      const wasmPublicKeys = identity.publicKeys;

      // Find a signing key that matches the provided private key
      // DPNS operations require CRITICAL or HIGH security level
      const identityKey = this.findMatchingSigningKey(privateKeyWif, wasmPublicKeys);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your private key. DPNS operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.debug(`DPNS: Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      // Create signer and identity key for the state transition
      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKeyWif,
        identityKey
      );

      // Register the name
      logger.debug(`Registering DPNS name: ${label}`);
      await sdk.dpns.registerName({
        label,
        identity,
        identityKey: signingKey,
        signer,
        preorderCallback: onPreorderSuccess
      });

      // Clear cache for this identity
      this.clearCache(undefined, identityId);

      return { success: true };
    } catch (error) {
      logger.error('Error registering username:', error);
      throw error;
    }
  }

  /**
   * Validate a username according to DPNS rules
   */
  async validateUsername(label: string): Promise<{
    isValid: boolean;
    isContested: boolean;
    normalizedLabel: string;
  }> {
    const sdk = await getEvoSdk();
    const isValid = await sdk.dpns.isValidUsername(label);
    const isContested = await sdk.dpns.isContestedUsername(label);
    const normalizedLabel = await sdk.dpns.convertToHomographSafe(label);

    return {
      isValid,
      isContested,
      normalizedLabel
    };
  }

  /**
   * Get username validation error message (basic client-side validation)
   * For full DPNS validation, use validateUsername() which requires SDK
   */
  getUsernameValidationError(username: string): string | null {
    if (!username) {
      return 'Username is required';
    }

    if (username.length < 3) {
      return 'Username must be at least 3 characters long';
    }

    if (username.length > 20) {
      return 'Username must be 20 characters or less';
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return 'Username can only contain letters, numbers, and underscores';
    }

    if (username.startsWith('_') || username.endsWith('_')) {
      return 'Username cannot start or end with underscore';
    }

    if (username.includes('__')) {
      return 'Username cannot contain consecutive underscores';
    }

    return null;
  }


  /**
   * Batch check availability and contested status for multiple usernames
   */
  async batchCheckAvailability(labels: string[]): Promise<Map<string, UsernameCheckResult>> {
    const results = new Map<string, UsernameCheckResult>();

    // Check each username in parallel
    const checks = await Promise.allSettled(
      labels.map(async (label) => {
        const normalizedLabel = label.toLowerCase().replace(/\.dash$/, '');
        try {
          const sdk = await getEvoSdk();
          const [available, contested] = await Promise.all([
            sdk.dpns.isNameAvailable(normalizedLabel),
            sdk.dpns.isContestedUsername(normalizedLabel),
          ]);
          return { label: normalizedLabel, available, contested };
        } catch (error) {
          return {
            label: normalizedLabel,
            available: false,
            contested: false,
            error: error instanceof Error ? error.message : 'Check failed',
          };
        }
      })
    );

    // Process results
    for (const result of checks) {
      if (result.status === 'fulfilled') {
        const { label, available, contested, error } = result.value;
        results.set(label, { available, contested, error });
      }
    }

    return results;
  }

  /**
   * Register multiple usernames sequentially with progress callback
   * Uses typed API (publicKeyId no longer needed - key is found from identity)
   */
  async registerUsernamesSequentially(
    registrations: Array<{
      label: string;
      identityId: string;
      privateKeyWif: string;
      publicKeyId?: number; // Deprecated, kept for backwards compatibility but ignored
    }>,
    onProgress?: (index: number, total: number, label: string) => void
  ): Promise<UsernameRegistrationResult[]> {
    const results: UsernameRegistrationResult[] = [];

    for (let i = 0; i < registrations.length; i++) {
      const reg = registrations[i];
      onProgress?.(i, registrations.length, reg.label);

      try {
        const sdk = await getEvoSdk();
        const isContested = await sdk.dpns.isContestedUsername(reg.label);

        await this.registerUsername(
          reg.label,
          reg.identityId,
          reg.privateKeyWif
        );

        results.push({
          label: reg.label,
          success: true,
          isContested,
        });
      } catch (error) {
        results.push({
          label: reg.label,
          success: false,
          isContested: false,
          error: error instanceof Error ? error.message : 'Registration failed',
        });
      }
    }

    return results;
  }

  /**
   * Clear cache entries
   */
  clearCache(username?: string, identityId?: string): void {
    if (identityId) this.aliasCache.delete(identityId);
    else this.aliasCache.clear();
    if (username) {
      this.cache.delete(username.toLowerCase());
    }
    if (identityId) {
      this.reverseCache.delete(identityId);
      this.reverseMissCache.delete(identityId);
    }
    if (!username && !identityId) {
      this.cache.clear();
      this.reverseCache.clear();
      this.reverseMissCache.clear();
    }
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): void {
    this.cache.prune();
    this.reverseCache.prune();
    this.reverseMissCache.prune();
    this.aliasCache.prune();
  }
}

// Singleton instance
export const dpnsService = new DpnsService();

// Set up periodic cache cleanup
if (typeof window !== 'undefined') {
  setInterval(() => {
    dpnsService.cleanupCache();
  }, 3600000); // Clean up every hour
}
