import { getEvoSdk } from './evo-sdk-service';
import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE } from '../constants';
import bs58 from 'bs58';

interface DpnsDocument {
  $id: string;
  $ownerId: string;
  $revision: number;
  $createdAt?: number;
  $updatedAt?: number;
  label: string;
  normalizedLabel: string;
  normalizedParentDomainName: string;
  preorderSalt: string;
  records: {
    identity?: string;  // This is the actual field name used in DPNS
    dashUniqueIdentityId?: string;
    dashAliasIdentityId?: string;
  };
  subdomainRules?: {
    allowSubdomains: boolean;
  };
}

class DpnsService {
  private cache: Map<string, { value: string; timestamp: number }> = new Map();
  private reverseCache: Map<string, { value: string; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour cache for DPNS

  /**
   * Convert a value to base58 string.
   * Handles base64 strings (from SDK v3 toJSON), Uint8Array, and number arrays.
   */
  private toBase58String(value: unknown): string | null {
    if (typeof value === 'string') {
      // First check if it's already valid base58
      try {
        const decoded = bs58.decode(value);
        if (decoded.length === 32) {
          return value; // Already base58
        }
      } catch {
        // Not base58, try base64
      }

      // Try base64 (SDK v3 returns base64 for records.identity)
      if (value.includes('+') || value.includes('/') || value.endsWith('=')) {
        try {
          const bytes = this.base64ToBytes(value);
          if (bytes.length === 32) {
            return bs58.encode(bytes);
          }
        } catch {
          // Not valid base64
        }
      }

      return null;
    }
    if (value instanceof Uint8Array) {
      return bs58.encode(value);
    }
    if (Array.isArray(value)) {
      return bs58.encode(new Uint8Array(value));
    }
    return null;
  }

  /**
   * Convert base64 string to bytes
   */
  private base64ToBytes(base64: string): Uint8Array {
    if (typeof atob === 'function') {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } else {
      return new Uint8Array(Buffer.from(base64, 'base64'));
    }
  }

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
      console.log(`DPNS: Fetching all usernames for identity: ${identityId}`);
      
      const sdk = await getEvoSdk();

      // Try the dedicated DPNS usernames function first (v3 SDK returns string[] directly)
      try {
        const usernames = await sdk.dpns.usernames({ identityId, limit: 20 });
        console.log('DPNS: Usernames response:', usernames);

        if (usernames && usernames.length > 0) {
          console.log(`DPNS: Found ${usernames.length} usernames for identity ${identityId}`);
          return usernames;
        }
      } catch (error) {
        console.warn('DPNS: sdk.dpns.usernames failed, trying document query:', error);
      }

      // Fallback: Query DPNS documents by identity ID
      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [['records.identity', '==', identityId]],
        limit: 20
      } as any);

      // Handle Map response (v3 SDK)
      if (response instanceof Map) {
        const docs = Array.from(response.values()).filter(Boolean);
        if (docs.length > 0) {
          const usernames = docs.map((doc: any) => {
            const docData = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
            return `${docData.label}.${docData.normalizedParentDomainName}`;
          });
          console.log(`DPNS: Found ${usernames.length} usernames for identity ${identityId} via document query`);
          return usernames;
        }
      } else if (response && (response as any).documents && (response as any).documents.length > 0) {
        const usernames = (response as any).documents.map((doc: DpnsDocument) =>
          `${doc.label}.${doc.normalizedParentDomainName}`
        );
        console.log(`DPNS: Found ${usernames.length} usernames for identity ${identityId} via document query`);
        return usernames;
      }
      
      console.log(`DPNS: No usernames found for identity ${identityId}`);
      return [];
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

      // Note: records.identity stores identity IDs as JSON strings (not bytes)
      // So we pass them as-is without byte conversion
      // Batch query using 'in' operator (max 100 per query)
      // Must include orderBy to satisfy Dash Platform query requirements
      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [['records.identity', 'in', uncachedIds]],
        orderBy: [['records.identity', 'asc']],
        limit: 100
      } as any);

      // Process results - handle Map response (v3 SDK)
      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if ((response as any)?.documents) {
        documents = (response as any).documents;
      } else if ((response as any)?.toJSON) {
        const json = (response as any).toJSON();
        documents = Array.isArray(json) ? json : json.documents || [];
      }

      for (const doc of documents) {
        const data = doc.data || doc;
        const rawId = data.records?.identity || data.records?.dashUniqueIdentityId;
        // Convert base64 identity to base58 for consistent map keys
        const identityId = this.toBase58String(rawId);
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
        console.log(`DPNS: Returning cached username for ${identityId}: ${cached.value}`);
        return cached.value;
      }

      console.log(`DPNS: Fetching username for identity: ${identityId}`);
      
      // Get all usernames for this identity
      const allUsernames = await this.getAllUsernames(identityId);
      
      if (allUsernames.length === 0) {
        console.log(`DPNS: No username found for identity ${identityId}`);
        return null;
      }
      
      // Sort usernames with contested ones first
      const sortedUsernames = await this.sortUsernamesByContested(allUsernames);
      const bestUsername = sortedUsernames[0];
      
      console.log(`DPNS: Found best username ${bestUsername} for identity ${identityId} (from ${allUsernames.length} total)`);
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
      } as any);

      // Handle response formats - v3 SDK returns Map
      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if ((response as any)?.documents) {
        documents = (response as any).documents;
      } else if ((response as any)?.toJSON) {
        const json = (response as any).toJSON();
        documents = Array.isArray(json) ? json : json.documents || [];
      }

      if (documents.length > 0) {
        const doc = documents[0];
        const data = doc.data || doc;
        const rawId = data.records?.identity || data.records?.dashUniqueIdentityId || data.records?.dashAliasIdentityId;
        const identityId = this.toBase58String(rawId);

        if (identityId) {
          this._cacheEntry(normalizedUsername, identityId);
          return identityId;
        }
      }
      
      console.log(`DPNS: No identity found for username ${normalizedUsername}`);
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
      const normalizedUsername = username.toLowerCase().replace('.dash', '');
      
      // Try native availability check first (more efficient)
      try {
        const sdk = await getEvoSdk();
        const isAvailable = await sdk.dpns.isNameAvailable(normalizedUsername);
        console.log(`DPNS: Username ${normalizedUsername} availability (native): ${isAvailable}`);
        return isAvailable;
      } catch (error) {
        console.warn('DPNS: Native availability check failed, trying identity resolution:', error);
      }
      
      // Fallback: Check by trying to resolve identity
      const identity = await this.resolveIdentity(normalizedUsername);
      const isAvailable = identity === null;
      console.log(`DPNS: Username ${normalizedUsername} availability (fallback): ${isAvailable}`);
      return isAvailable;
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

      // IMPORTANT: Normalize the search prefix to match how DPNS stores normalizedLabel
      // Characters like 'l' -> '1', 'i' -> '1', 'o' -> '0' etc are converted during registration
      const searchPrefix = await sdk.dpns.convertToHomographSafe(cleanPrefix);

      // Search DPNS names by prefix
      console.log(`DPNS: Searching usernames with prefix: ${cleanPrefix} (normalized: ${searchPrefix})`);
      
      // Build where clause for starts-with query on normalizedLabel
      const where = [
        ['normalizedLabel', 'startsWith', searchPrefix],
        ['normalizedParentDomainName', '==', 'dash']
      ];
      const orderBy = [['normalizedLabel', 'asc']];

      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where,
        orderBy,
        limit
      } as any);

      // Handle Map response (v3 SDK)
      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      }

      if (documents.length > 0) {
        console.log(`DPNS: Found ${documents.length} documents`);

        // Map documents to results with owner IDs
        const results = documents.map((doc: any) => {
          // Access the data field which contains the DPNS document fields
          const data = doc.data || doc;
          const label = data.label || data.normalizedLabel || 'unknown';
          const parentDomain = data.normalizedParentDomainName || 'dash';
          const ownerId = doc.ownerId || doc.$ownerId || '';

          return {
            username: `${label}.${parentDomain}`,
            ownerId: ownerId
          };
        });

        return results;
      }

      return [];
    } catch (error) {
      console.error('DPNS: Error searching usernames with details:', error);
      return [];
    }
  }

  /**
   * Search for usernames by prefix
   */
  async searchUsernames(prefix: string, limit: number = 10): Promise<string[]> {
    try {
      const sdk = await getEvoSdk();

      // Remove .dash suffix if present for search
      const cleanPrefix = prefix.toLowerCase().replace(/\.dash$/, '');

      // IMPORTANT: Normalize the search prefix to match how DPNS stores normalizedLabel
      // Characters like 'l' -> '1', 'i' -> '1', 'o' -> '0' etc are converted during registration
      const searchPrefix = await sdk.dpns.convertToHomographSafe(cleanPrefix);

      // Search DPNS names by prefix
      console.log(`DPNS: Searching usernames with prefix: ${cleanPrefix} (normalized: ${searchPrefix})`);
      console.log(`DPNS: Using contract ID: ${DPNS_CONTRACT_ID}`);
      console.log(`DPNS: Document type: ${DPNS_DOCUMENT_TYPE}`);

      // Build where clause for starts-with query on normalizedLabel
      const where = [
        ['normalizedLabel', 'startsWith', searchPrefix],
        ['normalizedParentDomainName', '==', 'dash']
      ];
      const orderBy = [['normalizedLabel', 'asc']];

      console.log('DPNS: Query where clause:', JSON.stringify(where));
      console.log('DPNS: Query orderBy:', JSON.stringify(orderBy));

      const response = await sdk.documents.query({
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where,
        orderBy,
        limit
      } as any);

      console.log('DPNS: Search response:', response);
      console.log('DPNS: Response type:', typeof response);

      // Handle Map response (v3 SDK)
      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      }

      if (documents.length > 0) {
        console.log(`DPNS: Found ${documents.length} documents`);

        // Map documents to usernames
        const usernames = documents.map((doc: any) => {
          console.log('DPNS: Processing document:', doc);

          // Access the data field which contains the DPNS document fields
          const data = doc.data || doc;
          const label = data.label || data.normalizedLabel || 'unknown';
          const parentDomain = data.normalizedParentDomainName || 'dash';

          console.log('DPNS: Document fields:', {
            label: data.label,
            normalizedLabel: data.normalizedLabel,
            parentDomain: data.normalizedParentDomainName,
            ownerId: doc.ownerId || doc.$ownerId
          });

          return `${label}.${parentDomain}`;
        });

        return usernames;
      }

      console.log('DPNS: No documents found in response');
      return [];
    } catch (error) {
      console.error('DPNS: Error searching usernames:', error);
      return [];
    }
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
  ): Promise<any> {
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
      const result = await sdk.dpns.registerName({
        label,
        identityId,
        publicKeyId,
        privateKeyWif,
        onPreorder: onPreorderSuccess
      });

      // Clear cache for this identity
      this.clearCache(undefined, identityId);

      return result;
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