import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierToBase58, stringToIdentifierBytes, normalizeSDKResponse } from './sdk-helpers';

export interface RepostDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
}

class RepostService extends BaseDocumentService<RepostDocument> {
  constructor() {
    super('repost');
  }

  /**
   * Transform document
   * SDK v3: System fields ($id, $ownerId) are base58, byte array fields (postId) are base64
   */
  protected transformDocument(doc: any): RepostDocument {
    const data = doc.data || doc;
    const rawPostId = data.postId || doc.postId;

    // Convert postId from base64 to base58 (byte array field)
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    if (rawPostId && !postId) {
      console.error('RepostService: Invalid postId format:', rawPostId);
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
   * Repost a post
   */
  async repostPost(postId: string, ownerId: string): Promise<boolean> {
    try {
      // Check if already reposted
      const existing = await this.getRepost(postId, ownerId);
      if (existing) {
        console.log('Post already reposted');
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
      console.error('Error reposting:', error);
      return false;
    }
  }

  /**
   * Remove repost
   */
  async removeRepost(postId: string, ownerId: string): Promise<boolean> {
    try {
      const repost = await this.getRepost(postId, ownerId);
      if (!repost) {
        console.log('Post not reposted');
        return true;
      }

      // Use state transition service for deletion
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        repost.$id,
        ownerId
      );

      return result.success;
    } catch (error) {
      console.error('Error removing repost:', error);
      return false;
    }
  }

  /**
   * Check if post is reposted by user
   */
  async isReposted(postId: string, ownerId: string): Promise<boolean> {
    const repost = await this.getRepost(postId, ownerId);
    return repost !== null;
  }

  /**
   * Get repost by post and owner
   */
  async getRepost(postId: string, ownerId: string): Promise<RepostDocument | null> {
    try {
      // Pass identifier as base58 string - the SDK handles conversion
      const result = await this.query({
        where: [
          ['postId', '==', postId],
          ['$ownerId', '==', ownerId]
        ],
        limit: 1
      });

      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (error) {
      console.error('Error getting repost:', error);
      return null;
    }
  }

  /**
   * Get reposts for a post
   */
  async getPostReposts(postId: string, options: QueryOptions = {}): Promise<RepostDocument[]> {
    try {
      // Pass identifier as base58 string - the SDK handles conversion
      // Dash Platform requires a where clause on the orderBy field for ordering to work
      const result = await this.query({
        where: [
          ['postId', '==', postId],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['$createdAt', 'asc']],
        limit: 50,
        ...options
      });

      return result.documents;
    } catch (error) {
      console.error('Error getting post reposts:', error);
      return [];
    }
  }

  /**
   * Get user's reposts
   */
  async getUserReposts(userId: string, options: QueryOptions = {}): Promise<RepostDocument[]> {
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
      console.error('Error getting user reposts:', error);
      return [];
    }
  }

  /**
   * Count reposts for a post
   */
  async countReposts(postId: string): Promise<number> {
    const reposts = await this.getPostReposts(postId);
    return reposts.length;
  }

  /**
   * Get reposts for multiple posts in a single batch query
   * Uses 'in' operator for efficient querying
   */
  async getRepostsByPostIds(postIds: string[]): Promise<RepostDocument[]> {
    if (postIds.length === 0) return [];

    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Use 'in' operator for batch query on postId
      // Must include orderBy to match the postReposts index: [postId, $createdAt]
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'repost',
        where: [['postId', 'in', postIds]],
        orderBy: [['postId', 'asc']],
        limit: 100
      } as any);

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting reposts batch:', error);
      return [];
    }
  }
}

// Singleton instance
export const repostService = new RepostService();