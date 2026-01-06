import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierToBase58 } from './sdk-helpers';

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
   */
  protected transformDocument(doc: any): RepostDocument {
    // Handle different document structures from SDK
    // Batch queries return: { id, ownerId, data: { postId } }
    // Regular queries return: { $id, $ownerId, postId }
    const data = doc.data || doc;
    const rawPostId = data.postId || doc.postId;
    const rawId = doc.$id || doc.id;
    const rawOwnerId = doc.$ownerId || doc.ownerId;

    // Use identifierToBase58 for proper conversion from any format
    const postId = rawPostId ? identifierToBase58(rawPostId) || String(rawPostId) : '';
    const id = identifierToBase58(rawId) || String(rawId);
    const ownerId = identifierToBase58(rawOwnerId) || String(rawOwnerId);

    return {
      $id: id,
      $ownerId: ownerId,
      $createdAt: doc.$createdAt || doc.createdAt,
      postId
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

      // Convert postId to byte array
      // Use Array.from() because Uint8Array doesn't serialize properly through SDK
      const bs58Module = await import('bs58');
      const bs58 = bs58Module.default;
      const postIdBytes = Array.from(bs58.decode(postId));

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        { postId: postIdBytes }
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

      return documents.map((doc: any) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting reposts batch:', error);
      return [];
    }
  }
}

// Singleton instance
export const repostService = new RepostService();