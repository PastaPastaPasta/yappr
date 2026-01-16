import { getEvoSdk } from './evo-sdk-service';
import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE } from '../constants';
import { identifierToBase58 } from './sdk-helpers';
import type { UsernameCheckResult, UsernameRegistrationResult } from '../types';

/**
 * Extract documents array from SDK response (handles Map, Array, and object formats)
 */
function extractDocuments(response: unknown): Record<string, unknown>[] {
  if (response instanceof Map) {
    return Array.from(response.values())
      .filter(Boolean)
      .map((doc: unknown) => {
        const d = doc as { toJSON?: () => unknown };
        return (typeof d.toJSON === 'function' ? d.toJSON() : doc) as Record<string, unknown>;
      });
  }
  if (Array.isArray(response)) {
    return response.map((doc: unknown) => {
      const d = doc as { toJSON?: () => unknown };
      return (typeof d.toJSON === 'function' ? d.toJSON() : doc) as Record<string, unknown>;
    });
  }
  const respObj = response as { documents?: unknown[]; toJSON?: () => unknown };
  if (respObj?.documents) {
    return respObj.documents as Record<string, unknown>[];
  }
  if (respObj?.toJSON) {
    const json = respObj.toJSON() as { documents?: unknown[] } | unknown[];
    if (Array.isArray(json)) return json as Record<string, unknown>[];
    return (json as { documents?: unknown[] }).documents as Record<string, unknown>[] || [];
  }
  return [];
}

