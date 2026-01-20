'use client';

/**
 * PrivateFeedKeyStore
 *
 * Local key storage for private feed operations.
 * Handles both owner keys (feed seed) and follower keys (path keys, cached CEK).
 *
 * Storage: localStorage with keys prefixed 'yappr:pf:'
 *
 * See PRD §3.4 for interface specification.
 * See SPEC §6.3 for available leaves derivation.
 */

import type { NodeKey } from './private-feed-crypto-service';

// Storage key prefix as per PRD §3.4
const STORAGE_PREFIX = 'yappr:pf:';

// Storage keys
const KEY_FEED_SEED = 'feed_seed';
const KEY_CURRENT_EPOCH = 'current_epoch';
const KEY_REVOKED_LEAVES = 'revoked_leaves';
const KEY_PATH_KEYS_PREFIX = 'path_keys:';
const KEY_CACHED_CEK_PREFIX = 'cached_cek:';
const KEY_AVAILABLE_LEAVES = 'available_leaves';
const KEY_RECIPIENT_MAP = 'recipient_map';
const KEY_WRAP_NONCE_SALT_PREFIX = 'wrap_nonce_salt:'; // BUG-013 fix: store wrap nonce salt for followers

/**
 * Stored path key with version information
 */
export interface StoredPathKey {
  nodeId: number;
  version: number;
  key: string; // Base64-encoded key bytes
}

/**
 * Cached CEK for a followed feed
 */
export interface CachedCEK {
  epoch: number;
  cek: string; // Base64-encoded CEK bytes
}

/**
 * Recipient to leaf mapping for owner
 */
export interface RecipientLeafMap {
  [recipientId: string]: number; // recipientId -> leafIndex
}

/**
 * Encode Uint8Array to base64 string
 */
function toBase64(bytes: Uint8Array): string {
  // Use btoa with binary string conversion
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode base64 string to Uint8Array
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Check if localStorage is available
 */
function isStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const test = '__storage_test__';
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get item from localStorage with prefix
 */
function getItem(key: string): string | null {
  if (!isStorageAvailable()) return null;
  return localStorage.getItem(STORAGE_PREFIX + key);
}

/**
 * Set item in localStorage with prefix
 */
function setItem(key: string, value: string): void {
  if (!isStorageAvailable()) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch (e) {
    console.error('PrivateFeedKeyStore: Failed to store value:', e);
  }
}

/**
 * Remove item from localStorage with prefix
 */
function removeItem(key: string): void {
  if (!isStorageAvailable()) return;
  localStorage.removeItem(STORAGE_PREFIX + key);
}

/**
 * Get all keys with our prefix
 */
function getAllKeys(): string[] {
  if (!isStorageAvailable()) return [];
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) {
      keys.push(key.slice(STORAGE_PREFIX.length));
    }
  }
  return keys;
}

class PrivateFeedKeyStore {
  // ============================================================
  // Owner Keys
  // ============================================================

  /**
   * Store feed seed for owner
   */
  storeFeedSeed(seed: Uint8Array): void {
    setItem(KEY_FEED_SEED, toBase64(seed));
  }

  /**
   * Get feed seed for owner
   */
  getFeedSeed(): Uint8Array | null {
    const stored = getItem(KEY_FEED_SEED);
    if (!stored) return null;
    try {
      return fromBase64(stored);
    } catch {
      return null;
    }
  }

  /**
   * Check if owner has private feed enabled
   */
  hasFeedSeed(): boolean {
    return this.getFeedSeed() !== null;
  }

  /**
   * Store current epoch
   */
  storeCurrentEpoch(epoch: number): void {
    setItem(KEY_CURRENT_EPOCH, epoch.toString());
  }

  /**
   * Get current epoch (defaults to 1 if not set)
   */
  getCurrentEpoch(): number {
    const stored = getItem(KEY_CURRENT_EPOCH);
    if (!stored) return 1;
    const epoch = parseInt(stored, 10);
    return isNaN(epoch) ? 1 : epoch;
  }

  /**
   * Store revoked leaves list (ordered by revocation time)
   */
  storeRevokedLeaves(leaves: number[]): void {
    setItem(KEY_REVOKED_LEAVES, JSON.stringify(leaves));
  }

