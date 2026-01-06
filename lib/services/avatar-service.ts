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

  constructor() {
    super('avatar');
  }

  protected transformDocument(doc: any): AvatarDocument {
    // SDK v3 may nest content fields under 'data' property
    // Check if doc.data is an object (nested content) or string (actual data field)
    const isNestedFormat = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data);
    const content = isNestedFormat ? doc.data : doc;

    // The 'data' field in avatar document contains JSON string {"seed":"...", "style":"..."}
    const avatarData = isNestedFormat ? content.data : doc.data;

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
   * Get avatar settings for a user
   */
  async getAvatarSettings(ownerId: string): Promise<AvatarSettings | null> {
    // Guard against empty ownerId
    if (!ownerId) {
      console.warn('AvatarService: getAvatarSettings called with empty ownerId');
      return null;
    }

    try {
      // Check cache
      const cached = cacheManager.get<AvatarSettings>(this.AVATAR_CACHE, ownerId);
      if (cached) {
        console.log('AvatarService: Returning cached avatar for:', ownerId);
        return cached;
      }

      console.log('AvatarService: Getting avatar settings for:', ownerId);

      const result = await this.query({
        where: [['$ownerId', '==', ownerId]],
        limit: 1,
      });

      if (result.documents.length === 0) {
        console.log('AvatarService: No avatar found for:', ownerId);
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

      console.log('AvatarService: Returning avatar settings:', settings);
      return settings;
    } catch (error) {
      console.error('AvatarService: Error getting avatar settings:', error);
      return null;
    }
  }

  /**
   * Get avatar URL for a user, falling back to default
   */
  async getAvatarUrl(ownerId: string): Promise<string> {
    // Guard against empty ownerId to prevent seed= URLs
    if (!ownerId) {
      console.warn('AvatarService: getAvatarUrl called with empty ownerId');
      return '';
    }

    try {
      const settings = await this.getAvatarSettings(ownerId);
      if (settings) {
        return settings.avatarUrl;
      }
    } catch (error) {
      console.error('AvatarService: Error getting avatar URL:', error);
    }
    return getDefaultAvatarUrl(ownerId);
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