class DpnsService {
  private cache: Map<string, { value: string; timestamp: number }> = new Map();
  private reverseCache: Map<string, { value: string; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour cache for DPNS

  /**
   * Helper method to cache entries in both directions
   */
  private _cacheEntry(username: string, identityId: string): void {
    const now = Date.now();
    this.cache.set(username.toLowerCase(), { value: identityId, timestamp: now });
    this.reverseCache.set(identityId, { value: username, timestamp: now });
  }

  /**
   * Get all usernames for an identity ID
   */
  async getAllUsernames(identityId: string): Promise<string[]> {
    try {
      const sdk = await getEvoSdk();

      // Try the dedicated DPNS usernames function first (v3 SDK returns string[] directly)
      try {
        const usernames = await sdk.dpns.usernames({ identityId, limit: 20 });
        if (usernames && usernames.length > 0) {
          return usernames;
        }
      } catch {
        // Fallback to document query
      }

      // Fallback: Query DPNS documents by identity ID
      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [['records.identity', '==', identityId]],
        limit: 20
      });

      const documents = extractDocuments(response);
      return documents.map((doc) => {
        const data = (doc.data || doc) as Record<string, unknown>;
        return `${data.label}.${data.normalizedParentDomainName}`;
      });
    } catch (error) {
      console.error('DPNS: Error fetching all usernames:', error);
      return [];
    }
  }

  /**
   * Sort usernames by contested status (contested usernames first)
   */
  async sortUsernamesByContested(usernames: string[]): Promise<string[]> {
    const sdk = await getEvoSdk();

    // Check contested status for all usernames
    const contestedStatuses = await Promise.all(
      usernames.map(async (u) => ({
        username: u,
        contested: await sdk.dpns.isContestedUsername(u.split('.')[0])
      }))
    );

    return contestedStatuses
      .sort((a, b) => {
        if (a.contested && !b.contested) return -1;
        if (!a.contested && b.contested) return 1;
        // If both contested or both not contested, sort alphabetically
        return a.username.localeCompare(b.username);
      })
      .map(item => item.username);
  }

  /**
   * Batch resolve usernames for multiple identity IDs (reverse lookup)
   * Uses 'in' operator for efficient single-query resolution
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  async resolveUsernamesBatch(identityIds: string[]): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();

    // Initialize all as null
    identityIds.forEach(id => results.set(id, null));

    if (identityIds.length === 0) return results;

    // Check cache first
    const uncachedIds: string[] = [];
    for (const id of identityIds) {
      const cached = this.reverseCache.get(id);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        results.set(id, cached.value);
      } else {
        uncachedIds.push(id);
      }
    }

    if (uncachedIds.length === 0) {
      return results;
    }

    try {
      const sdk = await getEvoSdk();

      // Batch query using 'in' operator (max 100 per query)
      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [['records.identity', 'in', uncachedIds]],
        orderBy: [['records.identity', 'asc']],
        limit: 100
      });

      const documents = extractDocuments(response);
      for (const doc of documents) {
        const data = (doc.data || doc) as Record<string, unknown>;
        const records = data.records as Record<string, unknown> | undefined;
        const rawId = records?.identity || records?.dashUniqueIdentityId;
        // Convert base64 identity to base58 for consistent map keys
        const identityId = identifierToBase58(rawId);
        const label = data.label || data.normalizedLabel;
        const parentDomain = data.normalizedParentDomainName || 'dash';
        const username = `${label}.${parentDomain}`;

        if (identityId && label) {
          results.set(identityId, username);
          this._cacheEntry(username, identityId);
        }
      }
    } catch (error) {
      console.error('DPNS: Batch resolution error:', error);
    }

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
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.value;
      }

      // Get all usernames for this identity
      const allUsernames = await this.getAllUsernames(identityId);

      if (allUsernames.length === 0) {
        return null;
      }

      // Sort usernames with contested ones first
      const sortedUsernames = await this.sortUsernamesByContested(allUsernames);
      const bestUsername = sortedUsernames[0];

      this._cacheEntry(bestUsername, identityId);
      return bestUsername;
    } catch (error) {
      console.error('DPNS: Error resolving username:', error);
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
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.value;
      }

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
        console.warn('DPNS: Native resolver failed, falling back to document query:', error);
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
      console.error('DPNS: Error resolving identity:', error);
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
      console.error('DPNS: Error checking username availability:', error);
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

      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [
          ['normalizedLabel', 'startsWith', searchPrefix],
          ['normalizedParentDomainName', '==', 'dash']
        ],
        orderBy: [['normalizedLabel', 'asc']],
        limit
      });

      const documents = extractDocuments(response);
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
      console.error('DPNS: Error searching usernames with details:', error);
      return [];
    }
  }

  /**
   * Search for usernames by prefix
   */
  async searchUsernames(prefix: string, limit: number = 10): Promise<string[]> {
    const results = await this.searchUsernamesWithDetails(prefix, limit);
    return results.map(r => r.username);
  }

  /**
   * Register a new username
   */
  async registerUsername(
    label: string,
    identityId: string,
    publicKeyId: number,
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
        console.warn(`Username ${label} is contested and will require masternode voting`);
      }

      // Check availability
      const isAvailable = await sdk.dpns.isNameAvailable(label);
      if (!isAvailable) {
        throw new Error(`Username ${label} is already taken`);
      }

      // Register the name using EvoSDK facade
      console.log(`Registering DPNS name: ${label}`);
      await sdk.dpns.registerName({
        label,
        identityId,
        publicKeyId,
        privateKeyWif,
        onPreorder: onPreorderSuccess
      });

      // Clear cache for this identity
      this.clearCache(undefined, identityId);

      return { success: true };
    } catch (error) {
      console.error('Error registering username:', error);
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
   */
  async registerUsernamesSequentially(
    registrations: Array<{
      label: string;
      identityId: string;
      publicKeyId: number;
      privateKeyWif: string;
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
          reg.publicKeyId,
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
    if (username) {
      this.cache.delete(username.toLowerCase());
    }
    if (identityId) {
      this.reverseCache.delete(identityId);
    }
    if (!username && !identityId) {
      this.cache.clear();
      this.reverseCache.clear();
    }
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): void {
    const now = Date.now();
    
    // Clean forward cache
    for (const [key, value] of Array.from(this.cache.entries())) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
    
    // Clean reverse cache
    for (const [key, value] of Array.from(this.reverseCache.entries())) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.reverseCache.delete(key);
      }
    }
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