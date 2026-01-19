import { getEvoSdk } from './evo-sdk-service';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { normalizeSDKResponse, identifierToBase58 } from './sdk-helpers';
import { YAPPR_CONTRACT_ID, MENTION_CONTRACT_ID } from '../constants';
import { Notification, User, Post } from '../types';

// Constants for notification queries
const NOTIFICATION_QUERY_LIMIT = 100;
const INITIAL_FETCH_DAYS = 7;
const INITIAL_FETCH_MS = INITIAL_FETCH_DAYS * 24 * 60 * 60 * 1000;

/**
 * Private feed notification types
 */
type PrivateFeedNotificationType = 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked';

/**
 * Raw notification data before enrichment
 */
interface RawNotification {
  id: string;
  type: 'follow' | 'mention' | PrivateFeedNotificationType;
  fromUserId: string;
  postId?: string;
  createdAt: number;
}

/**
 * Result of notification queries
 */
export interface NotificationResult {
  notifications: Notification[];
  latestTimestamp: number;
}

/**
 * Service for fetching and transforming notifications.
 * Notifications are derived from existing documents (follows, mentions).
 * No separate notification documents are created.
 */
class NotificationService {
  /**
   * Get new followers since timestamp
   * Uses the followers index: [followingId, $createdAt]
   */
  async getNewFollowers(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      // SDK query types are incomplete, cast needed for valid query options
      const response = await sdk.documents.query({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'follow',
        where: [
          ['followingId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['followingId', 'asc'], ['$createdAt', 'asc']],
        limit: NOTIFICATION_QUERY_LIMIT
      } as any);

      const documents = normalizeSDKResponse(response);

      return documents.map((doc: any) => ({
        id: doc.$id,
        type: 'follow' as const,
        fromUserId: doc.$ownerId, // The follower
        createdAt: doc.$createdAt
      }));
    } catch (error) {
      console.error('Error fetching new followers:', error);
      return [];
    }
  }

  /**
   * Get private feed request notifications since timestamp
   *
   * BUG-008 Fix: Changed from querying 'notification' documents to querying 'followRequest' documents directly.
   *
   * The previous implementation tried to query notification documents owned by the recipient,
   * but notification documents could never be created because you can't create documents
   * owned by another identity (the requester can't sign a doc owned by the feed owner).
   *
   * This fix follows the same pattern as getNewFollowers() - query the source documents directly.
   * Uses the followRequest target index: [targetId, $createdAt]
   */
  async getPrivateFeedNotifications(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      // Query followRequest documents where this user is the target (feed owner)
      // This discovers incoming private feed access requests
      const response = await sdk.documents.query({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'followRequest',
        where: [
          ['targetId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']],
        limit: NOTIFICATION_QUERY_LIMIT
      } as any);

      const documents = normalizeSDKResponse(response);

      return documents.map((doc: any) => ({
        id: doc.$id,
        type: 'privateFeedRequest' as const,
        fromUserId: doc.$ownerId, // The requester
        createdAt: doc.$createdAt
      }));
    } catch (error) {
      console.error('Error fetching private feed request notifications:', error);
      return [];
    }
  }

