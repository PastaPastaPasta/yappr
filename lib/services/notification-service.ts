import { logger } from '@/lib/logger';
import { queryDocumentBundle } from './document-query-bundle';
import { getEvoSdk } from './evo-sdk-service';
import { loadIdentityBatch } from './identity-batch';
import { identifierToBase58, queryDocuments, QueryDocumentsOptions } from './sdk-helpers';
import { YAPPR_CONTRACT_ID, blogIsV2 } from '../constants';
import { Notification, User, Post } from '../../types';
import { truncateId } from '../utils';
import { isPublishedBlogPost } from '../blog/content-utils';
import { likesAreIndexOnly, likeNotificationsPinTarget, likeSurfacesAreSplit, likeIndexFor, mentionDocTypes, mentionsAreInline, notificationWindowFor, notificationsAreWindowed, replyLinkage, repostsAreQuotes, type TargetKind } from '../contract-topology';
import { quoteNotificationType, quotedTargetIdOf } from '../feed/quote-reposts';
import { readNotificationWindow } from './notification-windows';

// Constants for notification queries
const NOTIFICATION_QUERY_LIMIT = 100;
const INITIAL_FETCH_DAYS = 7;
const INITIAL_FETCH_MS = INITIAL_FETCH_DAYS * 24 * 60 * 60 * 1000;

/**
 * Private feed notification types
 */
type PrivateFeedNotificationType = 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked';

/**
 * Engagement notification types. `quote` is v10 only: a quote with text of the
 * user's post or reply (a bare quote is a v10 repost, and notifies as one).
 */
type EngagementNotificationType = 'like' | 'repost' | 'quote' | 'reply';

/**
 * Blog notification types. `blogPost` is "a blog you follow published";
 * `blogComment` is "someone commented on your post" — the v2 contract's
 * `postOwnerAndTime` index, which does not exist on v1.
 */
type BlogNotificationType = 'blogPost' | 'blogComment';

/**
 * Raw notification data before enrichment
 */
interface RawNotification {
  id: string;
  type: 'follow' | 'mention' | PrivateFeedNotificationType | EngagementNotificationType | BlogNotificationType;
  fromUserId: string;
  postId?: string;
  /**
   * The kind of the recipient's OWN content that was engaged with — a post or a
   * reply. Drives the notification wording, so it describes the *target*, not the
   * engagement: for a reply notification it is the kind of the thing replied to.
   * Left undefined on v2, where the doctypes are polymorphic and the two are
   * indistinguishable.
   */
  targetKind?: TargetKind;
  parentId?: string; // For reply notifications: the ID of the post/reply being replied to
  rootPostId?: string; // v9 reply notifications: the thread root, which is where the link goes
  replyContent?: string; // For reply (and v10 reply-mention) notifications: pre-fetched content to avoid re-querying
  sensitive?: boolean; // With replyContent: the pre-fetched reply's own sensitive flag
  blogId?: string;
  blogPostTitle?: string;
  blogPostSlug?: string;
  /** blogComment only: the comment text, shown instead of the post title. */
  blogCommentContent?: string;
  createdAt: number;
}

/**
 * What a reply was a reply TO — which is what the notification's wording is
 * about, not the reply itself. A nested reply names the reply it answers; a
 * top-level one answers the thread's root post. Unknowable on v2, where a reply
 * has one polymorphic parent id and no root link.
 */
function repliedToKind(reply: { rootPostId?: string; replyToReplyId?: string }): TargetKind | undefined {
  if (!reply.rootPostId) return undefined;
  return reply.replyToReplyId ? 'reply' : 'post';
}

/**
 * A permanent `[recipient, $createdAt]` source's events since the watermark,
 * newest first: a source with more than a page of them keeps its most recent
 * ones, and every sibling walks the same direction, as a composite requires.
 */
function recentQuery(userId: string, sinceTimestamp: number, documentTypeName: string, ownerField: string): QueryDocumentsOptions {
  return {
    dataContractId: YAPPR_CONTRACT_ID, documentTypeName,
    where: [[ownerField, '==', userId], ['$createdAt', '>', sinceTimestamp]],
    orderBy: [[ownerField, 'asc'], ['$createdAt', 'desc']], limit: NOTIFICATION_QUERY_LIMIT,
  };
}

