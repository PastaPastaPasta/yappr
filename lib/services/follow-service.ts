import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { stringToIdentifierBytes, RequestDeduplicator, transformDocumentWithField, normalizeSDKResponse } from './sdk-helpers';
import { getEvoSdk } from './evo-sdk-service';
import { paginateCount, paginateFetchAll } from './pagination-utils';

export interface FollowDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  followingId: string;
}

class FollowService extends BaseDocumentService<FollowDocument> {
  // Request deduplicators for batch operations
  private followingDeduplicator = new RequestDeduplicator<string, string[]>();
  private countFollowersDeduplicator = new RequestDeduplicator<string, number>();
  private countFollowingDeduplicator = new RequestDeduplicator<string, number>();

  constructor() {
    super('follow');
  }

  protected transformDocument(doc: Record<string, unknown>): FollowDocument {
    return transformDocumentWithField<FollowDocument>(doc, 'followingId', 'FollowService');
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

      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        followerUserId,
        { followingId: stringToIdentifierBytes(targetUserId) }
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
   * Check if user A follows user B.
   * Uses getFollowingIds() which deduplicates in-flight requests,
   * so multiple calls share 1 network request.
   */
  async isFollowing(targetUserId: string, followerUserId: string): Promise<boolean> {
    if (!followerUserId || !targetUserId) return false;
    const followingIds = await this.getFollowingIds(followerUserId);
    return followingIds.includes(targetUserId);
  }

  /**
   * Get follow relationship
   */
  async getFollow(targetUserId: string, followerUserId: string): Promise<FollowDocument | null> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'follow',
        where: [
          ['$ownerId', '==', followerUserId],
          ['followingId', '==', stringToIdentifierBytes(targetUserId)]
        ],
        limit: 1
      });

      const documents = normalizeSDKResponse(response);
      return documents.length > 0 ? this.transformDocument(documents[0]) : null;
    } catch (error) {
      console.error('Error getting follow:', error);
      return null;
    }
  }

  /**
   * Get followers of a user.
   * Paginates through all results to return complete list.
   */
  async getFollowers(userId: string): Promise<FollowDocument[]> {
    try {
      const sdk = await getEvoSdk();
      const userIdBytes = stringToIdentifierBytes(userId);

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'follow',
          where: [
            ['followingId', '==', userIdBytes],
            ['$createdAt', '>', 0]
          ],
          // Use followers index: [followingId, $createdAt] - must include all index fields in orderBy
          orderBy: [['followingId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      console.error('Error getting followers:', error);
      return [];
    }
  }

  /**
   * Get users that a user follows.
   * Paginates through all results to return complete list.
   */
  async getFollowing(userId: string): Promise<FollowDocument[]> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'follow',
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          // Use following index: [$ownerId, $createdAt] - must include all index fields in orderBy
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      console.error('Error getting following:', error);
      return [];
    }
  }

  /**
   * Get array of following user IDs.
   * Paginates through all results for complete list.
   * Deduplicates in-flight requests: if called multiple times before the first
   * request completes, all callers share the same promise/network request.
   */
  async getFollowingIds(userId: string): Promise<string[]> {
    if (!userId) return [];

    return this.followingDeduplicator.dedupe(userId, async () => {
      const following = await this.getFollowing(userId);
      return following.map(f => f.followingId);
    });
  }

  /**
   * Batch check if the current user follows any of the target users.
   * Efficient: reuses getFollowingIds (1 query, deduplicated) then does Set intersection.
   * @returns Map of targetUserId -> isFollowing
   */
  async getFollowStatusBatch(targetUserIds: string[], followerId: string): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();

    // Initialize all as not following
    for (const id of targetUserIds) {
      result.set(id, false);
    }

    if (!followerId || targetUserIds.length === 0) {
      return result;
    }

    try {
      // Get all users this user follows (1 query, deduplicated)
      const followingIds = await this.getFollowingIds(followerId);
      const followingSet = new Set(followingIds);

      // Check each target against the following set
      for (const targetId of targetUserIds) {
        result.set(targetId, followingSet.has(targetId));
      }
    } catch (error) {
      console.error('Error getting batch follow status:', error);
    }

    return result;
  }

  /**
   * Count followers.
   * Paginates through all results for accurate count.
   * Deduplicates in-flight requests.
   */
  async countFollowers(userId: string): Promise<number> {
    return this.countFollowersDeduplicator.dedupe(userId, async () => {
      try {
        const sdk = await getEvoSdk();
        const userIdBytes = stringToIdentifierBytes(userId);

        const { count } = await paginateCount(
          sdk,
          () => ({
            dataContractId: this.contractId,
            documentTypeName: 'follow',
            where: [
              ['followingId', '==', userIdBytes],
              ['$createdAt', '>', 0]
            ],
            // Use followers index: [followingId, $createdAt]
            orderBy: [['followingId', 'asc'], ['$createdAt', 'asc']]
          })
        );

        return count;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Error counting followers:', errorMessage, error);
        return 0;
      }
    });
  }

  /**
   * Count following.
   * Paginates through all results for accurate count.
   * Deduplicates in-flight requests.
   */
  async countFollowing(userId: string): Promise<number> {
    return this.countFollowingDeduplicator.dedupe(userId, async () => {
      try {
        const sdk = await getEvoSdk();

        const { count } = await paginateCount(
          sdk,
          () => ({
            dataContractId: this.contractId,
            documentTypeName: 'follow',
            where: [
              ['$ownerId', '==', userId],
              ['$createdAt', '>', 0]
            ],
            // Use following index: [$ownerId, $createdAt]
            orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']]
          })
        );

        return count;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Error counting following:', errorMessage, error);
        return 0;
      }
    });
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
