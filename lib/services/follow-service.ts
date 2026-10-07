import { isReferenceNotFoundError } from '@/lib/error-utils';
import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierStringToDocumentBytes, RequestDeduplicator, transformDocumentWithField } from './sdk-helpers';
import { getEvoSdk } from './evo-sdk-service';
import { paginateFetchAll, documentCount, groupedDocumentCount } from './pagination-utils';
import { TtlMap } from '@/lib/caches/ttl-map';

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
    this.followingIdsCache.delete(followerUserId);
    // v9 refuses a self-follow in consensus (distinctFrom $ownerId, 10419);
    // earlier cuts accept one, which no UI means to write. Refuse on every cut
    // before a broadcast.
    if (followerUserId === targetUserId) {
      return { success: false, error: 'You cannot follow yourself' };
    }
    try {
      const existing = await this.getFollow(targetUserId, followerUserId);
      if (existing) {
        logger.debug('Already following user');
        return { success: true };
      }

      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        followerUserId,
        { followingId: identifierStringToDocumentBytes(targetUserId) }
      );

      // On the v9 contract `follow.followingId` declares `refersTo: identity`,
      // so consensus refuses a follow of an identity that is not on chain.
      // createDocument reports that as a failed result rather than throwing, so
      // promote it into the throw path the UI already treats as toast-worthy.
      if (!result.success && isReferenceNotFoundError(result.error)) {
        throw new Error(result.error ?? 'Referenced identity not found');
      }

      return result;
    } catch (error) {
      logger.error('Error following user:', error);
      // Mirror like-service: let the UI say what actually went wrong instead of
      // collapsing this into a generic "failed to follow".
      if (isReferenceNotFoundError(error)) throw error;
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
    this.followingIdsCache.delete(followerUserId);
    try {
      const follow = await this.getFollow(targetUserId, followerUserId);
      if (!follow) {
        logger.debug('Not following user');
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
      logger.error('Error unfollowing user:', error);
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
      const result = await this.query({
        where: [
          ['$ownerId', '==', followerUserId],
          ['followingId', '==', targetUserId]
        ],
        limit: 1
      });

      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (error) {
      logger.error('Error getting follow:', error);
      return null;
    }
  }

  /**
   * Every follower of a user, oldest first, read to the end (no cap): DM
   * recovery probes each of them in the background.
   */
  async getFollowers(userId: string, options: { throwOnError?: boolean } = {}): Promise<FollowDocument[]> {
    try {
      return (await this.listFollowers(userId, Infinity)).follows;
    } catch (error) {
      logger.error('Error getting followers:', error);
      if (options.throwOnError) throw error;
      return [];
    }
  }

  /**
   * A user's followers, oldest first, up to `maxResults`; `complete` is false
   * when the cap cut the read short (a list page says so). Rejects on failure.
   */
  async listFollowers(userId: string, maxResults: number): Promise<{ follows: FollowDocument[]; complete: boolean }> {
    const sdk = await getEvoSdk();
    const { documents, reachedLimit } = await paginateFetchAll(
      sdk,
      () => ({
        dataContractId: this.contractId,
        documentTypeName: 'follow',
        where: [
          ['followingId', '==', userId],
          ['$createdAt', '>', 0]
        ],
        // Use followers index: [followingId, $createdAt] - must include all index fields in orderBy
        orderBy: [['followingId', 'asc'], ['$createdAt', 'asc']]
      }),
      (doc) => this.transformDocument(doc),
      { maxResults }
    );
    return { follows: documents, complete: !reachedLimit };
  }

  /**
   * A user's `limit` most recent followers, newest first, in one query (for
   * suggestions that only want the head of a possibly long list).
   */
  async getRecentFollowers(userId: string, limit: number): Promise<FollowDocument[]> {
    const { documents } = await this.query({
      where: [
        ['followingId', '==', userId],
        ['$createdAt', '>', 0]
      ],
      orderBy: [['followingId', 'asc'], ['$createdAt', 'desc']],
      limit
    });
    return documents;
  }

  /**
   * Every follow a user made, oldest first, read to the end (no cap): the
   * Following feed, its new-posts check and follow status all treat this as
   * the whole set, so a capped read would hide accounts past the cap.
   */
  async getFollowing(userId: string, options: { throwOnError?: boolean } = {}): Promise<FollowDocument[]> {
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
        (doc) => this.transformDocument(doc),
        { maxResults: Infinity }
      );

      return documents;
    } catch (error) {
      logger.error('Error getting following:', error);
      if (options.throwOnError) throw error;
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

  /** `getFollowingIds` answers held for a minute; a follow or unfollow drops the follower's. */
  private followingIdsCache = new TtlMap<string, string[]>(60_000);

  /**
   * Whom a user follows, held for a minute: for the new-posts check, which
   * asks every 15 s and would otherwise re-read the whole list each time.
   * Rejects when the read fails (nothing is cached then).
   */
  async getFollowingIdsCached(userId: string): Promise<string[]> {
    const cached = this.followingIdsCache.get(userId);
    if (cached) return cached;
    const ids = (await this.getFollowing(userId, { throwOnError: true })).map(f => f.followingId).filter(Boolean);
    this.followingIdsCache.set(userId, ids);
    return ids;
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
      logger.error('Error getting batch follow status:', error);
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

        // O(1) count tree on the `followerCount` index [followingId] (v10: the
        // rangeCountable `followers [followingId, $createdAt]`).
        return await documentCount(sdk, {
          dataContractId: this.contractId,
          documentTypeName: 'follow',
          where: [['followingId', '==', userId]],
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error counting followers:', errorMessage, error);
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

        // O(1) count tree on the `followingCount` index [$ownerId] (v10: the
        // rangeCountable `following [$ownerId, $createdAt]`).
        return await documentCount(sdk, {
          dataContractId: this.contractId,
          documentTypeName: 'follow',
          where: [['$ownerId', '==', userId]],
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error counting following:', errorMessage, error);
        return 0;
      }
    });
  }

  /**
   * Count followers for many identities with one grouped count-tree query per
   * 100 ids. The per-id method remains the fallback when a node cannot decode
   * grouped keys (or when a legacy contract does not expose the index).
   */
  async countFollowersBatch(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const sdk = await getEvoSdk();
    return groupedDocumentCount(
      sdk,
      { dataContractId: this.contractId, documentTypeName: 'follow', groupField: 'followingId' },
      userIds,
      (id) => this.countFollowers(id)
    );
  }

  /** Count following relationships for many identities in grouped batches. */
  async countFollowingBatch(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const sdk = await getEvoSdk();
    return groupedDocumentCount(
      sdk,
      { dataContractId: this.contractId, documentTypeName: 'follow', groupField: '$ownerId' },
      userIds,
      (id) => this.countFollowing(id)
    );
  }

}

// Singleton instance
export const followService = new FollowService();
