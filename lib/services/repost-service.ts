import { YAPPR_CONTRACT_ID } from '../constants';
import { stateTransitionService } from './state-transition-service';
import { stringToIdentifierBytes, normalizeSDKResponse, identifierToBase58 } from './sdk-helpers';
import { paginateFetchAll } from './pagination-utils';

/**
 * Repost document - now stored as a post with quotedPostId and empty content.
 * This interface represents the repost data for compatibility with existing code.
 */
export interface RepostDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;  // The quotedPostId (the post being reposted)
  postOwnerId?: string;  // The quotedPostOwnerId
}

/**
 * Repost Service
 *
 * Reposts are now stored as post documents with:
 * - quotedPostId: ID of the post being reposted
 * - quotedPostOwnerId: Owner of the quoted post (for notifications)
 * - content: Empty string (distinguishes pure repost from quote tweet)
 * - language: Required (use 'en' as default if not specified)
 */
class RepostService {
  private contractId = YAPPR_CONTRACT_ID;
  private documentType = 'post';

  /**
   * Transform a post document into RepostDocument format.
   * Only transforms posts that are reposts (have quotedPostId + empty content).
   */
  private transformToRepostDocument(doc: Record<string, unknown>): RepostDocument | null {
    const data = (doc.data || doc) as Record<string, unknown>;

    // Check if this is a repost (has quotedPostId)
    const rawQuotedPostId = data.quotedPostId || doc.quotedPostId;
    if (!rawQuotedPostId) return null;

    // Check if content is empty (pure repost vs quote tweet)
    const content = (data.content || doc.content || '') as string;
    if (content && content.trim() !== '') return null;

    const quotedPostId = identifierToBase58(rawQuotedPostId);
    if (!quotedPostId) {
      console.error('RepostService: Invalid quotedPostId format:', rawQuotedPostId);
      return null;
    }

    // Convert quotedPostOwnerId
    const rawQuotedPostOwnerId = data.quotedPostOwnerId || doc.quotedPostOwnerId;
    const quotedPostOwnerId = rawQuotedPostOwnerId ? identifierToBase58(rawQuotedPostOwnerId) : undefined;

    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      postId: quotedPostId,
      postOwnerId: quotedPostOwnerId || undefined,
    };
  }

  /**
   * Repost a post.
   * Creates a post document with empty content and quotedPostId.
   * @param postId - ID of the post being reposted
   * @param ownerId - Identity ID of the user reposting
   * @param postOwnerId - Identity ID of the post author (for efficient notification queries)
   * @param language - Language code (defaults to 'en')
   */
  async repostPost(postId: string, ownerId: string, postOwnerId?: string, language: string = 'en'): Promise<boolean> {
    try {
      // Check if already reposted
      const existing = await this.getRepost(postId, ownerId);
      if (existing) {
        console.log('Post already reposted');
        return true;
      }

      // Build document data - a post with empty content + quotedPostId
      const documentData: Record<string, unknown> = {
        content: '',  // Empty content marks this as a pure repost
        quotedPostId: stringToIdentifierBytes(postId),
        language: language,  // Required field
      };

      // Add quotedPostOwnerId if provided (for notification queries)
      if (postOwnerId) {
        documentData.quotedPostOwnerId = stringToIdentifierBytes(postOwnerId);
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
   * Remove repost.
   * Finds and deletes the post document that represents the repost.
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
   * Check if post is reposted by user.
   * Uses the quotedPostAndOwner index.
   */
  async isReposted(postId: string, ownerId: string): Promise<boolean> {
    const repost = await this.getRepost(postId, ownerId);
    return repost !== null;
  }

  /**
   * Get repost by post and owner.
   * Queries the quotedPostAndOwner index.
   */
  async getRepost(postId: string, ownerId: string): Promise<RepostDocument | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Query using the quotedPostAndOwner index
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [
          ['quotedPostId', '==', postId],
          ['$ownerId', '==', ownerId]
        ],
        limit: 1
      });

      const documents = normalizeSDKResponse(response);

      // Filter for pure reposts (empty content) and transform
      for (const doc of documents) {
        const repost = this.transformToRepostDocument(doc);
        if (repost) return repost;
      }

      return null;
    } catch (error) {
      console.error('Error getting repost:', error);
      return null;
    }
  }

  /**
   * Get reposts for a post.
   * Uses the quotedPostAndOwner index, filters for empty content.
   * Paginates through all results to return complete list.
   */
  async getPostReposts(postId: string): Promise<RepostDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: [
            ['quotedPostId', '==', postId],
            ['$ownerId', '>', '']  // Need second field for index
          ],
          orderBy: [['quotedPostId', 'asc'], ['$ownerId', 'asc']]
        }),
        (doc) => this.transformToRepostDocument(doc)
      );

      // Filter out nulls (quote tweets with content)
      return documents.filter((d): d is RepostDocument => d !== null);
    } catch (error) {
      console.error('Error getting post reposts:', error);
      return [];
    }
  }

  /**
   * Get user's reposts.
   * Uses the ownerAndTime index, filters for posts with quotedPostId and empty content.
   * Paginates through all results to return complete list.
   */
  async getUserReposts(userId: string): Promise<RepostDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']]
        }),
        (doc) => this.transformToRepostDocument(doc)
      );

      // Filter out nulls (posts that aren't reposts or are quote tweets)
      return documents.filter((d): d is RepostDocument => d !== null);
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
   * Get reposts for multiple posts in a single batch query.
   * Uses 'in' operator for efficient querying.
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

      // Use 'in' operator for batch query on quotedPostId
      // Must include orderBy to match the quotedPostAndOwner index
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [['quotedPostId', 'in', postIds]],
        orderBy: [['quotedPostId', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);

      // Transform and filter for pure reposts only
      const reposts: RepostDocument[] = [];
      for (const doc of documents) {
        const repost = this.transformToRepostDocument(doc);
        if (repost) reposts.push(repost);
      }

      return reposts;
    } catch (error) {
      console.error('Error getting reposts batch:', error);
      return [];
    }
  }

  /**
   * Get reposts of posts owned by a specific user (for notification queries).
   * Uses the quotedPostOwnerAndTime index.
   * Limited to 100 most recent reposts for notification purposes.
   * @param userId - Identity ID of the post owner
   * @param since - Only return reposts created after this timestamp (optional)
   */
  async getRepostsOfMyPosts(userId: string, since?: Date): Promise<RepostDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const sinceTimestamp = since?.getTime() || 0;

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [
          ['quotedPostOwnerId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        // Match quotedPostOwnerAndTime index: [quotedPostOwnerId: asc, $createdAt: asc]
        orderBy: [['quotedPostOwnerId', 'asc'], ['$createdAt', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);

      // Transform and filter for pure reposts only
      const reposts: RepostDocument[] = [];
      for (const doc of documents) {
        const repost = this.transformToRepostDocument(doc);
        if (repost) reposts.push(repost);
      }

      return reposts;
    } catch (error) {
      console.error('Error getting reposts of my posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const repostService = new RepostService();
