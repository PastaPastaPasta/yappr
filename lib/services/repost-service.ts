import { logger } from '@/lib/logger';
import { YAPPR_CONTRACT_ID } from '../constants';
import { stateTransitionService } from './state-transition-service';
import { identifierStringToDocumentBytes, normalizeSDKResponse, identifierToBase58 } from './sdk-helpers';
import { paginateFetchAll, documentCount, groupedDocumentCount, queryOwnedPostIds } from './pagination-utils';
import { isInsufficientTokenError } from '../error-utils';

/** A repost of a post — a dedicated `repost` document ({ postId, postOwnerId }). */
export interface RepostDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;       // The post being reposted
  postOwnerId?: string; // Owner of the reposted post
}

/**
 * Repost Service — reposts are dedicated `repost` documents (tokenCost 1) with a
 * `byPost` count tree, an `ownerAndPost` unique index, and `postOwnerAndTime` for
 * "X reposted your post" notifications.
 */
class RepostService {
  private contractId = YAPPR_CONTRACT_ID;
  private documentType = 'repost';

  private async sdk() {
    return import('../services/evo-sdk-service').then(m => m.getEvoSdk());
  }

  private map(doc: Record<string, unknown>): RepostDocument | null {
    const data = (doc.data || doc) as Record<string, unknown>;
    const rawPostId = data.postId || doc.postId;
    const postId = rawPostId ? identifierToBase58(rawPostId) : null;
    if (!postId) {
      logger.error('RepostService: repost doc has invalid/missing postId:', rawPostId);
      return null;
    }
    const rawOwner = data.postOwnerId || doc.postOwnerId;
    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      postId,
      postOwnerId: rawOwner ? identifierToBase58(rawOwner) || undefined : undefined,
    };
  }

  /**
   * Repost a post — creates a `repost` document (tokenCost 1).
   * @param postId - the post being reposted
   * @param ownerId - the reposting user
   * @param postOwnerId - the reposted post's author (required; for notifications)
   */
  async repostPost(postId: string, ownerId: string, postOwnerId: string): Promise<boolean> {
    try {
      const existing = await this.getRepost(postId, ownerId);
      if (existing) {
        logger.info('Post already reposted');
        return true;
      }

      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        {
          postId: identifierStringToDocumentBytes(postId),
          postOwnerId: identifierStringToDocumentBytes(postOwnerId),
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Repost failed');
      }
      return true;
    } catch (error) {
      logger.error('Error reposting:', error);
      // Let the UI prompt to buy YAPP on insufficient-token failures.
      if (isInsufficientTokenError(error)) throw error;
      return false;
    }
  }

  async removeRepost(postId: string, ownerId: string): Promise<boolean> {
    try {
      const repost = await this.getRepost(postId, ownerId);
      if (!repost) {
        logger.info('Post not reposted');
        return true;
      }
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        repost.$id,
        ownerId
      );
      return result.success;
    } catch (error) {
      logger.error('Error removing repost:', error);
      return false;
    }
  }

  async isReposted(postId: string, ownerId: string): Promise<boolean> {
    return (await this.getRepost(postId, ownerId)) !== null;
  }

  /** A user's repost of a post — `ownerAndPost` index [$ownerId, postId]. */
  async getRepost(postId: string, ownerId: string): Promise<RepostDocument | null> {
    try {
      const sdk = await this.sdk();
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['$ownerId', '==', ownerId], ['postId', 'in', [postId]]],
        orderBy: [['$ownerId', 'asc'], ['postId', 'asc']],
        limit: 1,
      });
      for (const doc of normalizeSDKResponse(response)) {
        const repost = this.map(doc);
        if (repost) return repost;
      }
      return null;
    } catch (error) {
      logger.error('Error getting repost:', error);
      return null;
    }
  }

  /** All reposts of a post — `byPost` index [postId]. */
  async getPostReposts(postId: string): Promise<RepostDocument[]> {
    try {
      const sdk = await this.sdk();
      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [['postId', 'in', [postId]]],
          orderBy: [['postId', 'asc']],
        }),
        (doc) => this.map(doc)
      );
      return documents.filter((d): d is RepostDocument => d !== null);
    } catch (error) {
      logger.error('Error getting post reposts:', error);
      return [];
    }
  }

  /** A user's reposts — `ownerAndTime` index [$ownerId, $createdAt]. */
  async getUserReposts(userId: string): Promise<RepostDocument[]> {
    try {
      const sdk = await this.sdk();
      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [['$ownerId', '==', userId], ['$createdAt', '>', 0]],
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
        }),
        (doc) => this.map(doc)
      );
      return documents.filter((d): d is RepostDocument => d !== null);
    } catch (error) {
      logger.error('Error getting user reposts:', error);
      return [];
    }
  }

  /**
   * Which of the given posts the user has reposted — queries only the user's OWN
   * reposts via the unique `ownerAndPost` [$ownerId, postId] index, so the result
   * is bounded by the number of posts (not total reposts).
   */
  async getUserRepostedPostIds(userId: string, postIds: string[]): Promise<Set<string>> {
    // repost's `ownerAndPost` index is [$ownerId, postId] → ownerFirst: true.
    return queryOwnedPostIds({
      getSdk: () => this.sdk(),
      dataContractId: this.contractId,
      documentTypeName: this.documentType,
      userId,
      postIds,
      ownerFirst: true,
      getPostId: (doc) => this.map(doc)?.postId,
      errorLabel: 'Error fetching user reposted post ids:',
    });
  }

  /** Count reposts of a post — O(1) `byPost` count tree. */
  async countReposts(postId: string): Promise<number> {
    try {
      const sdk = await this.sdk();
      return await documentCount(sdk, {
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['postId', '==', postId]],
      });
    } catch (error) {
      logger.error('Error counting reposts:', error);
      return 0;
    }
  }

  /** Repost counts for multiple posts via one grouped count-tree query (falls back to per-post reads). */
  async countRepostsForPosts(postIds: string[]): Promise<Map<string, number>> {
    const sdk = await this.sdk();
    return groupedDocumentCount(
      sdk,
      { dataContractId: this.contractId, documentTypeName: this.documentType, groupField: 'postId' },
      postIds,
      (id) => this.countReposts(id)
    );
  }

  /** Batch reposts for many posts — `byPost` index, single query. */
  async getRepostsByPostIds(postIds: string[]): Promise<RepostDocument[]> {
    if (postIds.length === 0) return [];
    try {
      const sdk = await this.sdk();
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['postId', 'in', postIds]],
        orderBy: [['postId', 'asc']],
        limit: 100,
      });
      const out: RepostDocument[] = [];
      for (const doc of normalizeSDKResponse(response)) {
        const r = this.map(doc);
        if (r) out.push(r);
      }
      return out;
    } catch (error) {
      logger.error('Error getting reposts batch:', error);
      return [];
    }
  }

  /**
   * Reposts of a user's posts (for "X reposted your post" notifications).
   * Uses the `postOwnerAndTime` index [postOwnerId, $createdAt].
   */
  async getRepostsOfMyPosts(userId: string, since?: Date): Promise<RepostDocument[]> {
    const sinceTimestamp = since?.getTime() || 0;
    try {
      const sdk = await this.sdk();
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['postOwnerId', '==', userId], ['$createdAt', '>', sinceTimestamp]],
        orderBy: [['postOwnerId', 'asc'], ['$createdAt', 'asc']],
        limit: 100,
      });
      const out: RepostDocument[] = [];
      for (const doc of normalizeSDKResponse(response)) {
        const r = this.map(doc);
        if (r) out.push(r);
      }
      return out;
    } catch (error) {
      logger.error('Error getting reposts of my posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const repostService = new RepostService();
