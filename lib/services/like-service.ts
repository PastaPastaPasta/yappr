import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierStringToDocumentBytes, normalizeSDKResponse, identifierToBase58, type DocumentOrderByClause, type DocumentWhereClause } from './sdk-helpers';
import { paginateFetchAll, documentCount, groupedDocumentCount, queryOwnedPostIds } from './pagination-utils';
import { isFrozenBalanceError, isInsufficientTokenError } from '../error-utils';
import { likeIndexFor, type TargetKind } from '../contract-topology';

export interface LikeDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
  postOwnerId?: string;
}

/**
 * Likes of posts and likes of replies share this service, but not necessarily a
 * document type: the v3 topology routes reply likes to `likeReply` with
 * `replyId`/`replyOwnerId` in place of `postId`/`postOwnerId`. Every method that
 * touches the chain therefore takes the target's kind and resolves the doctype
 * and field names through the topology descriptor. `kind` defaults to `post`,
 * which on v2 is the same surface a reply resolves to — so v2 queries are
 * unchanged whichever kind is passed.
 */
class LikeService extends BaseDocumentService<LikeDocument> {
  constructor() {
    super('like');
  }

  protected transformDocument(doc: Record<string, unknown>): LikeDocument {
    return this.transformDocumentFor(doc, 'post');
  }

  /**
   * Reads a like document into the canonical `{postId, postOwnerId}` shape,
   * regardless of what the topology calls those fields on this kind's doctype.
   */
  private transformDocumentFor(doc: Record<string, unknown>, kind: TargetKind): LikeDocument {
    const data = (doc.data || doc) as Record<string, unknown>;
    const { field, ownerField } = likeIndexFor(kind);

    const rawPostId = data[field] || doc[field];
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    if (rawPostId && !postId) {
      logger.error('LikeService: Invalid target id format:', rawPostId);
    }

    // Owner denormalization is optional in the schema (and absent on some doctypes).
    const rawPostOwnerId = ownerField ? (data[ownerField] || doc[ownerField]) : undefined;
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
   * Like a post or a reply
   * @param postId - ID of the post/reply being liked
   * @param ownerId - Identity ID of the user liking it
   * @param postOwnerId - Identity ID of the target's author (for efficient notification queries)
   * @param kind - Whether the target is a post or a reply
   */
  async likePost(postId: string, ownerId: string, postOwnerId?: string, kind: TargetKind = 'post'): Promise<boolean> {
    try {
      // Check if already liked
      const existing = await this.getLike(postId, ownerId, kind);
      if (existing) {
        logger.info('Post already liked');
        return true;
      }

      const { docType, field, ownerField } = likeIndexFor(kind);

      // Build document data
      const documentData: Record<string, unknown> = {
        [field]: identifierStringToDocumentBytes(postId)
      };

      // Add the target-owner denormalization if provided (for notification queries)
      if (postOwnerId && ownerField) {
        documentData[ownerField] = identifierStringToDocumentBytes(postOwnerId);
      }

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        docType,
        ownerId,
        documentData
      );

      if (!result.success) {
        throw new Error(result.error || 'Like failed');
      }
      return true;
    } catch (error) {
      logger.error('Error liking post:', error);
      // Let the UI prompt to buy YAPP on insufficient-token failures, and explain
      // the suspension on frozen-account failures (buying YAPP would not help).
      if (isInsufficientTokenError(error) || isFrozenBalanceError(error)) throw error;
      return false;
    }
  }

  /**
   * Unlike a post or reply
   */
  async unlikePost(postId: string, ownerId: string, kind: TargetKind = 'post'): Promise<boolean> {
    try {
      const like = await this.getLike(postId, ownerId, kind);
      if (!like) {
        logger.info('Post not liked');
        return true;
      }

      // Use state transition service for deletion
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        likeIndexFor(kind).docType,
        like.$id,
        ownerId
      );

      return result.success;
    } catch (error) {
      logger.error('Error unliking post:', error);
      return false;
    }
  }

  /**
   * Check if a post/reply is liked by user
   */
  async isLiked(postId: string, ownerId: string, kind: TargetKind = 'post'): Promise<boolean> {
    const like = await this.getLike(postId, ownerId, kind);
    return like !== null;
  }

  /**
   * Get a like by target and owner, via the doctype's unique (target, owner) index.
   */
  async getLike(postId: string, ownerId: string, kind: TargetKind = 'post'): Promise<LikeDocument | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const { docType, field, ownerFirst } = likeIndexFor(kind);

      // Use 'in' pattern that works on feed page.
      // Both where and orderBy must list the index's properties in the order the
      // contract declares them, so orderBy is derived from where and the two
      // cannot drift apart.
      const targetClause: DocumentWhereClause = [field, 'in', [postId]];
      const ownerClause: DocumentWhereClause = ['$ownerId', '==', ownerId];
      const where = ownerFirst ? [ownerClause, targetClause] : [targetClause, ownerClause];
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: docType,
        where,
        orderBy: where.map(([property]) => [property, 'asc'] as DocumentOrderByClause),
        limit: 1
      });

      const documents = normalizeSDKResponse(response);
      return documents.length > 0 ? this.transformDocumentFor(documents[0], kind) : null;
    } catch (error) {
      logger.error('Error getting like:', error);
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

      // Use 'in' with single-element array - matches working feed pattern
      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'like',
          where: [['postId', 'in', [postId]]],
          orderBy: [['postId', 'asc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      logger.error('Error getting post likes:', error);
      return [];
    }
  }

  /**
   * Count likes for a post
   */
  /**
   * Which of the given targets the user has liked — queries only the user's OWN
   * likes via the doctype's unique (target, owner) index, so the result is
   * bounded by the number of targets (not total likes) and never undercounts.
   */
  async getUserLikedPostIds(userId: string, postIds: string[], kind: TargetKind = 'post'): Promise<Set<string>> {
    // v2 `like.postAndOwner` is [postId, $ownerId] → ownerFirst: false.
    const { docType, field, ownerFirst } = likeIndexFor(kind);
    return queryOwnedPostIds({
      getSdk: () => import('../services/evo-sdk-service').then(m => m.getEvoSdk()),
      dataContractId: this.contractId,
      documentTypeName: docType,
      userId,
      postIds,
      ownerFirst,
      field,
      getPostId: (doc) => this.transformDocumentFor(doc, kind)?.postId,
      errorLabel: 'Error fetching user liked post ids:',
    });
  }

  async countLikes(postId: string, kind: TargetKind = 'post'): Promise<number> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const { docType, field } = likeIndexFor(kind);
      // O(1) count tree on the doctype's countable [target] index.
      return await documentCount(sdk, {
        dataContractId: this.contractId,
        documentTypeName: docType,
        where: [[field, '==', postId]],
      });
    } catch (error) {
      logger.error('Error counting likes:', error);
      return 0;
    }
  }

  /** Like counts for multiple targets via one grouped count-tree query (falls back to per-target reads). */
  async countLikesForPosts(postIds: string[], kind: TargetKind = 'post'): Promise<Map<string, number>> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    const { docType, field } = likeIndexFor(kind);
    return groupedDocumentCount(
      sdk,
      { dataContractId: this.contractId, documentTypeName: docType, groupField: field },
      postIds,
      (id) => this.countLikes(id, kind)
    );
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
      logger.error('Error getting likes on my posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const likeService = new LikeService();
