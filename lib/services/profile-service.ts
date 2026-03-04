import { logger } from '@/lib/logger';
import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import type { DocumentWhereClause, DocumentOrderByClause } from './sdk-helpers';
import { User } from '../../types';
import { dpnsService } from './dpns-service';
import { cacheManager } from '../cache-manager';
import { getDefaultAvatarUrl } from '../mock-data';

export interface ProfileDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  $revision?: number;
  displayName: string;
  bio?: string;
}

class ProfileService extends BaseDocumentService<User> {
  private readonly USERNAME_CACHE = 'usernames';
  private readonly PROFILE_CACHE = 'profiles';

  constructor() {
    super('profile');
  }

  private cachedUsername?: string;

  /**
   * Override query to handle cached username
   */
  async query(options: QueryOptions = {}): Promise<DocumentResult<User>> {
    try {
      const sdk = await getEvoSdk();

      // Build query params for EvoSDK facade
      const queryParams: {
        dataContractId: string;
        documentTypeName: string;
        where?: DocumentWhereClause[];
        orderBy?: DocumentOrderByClause[];
        limit?: number;
        startAfter?: string;
        startAt?: string;
      } = {
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
      };

      if (options.where) {
        queryParams.where = options.where;
      }

      if (options.orderBy) {
        queryParams.orderBy = options.orderBy;
      }

      if (options.limit) {
        queryParams.limit = options.limit;
      }

      if (options.startAfter) {
        queryParams.startAfter = options.startAfter;
      } else if (options.startAt) {
        queryParams.startAt = options.startAt;
      }

      logger.info(`Querying ${this.documentType} documents:`, queryParams);

      // Use EvoSDK documents facade
      const response = await sdk.documents.query(queryParams);

      logger.info(`${this.documentType} query result:`, response);

      // Handle Map response (v3 SDK)
      if (response instanceof Map) {
        const documents: User[] = [];
        const entries = Array.from(response.values());
        for (const doc of entries) {
          if (doc) {
            const d = doc as { toJSON?: () => unknown };
            const docData = typeof d.toJSON === 'function'
              ? d.toJSON()
              : doc;
            documents.push(this.transformDocument(docData as Record<string, unknown>, { cachedUsername: this.cachedUsername }));
          }
        }
        return {
          documents,
          nextCursor: undefined,
          prevCursor: undefined
        };
      }

      // Fallback: handle legacy response formats
      let result: Record<string, unknown> | unknown[] = response as Record<string, unknown>;

      // Handle different response formats
      const respObj = response as { toJSON?: () => unknown };
      if (response && typeof respObj.toJSON === 'function') {
        result = respObj.toJSON() as Record<string, unknown>;
      }

      // Check if result is an array (direct documents response)
      if (Array.isArray(result)) {
        const documents = result.map((doc) => {
          return this.transformDocument(doc as Record<string, unknown>, { cachedUsername: this.cachedUsername });
        });

        return {
          documents,
          nextCursor: undefined,
          prevCursor: undefined
        };
      }

      // Otherwise expect object with documents property
      const resultObj = result as { documents?: unknown[]; nextCursor?: string; prevCursor?: string };
      const documents = resultObj?.documents?.map((doc) => {
        return this.transformDocument(doc as Record<string, unknown>, { cachedUsername: this.cachedUsername });
      }) || [];

      return {
        documents,
        nextCursor: resultObj?.nextCursor,
        prevCursor: resultObj?.prevCursor
      };
    } catch (error) {
      logger.error(`Error querying ${this.documentType} documents:`, error);
      throw error;
    }
  }

