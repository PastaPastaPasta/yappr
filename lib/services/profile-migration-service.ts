import { profileService } from './profile-service';
import { unifiedProfileService } from './unified-profile-service';
import { YAPPR_CONTRACT_ID } from '../constants';

// Legacy profile data structure (from old contract)
export interface LegacyProfileData {
  displayName: string;
  bio?: string;
  location?: string;
  website?: string;
  avatarId?: string;  // Reference to old avatar document
}

// Legacy avatar data structure
export interface LegacyAvatarData {
  style: string;
  seed: string;
}

export type MigrationStatus = 'migrated' | 'needs_migration' | 'no_profile';

class ProfileMigrationService {
  /**
   * Check migration status for a user.
   * Returns:
   * - 'migrated': Has new unified profile
   * - 'needs_migration': Has old profile but no new profile
   * - 'no_profile': No profile at all
   */
  async getMigrationStatus(ownerId: string): Promise<MigrationStatus> {
    try {
      // Check for new unified profile first
      const unifiedProfile = await unifiedProfileService.getProfile(ownerId);
      if (unifiedProfile) {
        return 'migrated';
      }

      // Check for old profile
      const oldProfile = await profileService.getProfile(ownerId);
      if (oldProfile) {
        return 'needs_migration';
      }

      return 'no_profile';
    } catch (error) {
      console.error('ProfileMigrationService: Error checking migration status:', error);
      return 'no_profile';
    }
  }

  /**
   * Get old profile data for pre-filling migration form.
   */
  async getOldProfileData(ownerId: string): Promise<LegacyProfileData | null> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Query old profile directly from old contract
      const response = await sdk.documents.query({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'profile',
        where: [['$ownerId', '==', ownerId]],
        limit: 1
      } as any);

      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if (response && (response as any).documents) {
        documents = (response as any).documents;
      }

      if (documents.length === 0) {
        return null;
      }

      const doc = documents[0];
      const data = doc.data || doc;

      // Extract avatar ID if present (it's a 32-byte array in the old format)
      let avatarIdStr: string | undefined;
      if (data.avatarId) {
        try {
          const bs58 = (await import('bs58')).default;
          if (Array.isArray(data.avatarId)) {
            avatarIdStr = bs58.encode(new Uint8Array(data.avatarId));
          } else if (data.avatarId instanceof Uint8Array) {
            avatarIdStr = bs58.encode(data.avatarId);
          }
        } catch {
          // Ignore avatar ID parsing errors
        }
      }

      return {
        displayName: data.displayName || '',
        bio: data.bio,
        location: data.location,
        website: data.website,
        avatarId: avatarIdStr,
      };
    } catch (error) {
      console.error('ProfileMigrationService: Error getting old profile data:', error);
      return null;
    }
  }

  /**
   * Get old avatar data for migration (from old avatar document).
   *
   * Old avatar contract schema:
   * - data: string (the seed/feature data, 16-128 chars)
   * - style: enum (realistic, cartoon, anime, pixel)
   * - version: integer (1-10)
   */
  async getOldAvatarData(ownerId: string): Promise<LegacyAvatarData | null> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Query old avatar document from old contract
      const response = await sdk.documents.query({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'avatar',
        where: [['$ownerId', '==', ownerId]],
        limit: 1
      } as any);

      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if (response && (response as any).documents) {
        documents = (response as any).documents;
      }

      if (documents.length === 0) {
        return null;
      }

      const doc = documents[0];

      // Avatar documents have a field named 'data', so we can't use the usual
      // doc.data || doc pattern. Check for system fields to determine structure.
      const avatarDoc = (doc.$ownerId || doc.$id) ? doc :
        (doc.data && typeof doc.data === 'object' && doc.data.$ownerId) ? doc.data : doc;

      const dataField = avatarDoc.data;
      const docStyle = avatarDoc.style;

      // Map old style enum to DiceBear styles (fallback for non-JSON data)
      const oldStyleToDiceBear: Record<string, string> = {
        'realistic': 'avataaars',
        'cartoon': 'fun-emoji',
        'anime': 'lorelei',
        'pixel': 'pixel-art',
      };

      if (dataField && typeof dataField === 'string') {
        // Try to parse as JSON (format: {"seed":"...","style":"avataaars"})
        try {
          const parsed = JSON.parse(dataField);
          if (parsed.seed) {
            return {
              seed: parsed.seed,
              style: parsed.style || 'thumbs',
            };
          }
        } catch {
          // Not JSON, treat as raw seed string
        }

        // Fallback: treat data as raw seed, map document's style field
        return {
          seed: dataField,
          style: oldStyleToDiceBear[docStyle] || 'thumbs',
        };
      }

      return null;
    } catch (error) {
      console.error('ProfileMigrationService: Error getting old avatar data:', error);
      return null;
    }
  }

  /**
   * Get combined old profile and avatar data for migration form pre-fill.
   */
  async getOldDataForMigration(ownerId: string): Promise<{
    profile: LegacyProfileData | null;
    avatar: LegacyAvatarData | null;
  }> {
    const [profile, avatar] = await Promise.all([
      this.getOldProfileData(ownerId),
      this.getOldAvatarData(ownerId),
    ]);

    return { profile, avatar };
  }
}

// Singleton instance
export const profileMigrationService = new ProfileMigrationService();
