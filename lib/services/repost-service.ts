import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { stringToIdentifierBytes, normalizeSDKResponse, identifierToBase58 } from './sdk-helpers';
import { paginateFetchAll } from './pagination-utils';

export interface RepostDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
  postOwnerId?: string;
}

class RepostService extends BaseDocumentService<RepostDocument> {
  constructor() {
    super('repost');
  }

  protected transformDocument(doc: Record<string, unknown>): RepostDocument {
    const data = (doc.data || doc) as Record<string, unknown>;

    // Convert postId
    const rawPostId = data.postId || doc.postId;
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    if (rawPostId && !postId) {
      console.error('RepostService: Invalid postId format:', rawPostId);
    }

    // Convert postOwnerId (optional field)
    const rawPostOwnerId = data.postOwnerId || doc.postOwnerId;
    const postOwnerId = rawPostOwnerId ? identifierToBase58(rawPostOwnerId) : undefined;
    if (rawPostOwnerId && !postOwnerId) {
      console.error('RepostService: Invalid postOwnerId format:', rawPostOwnerId);
    }

    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      postId: postId || '',
      postOwnerId: postOwnerId || undefined,
    };
  }

  /**
   * Repost a post
   * @param postId - ID of the post being reposted
   * @param ownerId - Identity ID of the user reposting
   * @param postOwnerId - Identity ID of the post author (for efficient notification queries)
   */
  async repostPost(postId: string, ownerId: string, postOwnerId?: string): Promise<boolean> {
    try {
      // Check if already reposted
      const existing = await this.getRepost(postId, ownerId);
      if (existing) {
        console.log('Post already reposted');
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
   * Get reposts for a post.
   * Paginates through all results to return complete list.
   */
  async getPostReposts(postId: string): Promise<RepostDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'repost',
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
      console.error('Error getting post reposts:', error);
      return [];
    }
  }

  /**
   * Get user's reposts.
   * Paginates through all results to return complete list.
   */
  async getUserReposts(userId: string): Promise<RepostDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'repost',
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$createdAt', 'desc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
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
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
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
      });

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting reposts batch:', error);
      return [];
    }
  }

  /**
   * Get reposts of posts owned by a specific user (for notification queries).
   * Uses the postOwnerReposts index: [postOwnerId, $createdAt]
   * Paginates through all results to return complete list.
   * @param userId - Identity ID of the post owner
   * @param since - Only return reposts created after this timestamp (optional)
   */
  async getRepostsOfMyPosts(userId: string, since?: Date): Promise<RepostDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const sinceTimestamp = since?.getTime() || 0;

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'repost',
          where: [
            ['postOwnerId', '==', userId],
            ['$createdAt', '>', sinceTimestamp]
          ],
          // Match postOwnerReposts index: [postOwnerId: asc, $createdAt: asc]
          orderBy: [['postOwnerId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      console.error('Error getting reposts of my posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const repostService = new RepostService();