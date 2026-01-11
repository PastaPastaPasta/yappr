import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { cacheManager } from '../cache-manager';
import {
  DiceBearStyle,
  DEFAULT_STYLE,
  parseAvatarData,
  encodeAvatarData,
  getAvatarUrl,
  getDefaultAvatarUrl,
} from '../avatar-utils';

// Contract style enum fallback - the contract's style enum ["realistic", "cartoon", "anime", "pixel"]
// doesn't match DiceBear's actual style names, so we use a generic fallback and store the
// actual DiceBear style in the 'data' field as JSON: {"seed":"...", "style":"bottts"}
const CONTRACT_STYLE_FALLBACK = 'cartoon' as const;

export interface AvatarDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  $revision?: number;
  version: number;
  data: string;
  style?: 'realistic' | 'cartoon' | 'anime' | 'pixel';
}

export interface AvatarSettings {
  style: DiceBearStyle;
  seed: string;
  avatarUrl: string;
}

class AvatarService extends BaseDocumentService<AvatarDocument> {
  private readonly AVATAR_CACHE = 'avatars';

  // DataLoader-style batching: all avatar requests are queued and processed together
  private pendingRequests = new Map<string, {
    resolvers: Array<(url: string) => void>;
  }>();

  constructor() {
    super('avatar');
  }

  private batchTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedule batch processing with debounce.
   * Waits 5ms for more requests to accumulate, ensuring all requests
   * from React render cycles get batched together.
   */
  private scheduleBatch() {
    // Clear existing timeout to debounce
    if (this.batchTimeout !== null) {
      clearTimeout(this.batchTimeout);
    }

    // Wait 5ms for more requests to accumulate
    this.batchTimeout = setTimeout(() => {
      this.batchTimeout = null;
      this.processBatch();
    }, 5);
  }

  /**
   * Process all pending avatar requests in a single batch query.
   */
  private async processBatch() {
    // Snapshot and clear pending requests
    const batch = new Map(this.pendingRequests);
    this.pendingRequests.clear();

    if (batch.size === 0) return;

    const userIds = Array.from(batch.keys());

    try {
      const results = await this.fetchAvatarUrlsBatch(userIds);

      // Resolve all pending promises
      Array.from(batch.entries()).forEach(([userId, { resolvers }]) => {
        const url = results.get(userId) || getDefaultAvatarUrl(userId);
        resolvers.forEach(resolve => resolve(url));
      });
    } catch (error) {
      // On error, resolve with defaults
      Array.from(batch.entries()).forEach(([userId, { resolvers }]) => {
        const url = getDefaultAvatarUrl(userId);
        resolvers.forEach(resolve => resolve(url));
      });
    }
  }

  /**
   * Transform document
   * SDK v3: System fields use $ prefix, content may be nested under 'data' property
   */
  protected transformDocument(doc: any): AvatarDocument {
    // SDK v3 may nest content fields under 'data' property
    // Check if doc.data is an object (nested content) or string (actual data field)
    const isNestedFormat = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data);
    const content = isNestedFormat ? doc.data : doc;

    // The 'data' field in avatar document contains JSON string {"seed":"...", "style":"..."}
    const avatarData = isNestedFormat ? content.data : doc.data;