  /**
   * Transform document to User type
   * SDK v3: System fields use $ prefix
   */
  protected transformDocument(doc: Record<string, unknown>, options?: Record<string, unknown>): User {
    logger.info('ProfileService: transformDocument input:', doc);
    const profileDoc = doc as unknown as ProfileDocument;
    const cachedUsername = options?.cachedUsername as string | undefined;

    // Handle both $ prefixed (query responses) and non-prefixed (creation responses) fields
    const ownerId = profileDoc.$ownerId || (doc.ownerId as string);
    const createdAt = profileDoc.$createdAt || (doc.createdAt as number);
    const docId = profileDoc.$id || (doc.id as string);
    const revision = profileDoc.$revision || (doc.revision as number);
    const data = (doc.data || doc) as Record<string, unknown>;

    // Return a basic User object - additional data will be loaded separately
    const rawDisplayName = ((data as Record<string, unknown>).displayName as string || '').trim();
    const ownerIdStr = ownerId || 'unknown';
    const user: User = {
      id: ownerIdStr,
      documentId: docId,  // Store document id for updates
      $revision: revision,  // Store revision for updates
      username: cachedUsername || (ownerIdStr.substring(0, 8) + '...'),
      displayName: rawDisplayName || cachedUsername || (ownerIdStr.substring(0, 8) + '...'),
      avatar: getDefaultAvatarUrl(ownerIdStr),
      bio: (data as Record<string, unknown>).bio as string | undefined,
      followers: 0,
      following: 0,
      verified: false,
      joinedAt: new Date(createdAt as number)
    };

    // Queue async operations to enrich the user
    // Skip username resolution if we already have a cached username
    this.enrichUser(user, !!cachedUsername).catch(err => logger.error('Failed to enrich user:', err));

    return user;
  }

  /**
   * Enrich user with async data
   */
  private async enrichUser(user: User, skipUsernameResolution?: boolean): Promise<void> {
    try {
      // Get username from DPNS if not already set and not skipped
      if (!skipUsernameResolution && user.username === user.id.substring(0, 8) + '...') {
        const username = await this.getUsername(user.id);
        if (username) {
          user.username = username;
        }
      }

      // Get follower/following counts
      const stats = await this.getUserStats(user.id);
      user.followers = stats.followers;
      user.following = stats.following;
    } catch (error) {
      logger.error('Error enriching user:', error);
    }
  }

  /**
   * Get profile by owner ID
   */
  async getProfile(ownerId: string, cachedUsername?: string): Promise<User | null> {
    try {
      logger.info('ProfileService: Getting profile for owner ID:', ownerId);

      // Check cache first
      const cached = cacheManager.get<User>(this.PROFILE_CACHE, ownerId);
      if (cached) {
        logger.info('ProfileService: Returning cached profile for:', ownerId);
        // Update username if provided
        if (cachedUsername && cached.username !== cachedUsername) {
          cached.username = cachedUsername;
        }
        return cached;
      }

      // Set cached username for transform
      this.cachedUsername = cachedUsername;

      // Query by owner ID
      const result = await this.query({
        where: [['$ownerId', '==', ownerId]],
        limit: 1
      });

      logger.info('ProfileService: Query result:', result);
      logger.info('ProfileService: Documents found:', result.documents.length);

      if (result.documents.length > 0) {
        const profile = result.documents[0];
        logger.info('ProfileService: Returning profile:', profile);

        // Cache the result with profile and user tags
        cacheManager.set(this.PROFILE_CACHE, ownerId, profile, {
          ttl: 300000, // 5 minutes
          tags: ['profile', `user:${ownerId}`]
        });

        return profile;
      }

      logger.info('ProfileService: No profile found for owner ID:', ownerId);
      return null;
    } catch (error) {
      logger.error('ProfileService: Error getting profile:', error);
      return null;
    } finally {
      // Clear cached username
      this.cachedUsername = undefined;
    }
  }

  /**
   * Get profile by owner ID with username fully resolved (awaited).
   * Use this when you need the username to be available immediately.
   */
  async getProfileWithUsername(ownerId: string): Promise<User | null> {
    try {
      // First resolve the username
      const username = await this.getUsername(ownerId);

      // Then get the profile with the cached username
      const profile = await this.getProfile(ownerId, username || undefined);

      // If profile exists but username wasn't cached, ensure it's set
      if (profile && username) {
        profile.username = username;
      }

      return profile;
    } catch (error) {
      logger.error('ProfileService: Error getting profile with username:', error);
      return this.getProfile(ownerId);
    }
  }

  /**
   * Create user profile
   */
  async createProfile(
    ownerId: string,
    displayName: string,
    bio?: string
  ): Promise<User> {
    const data: Record<string, unknown> = {
      displayName,
      bio: bio || ''
    };

    const result = await this.create(ownerId, data);

    // Invalidate cache for this user
    cacheManager.invalidateByTag(`user:${ownerId}`);

    return result;
  }

