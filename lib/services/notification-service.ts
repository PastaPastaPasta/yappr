import { getEvoSdk } from './evo-sdk-service';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { postService } from './post-service';
import { normalizeSDKResponse, identifierToBase58 } from './sdk-helpers';
import { YAPPR_CONTRACT_ID, MENTION_CONTRACT_ID } from '../constants';
import { Notification, User, Post } from '../types';

/**
 * Raw notification data before enrichment
 */
interface RawNotification {
  id: string;
  type: 'follow' | 'mention';
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

      const response = await sdk.documents.query({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'follow',
        where: [
          ['followingId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['followingId', 'asc'], ['$createdAt', 'asc']],
        limit: 100
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
   * Get new mentions since timestamp
   * Uses the byMentionedUser index: [mentionedUserId, $createdAt]
   */
  async getNewMentions(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: MENTION_CONTRACT_ID,
        documentTypeName: 'postMention',
        where: [
          ['mentionedUserId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'asc']],
        limit: 100
      } as any);

      const documents = normalizeSDKResponse(response);

      return documents.map((doc: any) => {
        const rawPostId = doc.postId || (doc.data && doc.data.postId);
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
   * Enrich raw notifications with user profiles and post data
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

    // Batch fetch all required data in parallel
    const [usernameMap, profiles, avatarUrls, posts] = await Promise.all([
      dpnsService.resolveUsernamesBatch(userIds),
      unifiedProfileService.getProfilesByIdentityIds(userIds),
      unifiedProfileService.getAvatarUrlsBatch(userIds),
      postIds.length > 0 ? this.fetchPostsByIds(postIds) : Promise.resolve(new Map<string, Post>())
    ]);

    // Transform to Notification type
    return rawNotifications.map(raw => {
      const profile = profiles.find(p => p.$ownerId === raw.fromUserId);
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
    // 7 days ago in milliseconds
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    const [followers, mentions] = await Promise.all([
      this.getNewFollowers(userId, sevenDaysAgo),
      this.getNewMentions(userId, sevenDaysAgo)
    ]);

    const rawNotifications = [...followers, ...mentions];

    // Sort by createdAt descending (newest first)
    rawNotifications.sort((a, b) => b.createdAt - a.createdAt);

    const notifications = await this.enrichNotifications(rawNotifications, readIds);

    const latestTimestamp = rawNotifications.length > 0
      ? Math.max(...rawNotifications.map(n => n.createdAt))
      : Date.now();

    return { notifications, latestTimestamp };
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
    const [followers, mentions] = await Promise.all([
      this.getNewFollowers(userId, sinceTimestamp),
      this.getNewMentions(userId, sinceTimestamp)
    ]);

    const rawNotifications = [...followers, ...mentions];

    // Sort by createdAt descending (newest first)
    rawNotifications.sort((a, b) => b.createdAt - a.createdAt);

    const notifications = await this.enrichNotifications(rawNotifications, readIds);

    const latestTimestamp = rawNotifications.length > 0
      ? Math.max(...rawNotifications.map(n => n.createdAt))
      : sinceTimestamp;

    return { notifications, latestTimestamp };
  }
}

// Singleton instance
export const notificationService = new NotificationService();
