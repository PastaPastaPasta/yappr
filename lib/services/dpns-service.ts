import { getWasmSdk } from './wasm-sdk-service';
// Import WasmSdk for static DPNS utility methods
import { WasmSdk } from '@dashevo/wasm-sdk';
import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE } from '../constants';

// Helper wrappers for DPNS utility functions (using WasmSdk static methods)
const dpns_is_valid_username = (label: string): boolean => WasmSdk.dpnsIsValidUsername(label);
const dpns_is_contested_username = (label: string): boolean => WasmSdk.dpnsIsContestedUsername(label);
const dpns_convert_to_homograph_safe = (input: string): string => WasmSdk.dpnsConvertToHomographSafe(input);

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
      
      const sdk = await getWasmSdk();

      // Try the dedicated DPNS usernames function first
      try {
        const response = await sdk.dpns.usernames(identityId, { limit: 20 });

        console.log('DPNS: Usernames response:', response);

        // Parse the response
        let usernames: string[] = [];

        if (Array.isArray(response)) {
          usernames = response.filter(u => typeof u === 'string' && u.length > 0);
        } else if (response && typeof response === 'object' && response.usernames) {
          usernames = response.usernames;
        } else if (response && typeof response.toJSON === 'function') {
          const jsonResponse = response.toJSON();
          if (Array.isArray(jsonResponse)) {
            usernames = jsonResponse.filter(u => typeof u === 'string' && u.length > 0);
          } else if (jsonResponse && jsonResponse.usernames) {
            usernames = jsonResponse.usernames;
          }
        }

        if (usernames.length > 0) {
          console.log(`DPNS: Found ${usernames.length} usernames for identity ${identityId}`);
          return usernames;
        }
      } catch (error) {
        console.warn('DPNS: sdk.dpns.usernames failed, trying document query:', error);
      }

      // Fallback: Query DPNS documents by identity ID
      const response = await sdk.documents.query({
        contractId: DPNS_CONTRACT_ID,
        type: DPNS_DOCUMENT_TYPE,
        where: [['records.identity', '==', identityId]],
        limit: 20
      });
      
      if (response && response.documents && response.documents.length > 0) {
        const usernames = response.documents.map((doc: DpnsDocument) => 
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
  sortUsernamesByContested(usernames: string[]): string[] {
    return usernames.sort((a, b) => {
      const aContested = dpns_is_contested_username(a.split('.')[0]);
      const bContested = dpns_is_contested_username(b.split('.')[0]);
      
      if (aContested && !bContested) return -1;
      if (!aContested && bContested) return 1;
      
      // If both contested or both not contested, sort alphabetically
      return a.localeCompare(b);
    });
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
      const sortedUsernames = this.sortUsernamesByContested(allUsernames);
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
      const normalizedUsername = username.toLowerCase().replace('.dash', '');
      
      // Check cache
      const cached = this.cache.get(normalizedUsername);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        console.log(`DPNS: Returning cached identity for ${normalizedUsername}: ${cached.value}`);
        return cached.value;
      }

      console.log(`DPNS: Resolving identity for username: ${normalizedUsername}`);
      
      const sdk = await getWasmSdk();

      // Try native resolution first using EvoSDK facade
      try {
        const result = await sdk.dpns.resolveName(normalizedUsername);
        if (result && result.identity_id) {
          console.log(`DPNS: Found identity ${result.identity_id} for username ${normalizedUsername} via native resolver`);
          this._cacheEntry(normalizedUsername, result.identity_id);
          return result.identity_id;
        }
      } catch (error) {
        console.warn('DPNS: Native resolver failed, trying document query:', error);
      }

      // Fallback: Query DPNS documents
      const parts = normalizedUsername.split('.');
      const label = parts[0];
      const parentDomain = parts.slice(1).join('.') || 'dash';

      const response = await sdk.documents.query({
        contractId: DPNS_CONTRACT_ID,
        type: DPNS_DOCUMENT_TYPE,
        where: [
          ['normalizedLabel', '==', label.toLowerCase()],
          ['normalizedParentDomainName', '==', parentDomain.toLowerCase()]
        ],
        limit: 1
      });
      
      if (response && response.documents && response.documents.length > 0) {
        const dpnsDoc = response.documents[0] as DpnsDocument;
        const identityId = dpnsDoc.records.identity || dpnsDoc.records.dashUniqueIdentityId || dpnsDoc.records.dashAliasIdentityId;
        
        if (identityId) {
          console.log(`DPNS: Found identity ${identityId} for username ${normalizedUsername} via document query`);
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
        const sdk = await getWasmSdk();
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
      const sdk = await getWasmSdk();
      
      // Remove .dash suffix if present for search
      const searchPrefix = prefix.toLowerCase().replace(/\.dash$/, '');
      
      // Search DPNS names by prefix
      console.log(`DPNS: Searching usernames with prefix: ${searchPrefix}`);
      
      // Build where clause for starts-with query on normalizedLabel
      const where = [
        ['normalizedLabel', 'startsWith', searchPrefix],
        ['normalizedParentDomainName', '==', 'dash']
      ];
      const orderBy = [['normalizedLabel', 'asc']];

      const documents = await sdk.documents.query({
        contractId: DPNS_CONTRACT_ID,
        type: DPNS_DOCUMENT_TYPE,
        where,
        orderBy,
        limit
      });

      // The response is an array of documents
      if (documents && Array.isArray(documents)) {
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
      const sdk = await getWasmSdk();

      // Remove .dash suffix if present for search
      const searchPrefix = prefix.toLowerCase().replace(/\.dash$/, '');

      // Search DPNS names by prefix
      console.log(`DPNS: Searching usernames with prefix: ${searchPrefix}`);
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

      const documents = await sdk.documents.query({
        contractId: DPNS_CONTRACT_ID,
        type: DPNS_DOCUMENT_TYPE,
        where,
        orderBy,
        limit
      });

      console.log('DPNS: Search response:', documents);
      console.log('DPNS: Response type:', typeof documents);
      console.log('DPNS: Is array?:', Array.isArray(documents));
      
      // The response is an array of documents
      if (documents && Array.isArray(documents)) {
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
      // Validate the username first
      if (!dpns_is_valid_username(label)) {
        throw new Error(`Invalid username format: ${label}`);
      }

      // Check if it's contested
      if (dpns_is_contested_username(label)) {
        console.warn(`Username ${label} is contested and will require masternode voting`);
      }

      // Check availability
      const sdk = await getWasmSdk();
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
  validateUsername(label: string): {
    isValid: boolean;
    isContested: boolean;
    normalizedLabel: string;
  } {
    const isValid = dpns_is_valid_username(label);
    const isContested = dpns_is_contested_username(label);
    const normalizedLabel = dpns_convert_to_homograph_safe(label);

    return {
      isValid,
      isContested,
      normalizedLabel
    };
  }

  /**
   * Get username validation error message
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
    
    // Additional DPNS validation
    const validation = this.validateUsername(username);
    if (!validation.isValid) {
      return 'Username does not meet DPNS requirements';
    }
    
    if (validation.isContested) {
      return 'This username is contested and requires masternode voting';
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