  /**
   * Update user profile
   */
  async updateProfile(
    ownerId: string,
    updates: {
      displayName?: string;
      bio?: string;
      location?: string;
      website?: string;
    }
  ): Promise<User | null> {
    try {
      // Invalidate cache first to ensure we get fresh data with current revision
      cacheManager.invalidateByTag(`user:${ownerId}`);

      // Get existing profile
      const profile = await this.getProfile(ownerId);
      if (!profile) {
        throw new Error('Profile not found');
      }

      const data: Record<string, unknown> = {};

      if (updates.displayName !== undefined) {
        data.displayName = updates.displayName.trim();
      }

      // Only include optional fields if they have actual values
      // Empty strings fail schema validation for fields with regex patterns
      if (updates.bio !== undefined && updates.bio.trim() !== '') {
        data.bio = updates.bio.trim();
      }

      if (updates.location !== undefined && updates.location.trim() !== '') {
        data.location = updates.location.trim();
      }

      if (updates.website !== undefined && updates.website.trim() !== '') {
        data.website = updates.website.trim();
      }

      // Update profile document
      const profileDoc = await this.query({
        where: [['$ownerId', '==', ownerId]],
        limit: 1
      });

      if (profileDoc.documents.length > 0) {
        const docId = profileDoc.documents[0].documentId;
        if (!docId) {
          throw new Error('Profile document ID not found');
        }
        const result = await this.update(docId, ownerId, data);

        // Invalidate cache for this user
        cacheManager.invalidateByTag(`user:${ownerId}`);

        return result;
      }

      return null;
    } catch (error) {
      logger.error('Error updating profile:', error);
      throw error;
    }
  }

  /**
   * Get username from DPNS
   */
  private async getUsername(ownerId: string): Promise<string | null> {
    // Check cache
    const cached = cacheManager.get<string>(this.USERNAME_CACHE, ownerId);
    if (cached) {
      return cached;
    }

    try {
      const username = await dpnsService.resolveUsername(ownerId);

      if (username) {
        // Cache the result with user and username tags
        cacheManager.set(this.USERNAME_CACHE, ownerId, username, {
          ttl: 300000, // 5 minutes
          tags: ['username', `user:${ownerId}`]
        });
      }

      return username;
    } catch (error) {
      logger.error('Error resolving username:', error);
      return null;
    }
  }

  /**
   * Get user statistics (followers/following)
   */
  private async getUserStats(_userId: string): Promise<{
    followers: number;
    following: number;
  }> {
    // This would query follow documents
    // For now, return 0s
    return {
      followers: 0,
      following: 0
    };
  }

  /**
   * Get profiles by array of identity IDs
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  async getProfilesByIdentityIds(identityIds: string[]): Promise<ProfileDocument[]> {
    try {
      if (identityIds.length === 0) {
        return [];
      }

      // Filter to only valid base58 identity IDs (32 bytes when decoded)
      // This filters out placeholder values like 'unknown'
      const bs58 = (await import('bs58')).default;
      const validIds = identityIds.filter(id => {
        if (!id || id === 'unknown') return false;
        try {
          const decoded = bs58.decode(id);
          return decoded.length === 32;
        } catch {
          return false;
        }
      });

      if (validIds.length === 0) {
        logger.info('ProfileService: No valid identity IDs to query');
        return [];
      }

      logger.info('ProfileService: Getting profiles for', validIds.length, 'identity IDs');

      const sdk = await getEvoSdk();

      // Query profiles where $ownerId is in the array
      // SDK v3 expects base58 identifier strings for 'in' queries on system fields
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['$ownerId', 'in', validIds]],
        orderBy: [['$ownerId', 'asc']],
        limit: 100
      });

      // Handle Map response (v3 SDK)
      if (response instanceof Map) {
        const documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: unknown) => {
            const d = doc as { toJSON?: () => unknown };
            return (typeof d.toJSON === 'function' ? d.toJSON() : doc) as ProfileDocument;
          });
        logger.info(`ProfileService: Found ${documents.length} profiles`);
        return documents;
      }

      // Handle array response
      const respWithDocs = response as { documents?: ProfileDocument[] };
      if (Array.isArray(response)) {
        logger.info(`ProfileService: Found ${(response as ProfileDocument[]).length} profiles`);
        return response as ProfileDocument[];
      } else if (respWithDocs?.documents) {
        logger.info(`ProfileService: Found ${respWithDocs.documents.length} profiles`);
        return respWithDocs.documents;
      }

      return [];
    } catch (error) {
      logger.error('ProfileService: Error getting profiles by identity IDs:', error);
      return [];
    }
  }
}

// Singleton instance
export const profileService = new ProfileService();

// Import at the bottom to avoid circular dependency
import { getEvoSdk } from './evo-sdk-service';
