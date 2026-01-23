import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { stringToIdentifierBytes, normalizeSDKResponse, RequestDeduplicator, identifierToBase58 } from './sdk-helpers';
import { paginateCount, paginateFetchAll } from './pagination-utils';

export interface LikeDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
  postOwnerId?: string;
}

class LikeService extends BaseDocumentService<LikeDocument> {
  private countUserLikesDeduplicator = new RequestDeduplicator<string, number>();

  constructor() {
    super('like');
  }

  protected transformDocument(doc: Record<string, unknown>): LikeDocument {
    const data = (doc.data || doc) as Record<string, unknown>;

    // Convert postId
    const rawPostId = data.postId || doc.postId;
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    if (rawPostId && !postId) {
      console.error('LikeService: Invalid postId format:', rawPostId);
    }

    // Convert postOwnerId (optional field)
    const rawPostOwnerId = data.postOwnerId || doc.postOwnerId;
    const postOwnerId = rawPostOwnerId ? identifierToBase58(rawPostOwnerId) : undefined;

    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      postId: postId || '',
      postOwnerId: postOwnerId || undefined,
    };
  }

  /**
   * Like a post
   * @param postId - ID of the post being liked
   * @param ownerId - Identity ID of the user liking the post
   * @param postOwnerId - Identity ID of the post author (for efficient notification queries)
   */
  async likePost(postId: string, ownerId: string, postOwnerId?: string): Promise<boolean> {
    try {
      // Check if already liked
      const existing = await this.getLike(postId, ownerId);
      if (existing) {
        console.log('Post already liked');
        return true;
      }

      // Build document data
      const documentData: Record<string, unknown> = {
        postId: stringToIdentifierBytes(postId)
      };

      // Add postOwnerId if provided (for notification queries)
      if (postOwnerId) {
        documentData.postOwnerId = stringToIdentifierBytes(postOwnerId);
      }

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        documentData
      );

      return result.success;
    } catch (error) {
      console.error('Error liking post:', error);
      return false;
    }
  }

  /**
   * Unlike a post
   */
  async unlikePost(postId: string, ownerId: string): Promise<boolean> {
    try {
      const like = await this.getLike(postId, ownerId);
      if (!like) {
        console.log('Post not liked');
        return true;
      }

      // Use state transition service for deletion
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        like.$id,
        ownerId
      );

      return result.success;
    } catch (error) {
      console.error('Error unliking post:', error);
      return false;
    }
  }

  /**
   * Check if post is liked by user
   */
  async isLiked(postId: string, ownerId: string): Promise<boolean> {
    const like = await this.getLike(postId, ownerId);
    return like !== null;
  }

  /**
   * Get like by post and owner
   */
  async getLike(postId: string, ownerId: string): Promise<LikeDocument | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'like',
        where: [
          ['postId', '==', postId],
          ['$ownerId', '==', ownerId]
        ],
        limit: 1
      });

      const documents = normalizeSDKResponse(response);
      return documents.length > 0 ? this.transformDocument(documents[0]) : null;
    } catch (error) {
      console.error('Error getting like:', error);
      return null;
    }
  }

  /**
   * Get likes for a post.
   * Paginates through all results to return complete list.
   */
  async getPostLikes(postId: string): Promise<LikeDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'like',
          where: [
            ['postId', '==', postId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$createdAt', 'asc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      console.error('Error getting post likes:', error);
      return [];
    }
  }

  /**
   * Get user's likes.
   * Paginates through all results to return complete list.
   */
  async getUserLikes(userId: string): Promise<LikeDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'like',
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$createdAt', 'asc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      console.error('Error getting user likes:', error);
      return [];
    }
  }

  /**
   * Count likes given by a user.
   * Paginates through all results for accurate count.
   * Deduplicates in-flight requests.
   */
  async countUserLikes(userId: string): Promise<number> {
    return this.countUserLikesDeduplicator.dedupe(userId, async () => {
      try {
        const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

        const { count } = await paginateCount(
          sdk,
          () => ({
            dataContractId: this.contractId,
            documentTypeName: 'like',
            where: [
              ['$ownerId', '==', userId],
              ['$createdAt', '>', 0]
            ],
            orderBy: [['$createdAt', 'asc']]
          })
        );

        return count;
      } catch (error) {
        console.error('Error counting user likes:', error);
        return 0;
      }
    });
  }

  /**
   * Count likes for a post
   */
  async countLikes(postId: string): Promise<number> {
    // In a real implementation, this would be more efficient
    const likes = await this.getPostLikes(postId);
    return likes.length;
  }

  /**
   * Get likes for multiple posts in a single batch query
   * Uses 'in' operator for efficient querying
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  async getLikesByPostIds(postIds: string[]): Promise<LikeDocument[]> {
    if (postIds.length === 0) return [];

    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Use 'in' operator for batch query on postId
      // Must include orderBy to match the postLikes index: [postId, $createdAt]
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'like',
        where: [['postId', 'in', postIds]],
        orderBy: [['postId', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting likes batch:', error);
      return [];
    }
  }

  /**
   * Get likes on posts owned by a specific user (for notification queries).
   * Uses the postOwnerLikes index: [postOwnerId, $createdAt]
   * @param userId - Identity ID of the post owner
   * @param since - Only return likes created after this timestamp (optional)
   */
  async getLikesOnMyPosts(userId: string, since?: Date): Promise<LikeDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const sinceTimestamp = since?.getTime() || 0;

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'like',
        where: [
          ['postOwnerId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        // Match postOwnerLikes index: [postOwnerId: asc, $createdAt: asc]
        orderBy: [['postOwnerId', 'asc'], ['$createdAt', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting likes on my posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const likeService = new LikeService();