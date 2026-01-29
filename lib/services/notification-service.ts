import { getEvoSdk } from './evo-sdk-service';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { normalizeSDKResponse, identifierToBase58, queryDocuments, QueryDocumentsOptions } from './sdk-helpers';
import { YAPPR_CONTRACT_ID, YAPPR_DM_CONTRACT_ID, YAPPR_STOREFRONT_CONTRACT_ID } from '../constants';
import { Notification, User, Post, OrderStatus } from '../types';

// Constants for notification queries
const NOTIFICATION_QUERY_LIMIT = 100;
const INITIAL_FETCH_DAYS = 7;
const INITIAL_FETCH_MS = INITIAL_FETCH_DAYS * 24 * 60 * 60 * 1000;

/**
 * Private feed notification types
 */
type PrivateFeedNotificationType = 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked';

/**
 * Engagement notification types
 */
type EngagementNotificationType = 'like' | 'repost' | 'reply';

/**
 * DM and store notification types
 */
type DmNotificationType = 'newMessage';
type StoreNotificationType = 'orderReceived' | 'orderStatusUpdate' | 'newReview';

/**
 * Raw notification data before enrichment
 */
interface RawNotification {
  id: string;
  type: 'follow' | 'mention' | PrivateFeedNotificationType | EngagementNotificationType | DmNotificationType | StoreNotificationType;
  fromUserId: string;
  postId?: string;
  parentId?: string; // For reply notifications: the ID of the post/reply being replied to
  replyContent?: string; // For reply notifications: pre-fetched content to avoid re-querying
  createdAt: number;
  // DM notification fields
  conversationId?: string;
  messagePreview?: string;
  // Store notification fields
  orderId?: string;
  storeId?: string;
  storeName?: string;
  orderStatus?: OrderStatus;
  // Review notification fields
  reviewRating?: number;
  reviewTitle?: string;
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
   * Get likes on user's posts since timestamp (for notification queries).
   * Uses the postOwnerLikes index via likeService.getLikesOnMyPosts()
   */
  async getLikeNotifications(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const { likeService } = await import('./like-service');
      const likes = await likeService.getLikesOnMyPosts(userId, new Date(sinceTimestamp));

      return likes
        .filter(like => like.$ownerId !== userId) // Exclude self-likes
        .map(like => ({
          id: `like-${like.$id}`,
          type: 'like' as const,
          fromUserId: like.$ownerId,
          postId: like.postId,
          createdAt: like.$createdAt
        }));
    } catch (error) {
      console.error('Error fetching like notifications:', error);
      return [];
    }
  }

  /**
   * Get reposts of user's posts since timestamp (for notification queries).
   * Uses the postOwnerReposts index via repostService.getRepostsOfMyPosts()
   */
  async getRepostNotifications(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const { repostService } = await import('./repost-service');
      const reposts = await repostService.getRepostsOfMyPosts(userId, new Date(sinceTimestamp));

      return reposts
        .filter(repost => repost.$ownerId !== userId) // Exclude self-reposts
        .map(repost => ({
          id: `repost-${repost.$id}`,
          type: 'repost' as const,
          fromUserId: repost.$ownerId,
          postId: repost.postId,
          createdAt: repost.$createdAt
        }));
    } catch (error) {
      console.error('Error fetching repost notifications:', error);
      return [];
    }
  }

  /**
   * Get replies to user's content since timestamp (for notification queries).
   * Uses the parentOwnerAndTime index via replyService.getRepliesToMyContent()
   */
  async getReplyNotifications(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const { replyService } = await import('./reply-service');
      const replies = await replyService.getRepliesToMyContent(userId, new Date(sinceTimestamp));

      return replies
        .filter(reply => reply.author.id !== userId) // Exclude self-replies
        .map(reply => ({
          id: `reply-${reply.id}`,
          type: 'reply' as const,
          fromUserId: reply.author.id,
          postId: reply.id, // The reply itself
          parentId: reply.parentId, // The post/reply that was replied to (for navigation)
          replyContent: reply.content, // Pre-fetched content to avoid re-querying
          createdAt: reply.createdAt.getTime()
        }));
    } catch (error) {
      console.error('Error fetching reply notifications:', error);
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
        dataContractId: YAPPR_CONTRACT_ID,
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
   * Get new direct messages since timestamp (for notification queries).
   * Uses the receiverMessages index: [recipientId, $createdAt]
   */
  async getNewMessages(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_DM_CONTRACT_ID,
        documentTypeName: 'directMessage',
        where: [
          ['recipientId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['recipientId', 'asc'], ['$createdAt', 'asc']],
        limit: NOTIFICATION_QUERY_LIMIT
      } as any);

      const documents = normalizeSDKResponse(response);

      return documents.map((doc: any) => {
        const conversationId = doc.conversationId ? identifierToBase58(doc.conversationId) : undefined;
        return {
          id: `message-${doc.$id}`,
          type: 'newMessage' as const,
          fromUserId: doc.$ownerId, // The sender
          conversationId: conversationId ?? undefined,
          createdAt: doc.$createdAt
        };
      });
    } catch (error) {
      console.error('Error fetching new messages:', error);
      return [];
    }
  }

  /**
   * Get new orders received since timestamp (for seller notifications).
   * Uses the sellerOrders index: [sellerId, $createdAt]
   */
  async getNewOrders(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
        documentTypeName: 'storeOrder',
        where: [
          ['sellerId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['sellerId', 'asc'], ['$createdAt', 'asc']],
        limit: NOTIFICATION_QUERY_LIMIT
      } as any);

      const documents = normalizeSDKResponse(response);

      return documents.map((doc: any) => {
        const storeId = doc.storeId ? identifierToBase58(doc.storeId) : undefined;
        return {
          id: `order-${doc.$id}`,
          type: 'orderReceived' as const,
          fromUserId: doc.$ownerId, // The buyer
          orderId: doc.$id,
          storeId: storeId ?? undefined,
          createdAt: doc.$createdAt
        };
      });
    } catch (error) {
      console.error('Error fetching new orders:', error);
      return [];
    }
  }

  /**
   * Get order status updates for orders placed by this user (buyer notifications).
   * Uses the orderAndTime index: [orderId, $createdAt]
   * We first need to get the user's orders, then query for status updates on those orders.
   */
  async getOrderStatusUpdates(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      // First, get orders placed by this user (as buyer)
      const ordersResponse = await sdk.documents.query({
        dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
        documentTypeName: 'storeOrder',
        where: [
          ['$ownerId', '==', userId]
        ],
        orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
        limit: NOTIFICATION_QUERY_LIMIT
      } as any);

      const orders = normalizeSDKResponse(ordersResponse);
      if (orders.length === 0) return [];

      // Get order IDs
      const orderIds = orders.map((order: any) => order.$id);

      // Query status updates for these orders since timestamp
      // We need to chunk the order IDs to avoid exceeding platform limits
      const chunkArray = <T>(arr: T[], size: number): T[][] => {
        const chunks: T[][] = [];
        for (let i = 0; i < arr.length; i += size) {
          chunks.push(arr.slice(i, i + size));
        }
        return chunks;
      };

      const orderChunks = chunkArray(orderIds, NOTIFICATION_QUERY_LIMIT);
      const statusUpdatePromises = orderChunks.map(chunk =>
        sdk.documents.query({
          dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
          documentTypeName: 'orderStatusUpdate',
          where: [
            ['orderId', 'in', chunk],
            ['$createdAt', '>', sinceTimestamp]
          ],
          limit: NOTIFICATION_QUERY_LIMIT
        } as any).then(normalizeSDKResponse).catch(() => [])
      );

      const statusUpdateResults = await Promise.all(statusUpdatePromises);
      const statusUpdates = statusUpdateResults.flat();

      // Build a map of orderId -> storeId from orders for enrichment
      const orderStoreMap = new Map<string, string>();
      for (const order of orders as any[]) {
        const storeId = order.storeId ? identifierToBase58(order.storeId) : undefined;
        if (storeId) {
          orderStoreMap.set(order.$id, storeId);
        }
      }

      return statusUpdates.map((doc: any) => {
        const orderId = (doc.orderId ? identifierToBase58(doc.orderId) : null) ?? doc.$id;
        return {
          id: `status-${doc.$id}`,
          type: 'orderStatusUpdate' as const,
          fromUserId: doc.$ownerId, // The seller who posted the update
          orderId,
          storeId: orderStoreMap.get(orderId),
          orderStatus: doc.status as OrderStatus,
          createdAt: doc.$createdAt
        };
      });
    } catch (error) {
      console.error('Error fetching order status updates:', error);
      return [];
    }
  }

  /**
   * Get new reviews on seller's store since timestamp (seller notifications).
   * Uses the sellerReviews index: [sellerId, $createdAt]
   */
  async getNewReviews(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
        documentTypeName: 'storeReview',
        where: [
          ['sellerId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['sellerId', 'asc'], ['$createdAt', 'asc']],
        limit: NOTIFICATION_QUERY_LIMIT
      } as any);

      const documents = normalizeSDKResponse(response);

      return documents.map((doc: any) => {
        const storeId = doc.storeId ? identifierToBase58(doc.storeId) : undefined;
        const orderId = doc.orderId ? identifierToBase58(doc.orderId) : undefined;
        return {
          id: `review-${doc.$id}`,
          type: 'newReview' as const,
          fromUserId: doc.$ownerId, // The reviewer (buyer)
          storeId: storeId ?? undefined,
          orderId: orderId ?? undefined,
          reviewRating: doc.rating,
          reviewTitle: doc.title,
          createdAt: doc.$createdAt
        };
      });
    } catch (error) {
      console.error('Error fetching new reviews:', error);
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

      // For reply notifications, use pre-fetched data and ensure parentId is set for navigation
      let post: Post | undefined;
      if (raw.type === 'reply' && raw.replyContent !== undefined) {
        // Use pre-fetched reply data directly - more reliable than re-querying
        post = {
          id: raw.postId || '',
          author: user, // The reply author is the notification sender
          content: raw.replyContent,
          createdAt: new Date(raw.createdAt),
          likes: 0,
          reposts: 0,
          replies: 0,
          views: 0,
          liked: false,
          reposted: false,
          bookmarked: false,
          parentId: raw.parentId // Critical for UI navigation to the parent post
        };
      } else {
        // For other notification types, use fetched post data
        post = raw.postId ? posts.get(raw.postId) : undefined;
      }

      return {
        id: raw.id,
        type: raw.type,
        from: user,
        post,
        createdAt: new Date(raw.createdAt),
        read: readIds.has(raw.id),
        // DM notification fields
        conversationId: raw.conversationId,
        messagePreview: raw.messagePreview,
        // Store notification fields
        orderId: raw.orderId,
        storeId: raw.storeId,
        storeName: raw.storeName,
        orderStatus: raw.orderStatus,
        // Review notification fields
        reviewRating: raw.reviewRating,
        reviewTitle: raw.reviewTitle
      };
    });
  }

  /**
   * Fetch posts and replies by IDs for notification display.
   * First tries to fetch from posts collection, then fetches remaining IDs from replies.
   * For replies, includes parentId so UI can navigate to the parent post.
   * Handles chunking to avoid exceeding platform's 100-item "in" limit.
   */
  private async fetchPostsByIds(postIds: string[]): Promise<Map<string, Post>> {
    const result = new Map<string, Post>();
    if (postIds.length === 0) return result;

    try {
      const sdk = await getEvoSdk();

      // Helper to chunk an array into smaller arrays
      const chunkArray = <T>(arr: T[], size: number): T[][] => {
        const chunks: T[][] = [];
        for (let i = 0; i < arr.length; i += size) {
          chunks.push(arr.slice(i, i + size));
        }
        return chunks;
      };

      // First, try to fetch from posts collection (chunked to avoid platform limit)
      const postChunks = chunkArray(postIds, NOTIFICATION_QUERY_LIMIT);
      const postQueryPromises = postChunks.map(chunk => {
        const options: QueryDocumentsOptions = {
          dataContractId: YAPPR_CONTRACT_ID,
          documentTypeName: 'post',
          where: [['$id', 'in', chunk]],
          limit: chunk.length
        };
        return queryDocuments(sdk, options);
      });
      const postResponses = await Promise.all(postQueryPromises);
      const postDocuments = postResponses.flat();
      const foundPostIds = new Set<string>();

      for (const doc of postDocuments) {
        const docData = doc as Record<string, unknown>;
        const nestedData = docData.data as Record<string, unknown> | undefined;
        const id = docData.$id as string;
        const ownerId = docData.$ownerId as string;
        const createdAt = docData.$createdAt as number;
        // Check both top-level and nested locations for content
        const content = (docData.content as string) || (nestedData?.content as string) || '';

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
        foundPostIds.add(id);
      }

      // Find IDs not found in posts collection (these might be replies)
      const missingIds = postIds.filter(id => !foundPostIds.has(id));

      if (missingIds.length > 0) {
        // Try to fetch from replies collection (chunked to avoid platform limit)
        const replyChunks = chunkArray(missingIds, NOTIFICATION_QUERY_LIMIT);
        const replyQueryPromises = replyChunks.map(chunk => {
          const options: QueryDocumentsOptions = {
            dataContractId: YAPPR_CONTRACT_ID,
            documentTypeName: 'reply',
            where: [['$id', 'in', chunk]],
            limit: chunk.length
          };
          return queryDocuments(sdk, options);
        });
        const replyResponses = await Promise.all(replyQueryPromises);
        const replyDocuments = replyResponses.flat();

        for (const doc of replyDocuments) {
          const docData = doc as Record<string, unknown>;
          const nestedData = docData.data as Record<string, unknown> | undefined;
          const id = docData.$id as string;
          const ownerId = docData.$ownerId as string;
          const createdAt = docData.$createdAt as number;
          // Check both top-level and nested locations for content
          const content = (docData.content as string) || (nestedData?.content as string) || '';

          // Extract parentId from reply - check both top-level and nested locations
          const rawParentId = docData.parentId || nestedData?.parentId;
          const parentId = rawParentId ? identifierToBase58(rawParentId) || undefined : undefined;

          // Create a Post object from the reply, including parentId for navigation
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
            bookmarked: false,
            parentId // Include parentId so UI can navigate to the parent post
          };
          result.set(id, post);
        }
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
   * Core notification fetching logic.
   * Fetches all notification types in parallel batches for efficiency.
   */
  private async fetchNotifications(
    userId: string,
    sinceTimestamp: number,
    readIds: Set<string>,
    fallbackTimestamp: number
  ): Promise<NotificationResult> {
    // Batch 1: Social notifications (existing)
    // Batch 2: DM and store notifications (new)
    // All queries run in parallel for efficiency
    const [
      followers,
      mentions,
      privateFeed,
      likes,
      reposts,
      replies,
      messages,
      newOrders,
      statusUpdates,
      newReviews
    ] = await Promise.all([
      // Social notifications
      this.getNewFollowers(userId, sinceTimestamp),
      this.getNewMentions(userId, sinceTimestamp),
      this.getPrivateFeedNotifications(userId, sinceTimestamp),
      this.getLikeNotifications(userId, sinceTimestamp),
      this.getRepostNotifications(userId, sinceTimestamp),
      this.getReplyNotifications(userId, sinceTimestamp),
      // DM notifications
      this.getNewMessages(userId, sinceTimestamp),
      // Store notifications
      this.getNewOrders(userId, sinceTimestamp),
      this.getOrderStatusUpdates(userId, sinceTimestamp),
      this.getNewReviews(userId, sinceTimestamp)
    ]);

    const rawNotifications = [
      ...followers,
      ...mentions,
      ...privateFeed,
      ...likes,
      ...reposts,
      ...replies,
      ...messages,
      ...newOrders,
      ...statusUpdates,
      ...newReviews
    ];
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