  /**
   * Get new mentions since timestamp
   * Uses the byMentionedUser index: [mentionedUserId, $createdAt]
   */
  async getNewMentions(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      // SDK query types are incomplete, cast needed for valid query options
      const response = await sdk.documents.query({
        dataContractId: MENTION_CONTRACT_ID,
        documentTypeName: 'postMention',
        where: [
          ['mentionedUserId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'asc']],
        limit: NOTIFICATION_QUERY_LIMIT
      } as any);

      const documents = normalizeSDKResponse(response);

      return documents.map((doc: any) => {
        const rawPostId = doc.postId || (doc.data?.postId);
        const postId = rawPostId ? identifierToBase58(rawPostId) : undefined;

        return {
          id: doc.$id,
          type: 'mention' as const,
          fromUserId: doc.$ownerId, // The post author who mentioned the user
          postId: postId || undefined,
          createdAt: doc.$createdAt
        };
      });
    } catch (error) {
      console.error('Error fetching new mentions:', error);
      return [];
    }
  }

  /**
   * Enrich raw notifications with user profiles and post data.
   * Uses Promise.allSettled for fault tolerance - partial failures don't block other notifications.
   */
  private async enrichNotifications(
    rawNotifications: RawNotification[],
    readIds: Set<string>
  ): Promise<Notification[]> {
    if (rawNotifications.length === 0) return [];

    // Collect unique user IDs and post IDs
    const userIds = Array.from(new Set(rawNotifications.map(n => n.fromUserId)));
    const postIds = Array.from(new Set(
      rawNotifications
        .filter(n => n.postId)
        .map(n => n.postId!)
    ));

    // Batch fetch all required data in parallel with fault tolerance
    const results = await Promise.allSettled([
      dpnsService.resolveUsernamesBatch(userIds),
      unifiedProfileService.getProfilesByIdentityIds(userIds),
      unifiedProfileService.getAvatarUrlsBatch(userIds),
      postIds.length > 0 ? this.fetchPostsByIds(postIds) : Promise.resolve(new Map<string, Post>())
    ]);

    // Extract results with fallbacks for failures
    const usernameMap = results[0].status === 'fulfilled'
      ? results[0].value
      : new Map<string, string>();
    const profiles = results[1].status === 'fulfilled'
      ? results[1].value
      : [];
    const avatarUrls = results[2].status === 'fulfilled'
      ? results[2].value
      : new Map<string, string>();
    const posts = results[3].status === 'fulfilled'
      ? results[3].value
      : new Map<string, Post>();

    // Log any enrichment failures for debugging
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const fetchTypes = ['usernames', 'profiles', 'avatars', 'posts'];
        console.error(`Failed to fetch ${fetchTypes[index]} for notification enrichment:`, result.reason);
      }
    });

    // Transform to Notification type
    return rawNotifications.map(raw => {
      const profile = profiles.find((p: { $ownerId: string }) => p.$ownerId === raw.fromUserId);
      const username = usernameMap.get(raw.fromUserId);
      const avatarUrl = avatarUrls.get(raw.fromUserId);

      const user: User = {
        id: raw.fromUserId,
        username: username || '',
        displayName: profile?.displayName || username || this.truncateId(raw.fromUserId),
        avatar: avatarUrl || `https://api.dicebear.com/7.x/shapes/svg?seed=${raw.fromUserId}`,
        bio: profile?.bio,
        followers: 0,
        following: 0,
        joinedAt: new Date()
      };

      const post = raw.postId ? posts.get(raw.postId) : undefined;

      return {
        id: raw.id,
        type: raw.type,
        from: user,
        post,
        createdAt: new Date(raw.createdAt),
        read: readIds.has(raw.id)
      };
    });
  }

  /**
   * Fetch posts by IDs for mention notifications
   */
  private async fetchPostsByIds(postIds: string[]): Promise<Map<string, Post>> {
    const result = new Map<string, Post>();

    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'post',
        where: [['$id', 'in', postIds]],
        limit: postIds.length
      } as any);

      const documents = normalizeSDKResponse(response);

      for (const doc of documents) {
        const docData = doc as Record<string, unknown>;
        const id = docData.$id as string;
        const ownerId = docData.$ownerId as string;
        const createdAt = docData.$createdAt as number;
        const content = (docData.content as string) || '';

        // Create a minimal Post object - just enough for notification display
        const post: Post = {
          id,
          author: {
            id: ownerId,
            username: '',
            displayName: this.truncateId(ownerId),
            avatar: `https://api.dicebear.com/7.x/shapes/svg?seed=${ownerId}`,
            followers: 0,
            following: 0,
            joinedAt: new Date()
          },
          content,
          createdAt: new Date(createdAt),
          likes: 0,
          reposts: 0,
          replies: 0,
          views: 0,
          liked: false,
          reposted: false,
          bookmarked: false
        };
        result.set(id, post);
      }
    } catch (error) {
      console.error('Error fetching posts by IDs:', error);
    }

    return result;
  }

  /**
   * Helper to truncate identity ID for display
   */
  private truncateId(id: string): string {
    if (id.length <= 10) return id;
    return `${id.slice(0, 6)}...${id.slice(-4)}`;
  }

  /**
   * Get initial notifications (last 7 days)
   * Used on page load
   */
  async getInitialNotifications(
    userId: string,
    readIds: Set<string> = new Set()
  ): Promise<NotificationResult> {
    const sinceTimestamp = Date.now() - INITIAL_FETCH_MS;
    return this.fetchNotifications(userId, sinceTimestamp, readIds, Date.now());
  }

  /**
   * Poll for new notifications since last check
   * Used for background polling
   */
  async pollNewNotifications(
    userId: string,
    sinceTimestamp: number,
    readIds: Set<string> = new Set()
  ): Promise<NotificationResult> {
    return this.fetchNotifications(userId, sinceTimestamp, readIds, sinceTimestamp);
  }

  /**
   * Core notification fetching logic
   */
  private async fetchNotifications(
    userId: string,
    sinceTimestamp: number,
    readIds: Set<string>,
    fallbackTimestamp: number
  ): Promise<NotificationResult> {
    const [followers, mentions, privateFeed] = await Promise.all([
      this.getNewFollowers(userId, sinceTimestamp),
      this.getNewMentions(userId, sinceTimestamp),
      this.getPrivateFeedNotifications(userId, sinceTimestamp)
    ]);

    const rawNotifications = [...followers, ...mentions, ...privateFeed];
    rawNotifications.sort((a, b) => b.createdAt - a.createdAt);

    const notifications = await this.enrichNotifications(rawNotifications, readIds);

    const latestTimestamp = rawNotifications.length > 0
      ? Math.max(...rawNotifications.map(n => n.createdAt))
      : fallbackTimestamp;

    return { notifications, latestTimestamp };
  }
}

// Singleton instance
export const notificationService = new NotificationService();