    // Handle both $ prefixed (query responses) and non-prefixed (creation responses) fields
    return {
      $id: doc.$id || doc.id,
      $ownerId: doc.$ownerId || doc.ownerId,
      $createdAt: doc.$createdAt || doc.createdAt,
      $updatedAt: doc.$updatedAt || doc.updatedAt,
      $revision: doc.$revision || doc.revision,
      version: content.version || 1,
      data: typeof avatarData === 'string' ? avatarData : '',
      style: content.style,
    };
  }

  /**
   * Get avatar settings for a user.
   * Note: For deduplication, use getAvatarUrl() instead which coordinates with batch requests.
   */
  async getAvatarSettings(ownerId: string): Promise<AvatarSettings | null> {
    // Guard against empty ownerId
    if (!ownerId) {
      console.warn('AvatarService: getAvatarSettings called with empty ownerId');
      return null;
    }

    // Check cache first
    const cached = cacheManager.get<AvatarSettings>(this.AVATAR_CACHE, ownerId);
    if (cached) {
      return cached;
    }

    return this.fetchAvatarSettings(ownerId);
  }

  private async fetchAvatarSettings(ownerId: string): Promise<AvatarSettings | null> {
    try {
      const result = await this.query({
        where: [['$ownerId', '==', ownerId]],
        limit: 1,
      });

      if (result.documents.length === 0) {
        return null;
      }

      const doc = result.documents[0];
      const parsed = parseAvatarData(doc.data);

      // Guard against empty seed - fall back to ownerId if seed is empty
      const seed = parsed.seed || ownerId;

      const settings: AvatarSettings = {
        style: parsed.style,
        seed: seed,
        avatarUrl: getAvatarUrl({ style: parsed.style, seed: seed }),
      };

      // Cache result
      cacheManager.set(this.AVATAR_CACHE, ownerId, settings, {
        ttl: 300000, // 5 minutes
        tags: ['avatar', `user:${ownerId}`],
      });

      return settings;
    } catch (error) {
      console.error('AvatarService: Error getting avatar settings:', error);
      return null;
    }
  }

  /**
   * Get avatar URL for a user, falling back to default.
   * Uses DataLoader-style batching - all requests from the same event loop tick
   * are automatically batched into a single query.
   */
  async getAvatarUrl(ownerId: string): Promise<string> {
    // Guard against empty ownerId to prevent seed= URLs
    if (!ownerId) {
      console.warn('AvatarService: getAvatarUrl called with empty ownerId');
      return '';
    }

    // Check cache first
    const cached = cacheManager.get<AvatarSettings>(this.AVATAR_CACHE, ownerId);
    if (cached) {
      return cached.avatarUrl;
    }

    // Add to pending batch and return promise
    return new Promise((resolve) => {
      const existing = this.pendingRequests.get(ownerId);
      if (existing) {
        // Already have a pending request for this user, add our resolver
        existing.resolvers.push(resolve);
      } else {
        // New request for this user
        this.pendingRequests.set(ownerId, { resolvers: [resolve] });
      }
      this.scheduleBatch();
    });
  }

  /**
   * Batch get avatar URLs for multiple users.
   * Uses DataLoader-style batching - calls getAvatarUrl for each which
   * automatically batches all requests from the same event loop tick.
   * @returns Map of userId -> avatarUrl
   */
  async getAvatarUrlsBatch(userIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    if (userIds.length === 0) return result;

    // Call getAvatarUrl for each - they'll all be batched together automatically
    const promises = userIds.filter(id => !!id).map(async (userId) => {
      const url = await this.getAvatarUrl(userId);
      result.set(userId, url);
    });

    await Promise.all(promises);
    return result;
  }

  private async fetchAvatarUrlsBatch(uncachedIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Batch query using 'in' operator
      // Dash Platform requires orderBy on the 'in' field
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'avatar',
        where: [['$ownerId', 'in', uncachedIds]],
        orderBy: [['$ownerId', 'asc']],
        limit: uncachedIds.length
      } as any);

      // Handle Map response (v3 SDK)
      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if (response && (response as any).documents) {
        documents = (response as any).documents;
      } else if (response && typeof (response as any).toJSON === 'function') {
        const json = (response as any).toJSON();
        documents = Array.isArray(json) ? json : json.documents || [];
      }

      // Process results and cache them
      const foundUserIds = new Set<string>();
      for (const doc of documents) {
        const avatarDoc = this.transformDocument(doc);
        const parsed = parseAvatarData(avatarDoc.data);
        const seed = parsed.seed || avatarDoc.$ownerId;

        const settings: AvatarSettings = {
          style: parsed.style,
          seed: seed,
          avatarUrl: getAvatarUrl({ style: parsed.style, seed: seed }),
        };

        result.set(avatarDoc.$ownerId, settings.avatarUrl);
        foundUserIds.add(avatarDoc.$ownerId);

        // Cache for future use
        cacheManager.set(this.AVATAR_CACHE, avatarDoc.$ownerId, settings, {
          ttl: 300000, // 5 minutes
          tags: ['avatar', `user:${avatarDoc.$ownerId}`],
        });
      }

      // For users without custom avatars, use default
      for (const userId of uncachedIds) {
        if (!foundUserIds.has(userId)) {
          result.set(userId, getDefaultAvatarUrl(userId));
        }
      }

    } catch (error) {
      console.error('AvatarService: Error getting batch avatar URLs:', error);
      // Fall back to default avatars for all uncached
      for (const userId of uncachedIds) {
        if (!result.has(userId)) {
          result.set(userId, getDefaultAvatarUrl(userId));
        }
      }
    }

    return result;
  }

  /**
   * Create or update avatar settings
   */
  async saveAvatarSettings(
    ownerId: string,
    style: DiceBearStyle,
    seed: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('AvatarService: Saving avatar settings for:', ownerId, { style, seed });

      const data = encodeAvatarData(seed, style);

      // Check if avatar document exists
      const existing = await this.query({
        where: [['$ownerId', '==', ownerId]],
        limit: 1,
      });

      if (existing.documents.length > 0) {
        // Update existing
        const doc = existing.documents[0];
        console.log('AvatarService: Updating existing avatar document:', doc.$id);

        const result = await stateTransitionService.updateDocument(
          this.contractId,
          this.documentType,
          doc.$id,
          ownerId,
          { version: 1, data, style: CONTRACT_STYLE_FALLBACK },
          doc.$revision || 0
        );

        if (!result.success) {
          console.error('AvatarService: Failed to update avatar:', result.error);
          return { success: false, error: result.error };
        }
      } else {
        // Create new
        console.log('AvatarService: Creating new avatar document');

        const result = await stateTransitionService.createDocument(
          this.contractId,
          this.documentType,
          ownerId,
          { version: 1, data, style: CONTRACT_STYLE_FALLBACK }
        );

        if (!result.success) {
          console.error('AvatarService: Failed to create avatar:', result.error);
          return { success: false, error: result.error };
        }
      }

      // Invalidate cache - wrapped in try-catch to prevent silent failures
      try {
        cacheManager.invalidateByTag(`user:${ownerId}`);
        cacheManager.delete(this.AVATAR_CACHE, ownerId);
      } catch (cacheError) {
        console.error('AvatarService: Cache invalidation failed:', cacheError);
        // Continue anyway - cache will expire naturally
      }

      console.log('AvatarService: Avatar settings saved successfully');
      return { success: true };
    } catch (error) {
      console.error('AvatarService: Error saving avatar settings:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// Singleton instance
export const avatarService = new AvatarService();