type Documents = Record<string, unknown>[];

/** A notification bundle's results, cut back into its permanent sources. */
interface PermanentSourceResults {
  follows: Documents;
  /** One per mention doctype (`mentionDocTypes`). */
  mentions: Documents[];
  followRequests: Documents;
  /** One per bundled like kind. */
  likes: Documents[];
  /** Whatever the caller bundled after the permanent sources. */
  rest: Documents[];
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
  async getNewFollowers(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[]): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      const documents = preloaded ?? await queryDocuments(sdk, {
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'follow',
        where: [
          ['followingId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['followingId', 'asc'], ['$createdAt', 'desc']],
        limit: NOTIFICATION_QUERY_LIMIT
      });

      return documents.map((doc) => ({
        id: doc.$id as string,
        type: 'follow' as const,
        fromUserId: doc.$ownerId as string, // The follower
        createdAt: doc.$createdAt as number
      }));
    } catch (error) {
      logger.error('Error fetching new followers:', error);
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
  async getPrivateFeedNotifications(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[]): Promise<RawNotification[]> {
    try {
      const sdk = await getEvoSdk();

      // Query followRequest documents where this user is the target (feed owner)
      // This discovers incoming private feed access requests
      const documents = preloaded ?? await queryDocuments(sdk, {
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'followRequest',
        where: [
          ['targetId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['targetId', 'asc'], ['$createdAt', 'desc']],
        limit: NOTIFICATION_QUERY_LIMIT
      });

      return documents.map((doc) => ({
        id: doc.$id as string,
        type: 'privateFeedRequest' as const,
        fromUserId: doc.$ownerId as string, // The requester
        createdAt: doc.$createdAt as number
      }));
    } catch (error) {
      logger.error('Error fetching private feed request notifications:', error);
      return [];
    }
  }

  /**
   * Get likes on the user's content since timestamp (for notification queries).
   *
   * On v2 one `like` doctype holds likes of posts AND of replies, so one query is
   * the complete answer. The v9 topology splits reply likes off into `likeReply`,
   * which is a second owner-index to read and merge — and the merge must NOT run
   * on v2, where it would return the same documents twice. On v10 neither kind
   * rides the bundle: each is a fan-out over the user's recent posts or replies
   * (see `likeService.getLikesOnMyPosts`), so `preloaded` is absent.
   */
  async getLikeNotifications(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[][]): Promise<RawNotification[]> {
    try {
      const { likeService } = await import('./like-service');
      const since = new Date(sinceTimestamp);
      const kinds: TargetKind[] = likeSurfacesAreSplit() ? ['post', 'reply'] : ['post'];

      const perKind = await Promise.all(
        kinds.map((kind, index) => likeService.getLikesOnMyPosts(userId, since, kind, preloaded?.[index]))
      );

      // indexOnly likes have no stable `$id` — the create-time id and the ids
      // synthesized by queries differ — so read-state keys on (owner, target)
      // plus the like's consensus timestamp. The timestamp matters: read-state
      // persists across sessions, and without it an unlike→re-like would reuse
      // the old id and arrive permanently marked as read.
      const likeNotificationId = (like: { $id: string; $ownerId: string; $createdAt: number; postId: string; targetKind: TargetKind }) =>
        likesAreIndexOnly()
          ? `like-${like.targetKind}-${like.$ownerId}:${like.postId}:${like.$createdAt}`
          : `like-${like.$id}`;

      return perKind
        .flat()
        .map(like => ({
          id: likeNotificationId(like),
          type: 'like' as const,
          fromUserId: like.$ownerId,
          postId: like.postId,
          targetKind: like.targetKind,
          createdAt: like.$createdAt
        }));
    } catch (error) {
      logger.error('Error fetching like notifications:', error);
      return [];
    }
  }

  /**
   * Get reposts of user's posts since timestamp (for notification queries).
   * Uses the postOwnerReposts index via repostService.getRepostsOfMyPosts().
   * On v10 reposts are quote posts: see {@link getQuoteNotifications}.
   */
  async getRepostNotifications(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[]): Promise<RawNotification[]> {
    if (repostsAreQuotes()) return this.getQuoteNotifications(userId, sinceTimestamp, preloaded);
    try {
      const { repostService } = await import('./repost-service');
      const reposts = await repostService.getRepostsOfMyPosts(userId, new Date(sinceTimestamp), preloaded);

      return reposts
        .map(repost => ({
          id: `repost-${repost.$id}`,
          type: 'repost' as const,
          fromUserId: repost.$ownerId,
          postId: repost.postId,
          createdAt: repost.$createdAt
        }));
    } catch (error) {
      logger.error('Error fetching repost notifications:', error);
      return [];
    }
  }

  /**
   * v10: reposts AND quotes of the user's posts and replies, since timestamp.
   * Both are `post` documents naming the user in `quotedPostOwnerId` (bound by
   * consensus to the quoted document's owner), read off the two open
   * `post.quotedPostOwnerRecent [$createdAt, quotedPostOwnerId]` windows and
   * since-filtered client-side (see readNotificationWindow). A bare quote
   * notifies as `repost` and links to the reposted post or reply; a quote with
   * text notifies as `quote` and links to the quote.
   */
  async getQuoteNotifications(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[]): Promise<RawNotification[]> {
    try {
      const window = notificationWindowFor('quote');
      const documents = preloaded ?? (window
        ? await readNotificationWindow(window, userId, sinceTimestamp)
        : await queryDocuments(await getEvoSdk(), {
          dataContractId: YAPPR_CONTRACT_ID,
          documentTypeName: 'post',
          where: [['quotedPostOwnerId', '==', userId], ['$createdAt', '>', sinceTimestamp]],
          orderBy: [['quotedPostOwnerId', 'asc'], ['$createdAt', 'desc']],
          limit: NOTIFICATION_QUERY_LIMIT,
        }));
      const { transformRawPost } = await import('../feed/transform-raw-post');
      return documents.map((doc) => transformRawPost(doc)).flatMap((post): RawNotification[] => {
        const targetId = quotedTargetIdOf(post);
        if (!targetId) return [];
        const type = quoteNotificationType(post);
        return [{
          id: `${type}-${post.id}`,
          type,
          fromUserId: post.author.id,
          postId: type === 'repost' ? targetId : post.id,
          targetKind: post.quotedReplyId ? 'reply' : 'post',
          createdAt: post.createdAt.getTime(),
        }];
      });
    } catch (error) {
      logger.error('Error fetching repost and quote notifications:', error);
      return [];
    }
  }

  /**
   * Get replies to user's content since timestamp (for notification queries).
   * Uses the parentOwnerAndTime index (v10: the parentOwnerRecent window) via
   * replyService.getRepliesToMyContent()
   */
  async getReplyNotifications(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[]): Promise<RawNotification[]> {
    try {
      const { replyService } = await import('./reply-service');
      const replies = await replyService.getRepliesToMyContent(userId, new Date(sinceTimestamp), preloaded);

      return replies
        .map(reply => ({
          id: `reply-${reply.id}`,
          type: 'reply' as const,
          fromUserId: reply.author.id,
          postId: reply.id, // The reply itself
          targetKind: repliedToKind(reply),
          parentId: reply.parentId, // The post/reply that was replied to (for navigation)
          // v9: the reply names its thread root, so the link can go straight to
          // the thread instead of to whatever intermediate reply it answers.
          rootPostId: reply.rootPostId,
          replyContent: reply.content, // Pre-fetched content to avoid re-querying
          sensitive: reply.sensitive,
          createdAt: reply.createdAt.getTime()
        }));
    } catch (error) {
      logger.error('Error fetching reply notifications:', error);
      return [];
    }
  }

  /**
   * Get new mentions since timestamp, off `[mentionedUserId, $createdAt]`:
   * `postMention.mentionedUserAndTime` on v2/v9, the mentioning posts' and
   * replies' own `mentionedUserAndTime` on v10
   * ({@link getMentioningPostNotifications}). `preloaded` holds one result per
   * doctype of {@link mentionDocTypes}, in its order.
   */
  async getNewMentions(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[][]): Promise<RawNotification[]> {
    if (mentionsAreInline()) return this.getMentioningPostNotifications(userId, sinceTimestamp, preloaded);
    try {
      const sdk = await getEvoSdk();

      const documents = preloaded?.[0] ?? await queryDocuments(sdk, {
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'postMention',
        where: [
          ['mentionedUserId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'desc']],
        limit: NOTIFICATION_QUERY_LIMIT
      });

      return documents.map((doc) => {
        const postId = doc.postId ? identifierToBase58(doc.postId) : undefined;

        return {
          id: doc.$id as string,
          type: 'mention' as const,
          fromUserId: doc.$ownerId as string, // The post author who mentioned the user
          postId: postId || undefined,
          createdAt: doc.$createdAt as number
        };
      });
    } catch (error) {
      logger.error('Error fetching new mentions:', error);
      return [];
    }
  }

  /**
   * v10: posts and replies naming the user in `mentionedUserId`, since
   * timestamp. The document IS the mention (only its author can write it), so
   * its id, author and exact `$createdAt` are the notification's. A mentioning
   * reply carries its thread linkage and content, so the notification links to
   * the reply itself (shown with its thread root) without a re-read.
   */
  private async getMentioningPostNotifications(userId: string, sinceTimestamp: number, preloaded?: Record<string, unknown>[][]): Promise<RawNotification[]> {
    try {
      const [posts, replies] = preloaded ?? await Promise.all(mentionDocTypes().map(async (docType) =>
        queryDocuments(await getEvoSdk(), recentQuery(userId, sinceTimestamp, docType, 'mentionedUserId'))));
      const fromPosts = (posts ?? []).flatMap((doc): RawNotification[] => typeof doc.$id === 'string' && typeof doc.$ownerId === 'string'
        ? [{ id: `mention-${doc.$id}`, type: 'mention', fromUserId: doc.$ownerId, postId: doc.$id, createdAt: Number(doc.$createdAt) }]
        : []);
      if (!replies || replies.length === 0) return fromPosts;
      const { replyService } = await import('./reply-service');
      const fromReplies = replies.flatMap((doc): RawNotification[] => {
        if (typeof doc.$id !== 'string' || typeof doc.$ownerId !== 'string') return [];
        const reply = replyService.fromDocument(doc);
        return [{
          id: `mention-${reply.id}`,
          type: 'mention',
          fromUserId: reply.author.id,
          postId: reply.id,
          parentId: reply.parentId,
          rootPostId: reply.rootPostId,
          replyContent: reply.content,
          sensitive: reply.sensitive,
          createdAt: reply.createdAt.getTime(),
        }];
      });
      return [...fromPosts, ...fromReplies];
    } catch (error) {
      logger.error('Error fetching new mentions:', error);
      return [];
    }
  }

  /**
   * Get blog post notifications for blogs the user follows.
   * Queries followed blogs, then fetches recent posts from each.
   */
  async getBlogPostNotifications(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    try {
      const { blogFollowService } = await import('./blog-follow-service');
      const { blogPostService } = await import('./blog-post-service');

      const followedBlogIds = await blogFollowService.getFollowedBlogIds(userId);
      if (followedBlogIds.length === 0) return [];

      const pages = await blogPostService.getPostsByBlogs(followedBlogIds, 10);
      return Array.from(pages.entries()).flatMap(([blogId, posts]) => posts
        // A draft is not a new post for the blog's followers.
        .filter(post => post.createdAt.getTime() > sinceTimestamp && isPublishedBlogPost(post))
        .map(post => ({
          id: `blogPost-${post.id}`, type: 'blogPost' as const, fromUserId: post.ownerId,
          postId: post.id, blogId, blogPostTitle: post.title, blogPostSlug: post.slug,
          createdAt: post.createdAt.getTime(),
        })));

    } catch (error) {
      logger.error('Error fetching blog post notifications:', error);
      return [];
    }
  }

  /**
   * Comments other people left on the user's own blog posts — one page of the
   * v2 `postOwnerAndTime` index plus one by-id fetch for the posts they name
   * (needed for the link and the title). On v1 the index does not exist and the
   * source is empty.
   */
  async getBlogCommentNotifications(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    if (!blogIsV2()) return [];
    try {
      const { blogCommentService } = await import('./blog-comment-service');
      const { blogPostService } = await import('./blog-post-service');

      const comments = await blogCommentService.getCommentsOnMyPosts(userId, sinceTimestamp, NOTIFICATION_QUERY_LIMIT);
      if (comments.length === 0) return [];

      const posts = new Map(
        (await blogPostService.getMany(Array.from(new Set(comments.map(c => c.blogPostId)))))
          .map(post => [post.id, post])
      );
      return comments.flatMap(comment => {
        const post = posts.get(comment.blogPostId);
        // `blogPostOwnerId` is pinned by consensus to the post's own `$ownerId`,
        // so a row on this index is by construction a comment on this user's
        // post — this drops only rows whose post did not come back (a read
        // failure), since there is no title or link to render without it.
        if (!post) return [];
        return [{
          id: `blogComment-${comment.id}`, type: 'blogComment' as const, fromUserId: comment.ownerId,
          postId: post.id, blogId: post.blogId, blogPostTitle: post.title, blogPostSlug: post.slug,
          blogCommentContent: comment.content, createdAt: comment.createdAt.getTime(),
        }];
      });
    } catch (error) {
      logger.error('Error fetching blog comment notifications:', error);
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
      rawNotifications.flatMap(n => (
        n.postId && n.type !== 'blogPost' && n.type !== 'blogComment' && n.replyContent === undefined ? [n.postId] : []
      ))
    ));

    // Batch fetch all required data in parallel with fault tolerance
    const results = await Promise.allSettled([
      loadIdentityBatch(userIds),
      postIds.length > 0 ? this.fetchPostsByIds(postIds) : Promise.resolve(new Map<string, Post>())
    ]);

    // Extract results with fallbacks for failures
    const { usernames: usernameMap, profiles, avatars: avatarUrls } = results[0].status === 'fulfilled'
      ? results[0].value
      : { usernames: new Map<string, string | null>(), profiles: [], avatars: new Map<string, string>() };
    const posts = results[1].status === 'fulfilled'
      ? results[1].value
      : new Map<string, Post>();

    // Log any enrichment failures for debugging
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const fetchTypes = ['identities', 'posts'];
        logger.error(`Failed to fetch ${fetchTypes[index]} for notification enrichment:`, result.reason);
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

      // For reply notifications (and v10 mentions made in a reply), use
      // pre-fetched data and ensure parentId is set for navigation
      let post: Post | undefined;
      if ((raw.type === 'reply' || raw.type === 'mention') && raw.replyContent !== undefined) {
        // Use pre-fetched reply data directly - more reliable than re-querying
        post = {
          id: raw.postId || '',
          targetKind: 'reply',
          author: user, // The reply author is the notification sender
          content: raw.replyContent,
          createdAt: new Date(raw.createdAt),
          likes: 0,
          reposts: 0,
          replies: 0,
          quotes: 0,
          views: 0,
          liked: false,
          reposted: false,
          bookmarked: false,
          parentId: raw.parentId, // Critical for UI navigation to the parent post
          rootPostId: raw.rootPostId,
          sensitive: raw.sensitive ? true : undefined
        };
      } else {
        // For other notification types, use fetched post data
        post = raw.postId ? posts.get(raw.postId) : undefined;
      }

      // Blog notifications have no social post: synthesise a card carrying the
      // post title (a new post) or the comment text (a comment on your post).
      if ((raw.type === 'blogPost' || raw.type === 'blogComment') && raw.blogPostTitle) {
        post = {
          id: raw.postId || '',
          author: user,
          content: raw.blogCommentContent ?? raw.blogPostTitle,
          createdAt: new Date(raw.createdAt),
          likes: 0,
          reposts: 0,
          replies: 0,
          quotes: 0,
          views: 0,
          liked: false,
          reposted: false,
          bookmarked: false,
        };
      }

      return {
        id: raw.id,
        type: raw.type,
        from: user,
        post,
        createdAt: new Date(raw.createdAt),
        read: readIds.has(raw.id),
        blogId: raw.blogId,
        blogPostSlug: raw.blogPostSlug,
        targetKind: raw.targetKind,
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
          quotes: 0,
          views: 0,
          liked: false,
          reposted: false,
          bookmarked: false,
          sensitive: (docData.sensitive ?? nestedData?.sensitive) === true ? true : undefined
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

          // Extract the reply's parent linkage in whichever fields this topology
          // declares, so the notification can link into the thread.
          const { root: rootField, replyToReply: replyToReplyField } = replyLinkage();
          const linkageId = (field: string): string | undefined => {
            const raw = docData[field] || nestedData?.[field];
            return raw ? identifierToBase58(raw) || undefined : undefined;
          };
          const rootPostId = replyToReplyField ? linkageId(rootField) : undefined;
          const parentId = replyToReplyField
            ? (linkageId(replyToReplyField) ?? rootPostId)
            : linkageId('parentId');

          // Create a Post object from the reply, including parentId for navigation
          const post: Post = {
            id,
            targetKind: 'reply',
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
            quotes: 0,
            views: 0,
            liked: false,
            reposted: false,
            bookmarked: false,
            parentId, // Include parentId so UI can navigate to the parent post
            rootPostId,
            sensitive: (docData.sensitive ?? nestedData?.sensitive) === true ? true : undefined
          };
          result.set(id, post);
        }
      }
    } catch (error) {
      logger.error('Error fetching posts by IDs:', error);
    }

    return result;
  }

  /**
   * Helper to truncate identity ID for display
   */
  private truncateId(id: string): string {
    return truncateId(id, 6, 4);
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
    const [sourced, blogPosts, blogComments] = await Promise.all([
      notificationsAreWindowed()
        ? this.fetchWindowedSources(userId, sinceTimestamp)
        : this.fetchBundledSources(userId, sinceTimestamp),
      this.getBlogPostNotifications(userId, sinceTimestamp),
      this.getBlogCommentNotifications(userId, sinceTimestamp),
    ]);

    const allRaw = [...sourced, ...blogPosts, ...blogComments];

    // Drop self-notifications across every type (liking/reposting/replying to your
    // own content, mentioning yourself, your own posts in a blog you follow).
    // Newest first. On v10 the windowed sources come back in index order, so
    // this client-side sort is the only time ordering they get.
    const rawNotifications = allRaw.filter(n => n.fromUserId !== userId);
    rawNotifications.sort((a, b) => b.createdAt - a.createdAt);

    const notifications = await this.enrichNotifications(rawNotifications, readIds);

    // Advance the poll watermark past self-actions too, so filtered-out events
    // aren't re-fetched on every poll.
    const latestTimestamp = allRaw.length > 0
      ? Math.max(...allRaw.map(n => n.createdAt))
      : fallbackTimestamp;

    return { notifications, latestTimestamp };
  }

  /**
   * The permanent `[recipient, $createdAt]` notification sources, read
   * `$createdAt > since` newest first: follows, mentions (one source per
   * {@link mentionDocTypes}: `postMention`, or v10's `post` and `reply`),
   * follow requests and the likes of `kinds` (`like`, plus `likeReply` where
   * reply likes are split off; none on v10). `slice` cuts the bundle's
   * results back into those sources, in this order.
   */
  private permanentSources(userId: string, sinceTimestamp: number, kinds: TargetKind[]): {
    queries: QueryDocumentsOptions[];
    slice: (documents: Documents[]) => PermanentSourceResults;
  } {
    const mentionTypes = mentionDocTypes();
    const sources = [
      ['follow', 'followingId'], ...mentionTypes.map(docType => [docType, 'mentionedUserId']), ['followRequest', 'targetId'],
      ...kinds.map(kind => { const index = likeIndexFor(kind); if (!index.ownerField) throw new Error('Notification index has no author field'); return [index.docType, index.ownerField]; }),
    ];
    const requestsAt = 1 + mentionTypes.length;
    return {
      queries: sources.map(([documentTypeName, ownerField]) => recentQuery(userId, sinceTimestamp, documentTypeName, ownerField)),
      slice: (documents) => ({
        follows: documents[0],
        mentions: documents.slice(1, requestsAt),
        followRequests: documents[requestsAt],
        likes: documents.slice(requestsAt + 1, requestsAt + 1 + kinds.length),
        rest: documents.slice(sources.length),
      }),
    };
  }

  /**
   * v2 and v9: every source is a permanent `[recipient, $createdAt]` index,
   * all read in one bundle.
   */
  private async fetchBundledSources(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    const kinds: TargetKind[] = likeSurfacesAreSplit() ? ['post', 'reply'] : ['post'];
    const recent = (documentTypeName: string, ownerField: string) => recentQuery(userId, sinceTimestamp, documentTypeName, ownerField);
    // Newest first: a source with more than a page of events since the
    // watermark keeps its most recent ones. Oldest first returned the stale
    // end of the window, and the watermark (the newest event of ANY source)
    // then skipped everything the truncated source had not reached.
    const permanent = this.permanentSources(userId, sinceTimestamp, kinds);
    const { follows, mentions, followRequests, likes, rest: [reposts, replies] } = permanent.slice(await queryDocumentBundle([
      ...permanent.queries,
      recent('repost', 'postOwnerId'), recent('reply', 'parentOwnerId'),
    ], true));
    const perSource = await Promise.all([
      this.getNewFollowers(userId, sinceTimestamp, follows),
      this.getNewMentions(userId, sinceTimestamp, mentions),
      this.getPrivateFeedNotifications(userId, sinceTimestamp, followRequests),
      this.getLikeNotifications(userId, sinceTimestamp, likes),
      this.getRepostNotifications(userId, sinceTimestamp, reposts),
      this.getReplyNotifications(userId, sinceTimestamp, replies),
    ]);
    return perSource.flat();
  }

  /**
   * v10: follows, mentions (post and reply) and follow requests stay permanent
   * and ride one bundle (four members). Replies and quotes/reposts are two
   * open windows each, and `timeRange` is refused in a composite, so each
   * window is its own plain query, all in parallel: five requests a poll, plus
   * a page per full window. Likes (like design C) are per recent target,
   * outside the bundle ({@link likeNotificationsPinTarget}): per kind one
   * composite plus one read.
   */
  private async fetchWindowedSources(userId: string, sinceTimestamp: number): Promise<RawNotification[]> {
    const kinds: TargetKind[] = likeSurfacesAreSplit() ? ['post', 'reply'] : ['post'];
    const bundledLikeKinds = likeNotificationsPinTarget() ? [] : kinds;
    const sources = this.permanentSources(userId, sinceTimestamp, bundledLikeKinds);
    const permanent = queryDocumentBundle(sources.queries, true).then(sources.slice);
    const perSource = await Promise.all([
      permanent.then(({ follows }) => this.getNewFollowers(userId, sinceTimestamp, follows)),
      permanent.then(({ mentions }) => this.getNewMentions(userId, sinceTimestamp, mentions)),
      permanent.then(({ followRequests }) => this.getPrivateFeedNotifications(userId, sinceTimestamp, followRequests)),
      bundledLikeKinds.length > 0
        ? permanent.then(({ likes }) => this.getLikeNotifications(userId, sinceTimestamp, likes))
        : this.getLikeNotifications(userId, sinceTimestamp),
      this.getRepostNotifications(userId, sinceTimestamp),
      this.getReplyNotifications(userId, sinceTimestamp),
    ]);
    return perSource.flat();
  }
}

// Singleton instance
export const notificationService = new NotificationService();
