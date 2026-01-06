import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { queryDocuments, identifierToBase58 } from './sdk-helpers';
import { getEvoSdk } from './evo-sdk-service';

export interface FollowDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  followingId: string;
}

class FollowService extends BaseDocumentService<FollowDocument> {
  constructor() {
    super('follow');
  }

  /**
   * Transform document
   */
  protected transformDocument(doc: Record<string, unknown>): FollowDocument {
    // Handle both direct properties and nested data structure
    const id = (doc.$id || doc.id) as string;
    const ownerId = (doc.$ownerId || doc.ownerId) as string;
    const createdAt = (doc.$createdAt || doc.createdAt) as number;
    const data = (doc.data || doc) as Record<string, unknown>;

    // SDK v3 toJSON() returns byte array fields as base64 strings
    // Convert to base58 for consistent handling
    const rawFollowingId = data.followingId;
    const followingId = identifierToBase58(rawFollowingId) || String(rawFollowingId);

    return {
      $id: id,
      $ownerId: ownerId,
      $createdAt: createdAt,
      followingId
    };
  }

  /**
   * Follow a user
   */
  async followUser(followerUserId: string, targetUserId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const existing = await this.getFollow(targetUserId, followerUserId);
      if (existing) {
        console.log('Already following user');
        return { success: true };
      }

      const bs58Module = await import('bs58');
      const bs58 = bs58Module.default;
      const followingIdBytes = Array.from(bs58.decode(targetUserId));

      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        followerUserId,
        { followingId: followingIdBytes }
      );

      return result;
    } catch (error) {
      console.error('Error following user:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to follow user'
      };
    }
  }

  /**
   * Unfollow a user
   */
  async unfollowUser(followerUserId: string, targetUserId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const follow = await this.getFollow(targetUserId, followerUserId);
      if (!follow) {
        console.log('Not following user');
        return { success: true };
      }

      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        follow.$id,
        followerUserId
      );

      return result;
    } catch (error) {
      console.error('Error unfollowing user:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unfollow user'
      };
    }
  }

  /**
   * Check if user A follows user B
   */
  async isFollowing(targetUserId: string, followerUserId: string): Promise<boolean> {
    const follow = await this.getFollow(targetUserId, followerUserId);
    return follow !== null;
  }

  /**
   * Get follow relationship
   */
  async getFollow(targetUserId: string, followerUserId: string): Promise<FollowDocument | null> {
    try {
      const result = await this.query({
        where: [
          ['$ownerId', '==', followerUserId],
          ['followingId', '==', targetUserId]
        ],
        limit: 1
      });

      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (error) {
      console.error('Error getting follow:', error);
      return null;
    }
  }

  /**
   * Get followers of a user
   */
  async getFollowers(userId: string, options: QueryOptions = {}): Promise<FollowDocument[]> {
    try {
      const result = await this.query({
        where: [['followingId', '==', userId]],
        orderBy: [['$createdAt', 'asc']],
        limit: 50,
        ...options
      });

      return result.documents;
    } catch (error) {
      console.error('Error getting followers:', error);
      return [];
    }
  }

  /**
   * Get users that a user follows
   */
  async getFollowing(userId: string, options: QueryOptions = {}): Promise<FollowDocument[]> {
    try {
      const result = await this.query({
        where: [['$ownerId', '==', userId]],
        orderBy: [['$createdAt', 'asc']],
        limit: 50,
        ...options
      });

      return result.documents;
    } catch (error) {
      console.error('Error getting following:', error);
      return [];
    }
  }

  /**
   * Count followers - uses queryDocuments helper
   */
  async countFollowers(userId: string): Promise<number> {
    try {
      const sdk = await getEvoSdk();

      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: 'follow',
        where: [
          ['followingId', '==', userId],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['$createdAt', 'asc']],
        limit: 100
      });

      return documents.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error counting followers:', errorMessage, error);
      return 0;
    }
  }

  /**
   * Count following - uses queryDocuments helper
   */
  async countFollowing(userId: string): Promise<number> {
    try {
      const sdk = await getEvoSdk();

      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: 'follow',
        where: [['$ownerId', '==', userId]],
        orderBy: [['$createdAt', 'asc']],
        limit: 100
      });

      return documents.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error counting following:', errorMessage, error);
      return 0;
    }
  }

  /**
   * Check mutual follow (both users follow each other)
   */
  async areMutualFollowers(userId1: string, userId2: string): Promise<boolean> {
    const [follows1to2, follows2to1] = await Promise.all([
      this.isFollowing(userId2, userId1),
      this.isFollowing(userId1, userId2)
    ]);

    return follows1to2 && follows2to1;
  }
}

// Singleton instance
export const followService = new FollowService();