  /**
   * Get revoked leaves list
   */
  getRevokedLeaves(): number[] {
    const stored = getItem(KEY_REVOKED_LEAVES);
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Add a revoked leaf to the list (appends to maintain order)
   */
  addRevokedLeaf(leafIndex: number): void {
    const current = this.getRevokedLeaves();
    current.push(leafIndex);
    this.storeRevokedLeaves(current);
  }

  /**
   * Store available leaves bitmap (as array of available leaf indices)
   * Note: This is a cache; authoritative source is grants (SPEC §6.3)
   */
  storeAvailableLeaves(availableIndices: number[]): void {
    setItem(KEY_AVAILABLE_LEAVES, JSON.stringify(availableIndices));
  }

  /**
   * Get available leaves
   */
  getAvailableLeaves(): number[] | null {
    const stored = getItem(KEY_AVAILABLE_LEAVES);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Mark a leaf as unavailable (assigned)
   */
  markLeafUnavailable(leafIndex: number): void {
    const available = this.getAvailableLeaves();
    if (!available) return;
    const updated = available.filter((i) => i !== leafIndex);
    this.storeAvailableLeaves(updated);
  }

  /**
   * Mark a leaf as available (revoked)
   */
  markLeafAvailable(leafIndex: number): void {
    const available = this.getAvailableLeaves();
    if (!available) return;
    if (!available.includes(leafIndex)) {
      available.push(leafIndex);
      available.sort((a, b) => a - b);
      this.storeAvailableLeaves(available);
    }
  }

  /**
   * Get next available leaf index (or null if full)
   */
  getNextAvailableLeaf(): number | null {
    const available = this.getAvailableLeaves();
    if (!available || available.length === 0) return null;
    return available[0];
  }

  /**
   * Store recipient to leaf mapping
   */
  storeRecipientMap(map: RecipientLeafMap): void {
    setItem(KEY_RECIPIENT_MAP, JSON.stringify(map));
  }

  /**
   * Get recipient to leaf mapping
   */
  getRecipientMap(): RecipientLeafMap {
    const stored = getItem(KEY_RECIPIENT_MAP);
    if (!stored) return {};
    try {
      return JSON.parse(stored);
    } catch {
      return {};
    }
  }

  /**
   * Add recipient to leaf mapping
   */
  addRecipientMapping(recipientId: string, leafIndex: number): void {
    const map = this.getRecipientMap();
    map[recipientId] = leafIndex;
    this.storeRecipientMap(map);
  }

  /**
   * Remove recipient mapping
   */
  removeRecipientMapping(recipientId: string): void {
    const map = this.getRecipientMap();
    delete map[recipientId];
    this.storeRecipientMap(map);
  }

  /**
   * Get leaf index for a recipient
   */
  getLeafForRecipient(recipientId: string): number | undefined {
    const map = this.getRecipientMap();
    return map[recipientId];
  }

  // ============================================================
  // Follower Keys (per feed owner)
  // ============================================================

  /**
   * Store path keys for a followed feed
   */
  storePathKeys(ownerId: string, pathKeys: NodeKey[]): void {
    const stored: StoredPathKey[] = pathKeys.map((pk) => ({
      nodeId: pk.nodeId,
      version: pk.version,
      key: toBase64(pk.key),
    }));
    setItem(KEY_PATH_KEYS_PREFIX + ownerId, JSON.stringify(stored));
  }

  /**
   * Get path keys for a followed feed
   */
  getPathKeys(ownerId: string): NodeKey[] | null {
    const stored = getItem(KEY_PATH_KEYS_PREFIX + ownerId);
    if (!stored) return null;
    try {
      const parsed: StoredPathKey[] = JSON.parse(stored);
      return parsed.map((pk) => ({
        nodeId: pk.nodeId,
        version: pk.version,
        key: fromBase64(pk.key),
      }));
    } catch {
      return null;
    }
  }

  /**
   * Check if we have path keys for a feed
   */
  hasPathKeys(ownerId: string): boolean {
    return this.getPathKeys(ownerId) !== null;
  }

  /**
   * Update specific path keys (after applying rekey)
   */
  updatePathKeys(ownerId: string, updatedKeys: Map<number, NodeKey>): void {
    const current = this.getPathKeys(ownerId);
    if (!current) return;

    const updated = current.map((pk) => {
      const newKey = updatedKeys.get(pk.nodeId);
      return newKey || pk;
    });

    this.storePathKeys(ownerId, updated);
  }

  /**
   * Store cached CEK for a followed feed
   */
  storeCachedCEK(ownerId: string, epoch: number, cek: Uint8Array): void {
    const cached: CachedCEK = {
      epoch,
      cek: toBase64(cek),
    };
    setItem(KEY_CACHED_CEK_PREFIX + ownerId, JSON.stringify(cached));
  }

  /**
   * Get cached CEK for a followed feed
   */
  getCachedCEK(ownerId: string): { epoch: number; cek: Uint8Array } | null {
    const stored = getItem(KEY_CACHED_CEK_PREFIX + ownerId);
    if (!stored) return null;
    try {
      const cached: CachedCEK = JSON.parse(stored);
      return {
        epoch: cached.epoch,
        cek: fromBase64(cached.cek),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get cached epoch for a feed (or null if not cached)
   */
  getCachedEpoch(ownerId: string): number | null {
    const cached = this.getCachedCEK(ownerId);
    return cached ? cached.epoch : null;
  }

  /**
   * Store wrap nonce salt for a followed feed (BUG-013 fix)
   * This is needed to apply rekey documents
   */
  storeWrapNonceSalt(ownerId: string, salt: Uint8Array): void {
    setItem(KEY_WRAP_NONCE_SALT_PREFIX + ownerId, toBase64(salt));
  }

  /**
   * Get wrap nonce salt for a followed feed (BUG-013 fix)
   */
  getWrapNonceSalt(ownerId: string): Uint8Array | null {
    const stored = getItem(KEY_WRAP_NONCE_SALT_PREFIX + ownerId);
    if (!stored) return null;
    try {
      return fromBase64(stored);
    } catch {
      return null;
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Clear all keys for a specific followed feed
   */
  clearFeedKeys(ownerId: string): void {
    removeItem(KEY_PATH_KEYS_PREFIX + ownerId);
    removeItem(KEY_CACHED_CEK_PREFIX + ownerId);
    removeItem(KEY_WRAP_NONCE_SALT_PREFIX + ownerId); // BUG-013 fix
  }

  /**
   * Clear all owner keys (used when disabling private feed)
   */
  clearOwnerKeys(): void {
    removeItem(KEY_FEED_SEED);
    removeItem(KEY_CURRENT_EPOCH);
    removeItem(KEY_REVOKED_LEAVES);
    removeItem(KEY_AVAILABLE_LEAVES);
    removeItem(KEY_RECIPIENT_MAP);
  }

  /**
   * Clear all private feed keys (owner and all followed feeds)
   */
  clearAllKeys(): void {
    const allKeys = getAllKeys();
    for (const key of allKeys) {
      removeItem(key);
    }
  }

  /**
   * Get list of all feed owners we have keys for
   */
  getFollowedFeedOwners(): string[] {
    const allKeys = getAllKeys();
    const owners: string[] = [];
    const prefix = KEY_PATH_KEYS_PREFIX;
    for (const key of allKeys) {
      if (key.startsWith(prefix)) {
        owners.push(key.slice(prefix.length));
      }
    }
    return owners;
  }

  // ============================================================
  // Initialization Helpers
  // ============================================================

  /**
   * Initialize owner state with all available leaves (for new feed)
   */
  initializeOwnerState(seed: Uint8Array, treeCapacity: number = 1024): void {
    this.storeFeedSeed(seed);
    this.storeCurrentEpoch(1);
    this.storeRevokedLeaves([]);
    this.storeRecipientMap({});

    // All leaves available initially
    const allAvailable: number[] = [];
    for (let i = 0; i < treeCapacity; i++) {
      allAvailable.push(i);
    }
    this.storeAvailableLeaves(allAvailable);
  }

  /**
   * Initialize follower state from grant payload
   * BUG-013 fix: Added optional wrapNonceSalt parameter to enable rekey support
   */
  initializeFollowerState(
    ownerId: string,
    pathKeys: NodeKey[],
    grantEpoch: number,
    currentCEK: Uint8Array,
    wrapNonceSalt?: Uint8Array
  ): void {
    this.storePathKeys(ownerId, pathKeys);
    this.storeCachedCEK(ownerId, grantEpoch, currentCEK);
    if (wrapNonceSalt) {
      this.storeWrapNonceSalt(ownerId, wrapNonceSalt);
    }
  }

  /**
   * Check if storage is available
   */
  isAvailable(): boolean {
    return isStorageAvailable();
  }
}

// Export singleton instance
export const privateFeedKeyStore = new PrivateFeedKeyStore();

// Export class for testing
export { PrivateFeedKeyStore };
