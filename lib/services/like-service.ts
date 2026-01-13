import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierToBase58, stringToIdentifierBytes, normalizeSDKResponse, RequestDeduplicator, base58ArrayToBytes } from './sdk-helpers';

export interface LikeDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
}

class LikeService extends BaseDocumentService<LikeDocument> {
  private countUserLikesDeduplicator = new RequestDeduplicator<string, number>();

  constructor() {
    super('like');
  }

  /**
   * Transform document
   * SDK v3: System fields ($id, $ownerId) are base58, byte array fields (postId) are base64
   */
  protected transformDocument(doc: any): LikeDocument {
    const data = doc.data || doc;
    const rawPostId = data.postId || doc.postId;

    // Convert postId from base64 to base58 (byte array field)
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    if (rawPostId && !postId) {
      console.error('LikeService: Invalid postId format:', rawPostId);
    }

    // Handle both $ prefixed (query responses) and non-prefixed (creation responses) fields
    return {
      $id: doc.$id || doc.id,
      $ownerId: doc.$ownerId || doc.ownerId,
      $createdAt: doc.$createdAt || doc.createdAt,
      postId: postId || ''
    };
  }

  /**
   * Like a post
   */
  async likePost(postId: string, ownerId: string): Promise<boolean> {
    try {
      // Check if already liked
      const existing = await this.getLike(postId, ownerId);
      if (existing) {
        console.log('Post already liked');
        return true;
      }

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        { postId: stringToIdentifierBytes(postId) }
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
      } as any);

      const documents = normalizeSDKResponse(response);
      return documents.length > 0 ? this.transformDocument(documents[0]) : null;
    } catch (error) {
      console.error('Error getting like:', error);
      return null;
    }
  }

  /**
   * Get likes for a post
   */
  async getPostLikes(postId: string, options: QueryOptions = {}): Promise<LikeDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Dash Platform requires a where clause on the orderBy field for ordering to work
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'like',
        where: [
          ['postId', '==', postId],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['$createdAt', 'asc']],
        limit: options.limit || 50
      } as any);

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting post likes:', error);
      return [];
    }
  }

  /**
   * Get user's likes
   */
  async getUserLikes(userId: string, options: QueryOptions = {}): Promise<LikeDocument[]> {
    try {
      // Dash Platform requires a where clause on the orderBy field for ordering to work
      const result = await this.query({
        where: [
          ['$ownerId', '==', userId],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['$createdAt', 'asc']],
        limit: 50,
        ...options
      });

      return result.documents;
    } catch (error) {
      console.error('Error getting user likes:', error);
      return [];
    }
  }

  /**
   * Count likes given by a user - uses direct SDK query for reliability.
   * Deduplicates in-flight requests.
   */
  async countUserLikes(userId: string): Promise<number> {
    return this.countUserLikesDeduplicator.dedupe(userId, async () => {
      try {
        const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

        // Dash Platform requires a where clause on the orderBy field for ordering to work
        const response = await sdk.documents.query({
          dataContractId: this.contractId,
          documentTypeName: 'like',
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$createdAt', 'asc']],
          limit: 100
        } as any);

        return normalizeSDKResponse(response).length;
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
   */
  async getLikesByPostIds(postIds: string[]): Promise<LikeDocument[]> {
    if (postIds.length === 0) return [];

    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Use 'in' operator for batch query on postId
      // Must include orderBy to match the postLikes index: [postId, $createdAt]
      // Convert base58 strings to byte arrays for the byte array field
      const postIdBytes = base58ArrayToBytes(postIds);
      if (postIdBytes.length === 0) return [];

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'like',
        where: [['postId', 'in', postIdBytes]],
        orderBy: [['postId', 'asc']],
        limit: 100
      } as any);

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting likes batch:', error);
      return [];
    }
  }
}

// Singleton instance
export const likeService = new LikeService();