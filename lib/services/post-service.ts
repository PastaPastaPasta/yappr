import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Post, User, PostQueryOptions } from '../types';
import { identityService } from './identity-service';
import { dpnsService } from './dpns-service';
import { blockService } from './block-service';
import { followService } from './follow-service';
import { unifiedProfileService } from './unified-profile-service';
import { identifierToBase58, normalizeSDKResponse, RequestDeduplicator } from './sdk-helpers';
import { seedBlockStatusCache, seedFollowStatusCache } from '../caches/user-status-cache';
import { retryAsync } from '../retry-utils';

export interface PostDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  content: string;
  mediaUrl?: string;
  replyToId?: string;
  quotedPostId?: string;
  firstMentionId?: string;
  primaryHashtag?: string;
  language?: string;
  sensitive?: boolean;
}

export interface PostStats {
  postId: string;
  likes: number;
  reposts: number;
  replies: number;
  views: number;
}

class PostService extends BaseDocumentService<Post> {
  private statsCache: Map<string, { data: PostStats; timestamp: number }> = new Map();

  // Request deduplicators for batch/count operations
  private statsDeduplicator = new RequestDeduplicator<string, Map<string, PostStats>>();
  private repliesDeduplicator = new RequestDeduplicator<string, Map<string, number>>();
  private parentOwnersDeduplicator = new RequestDeduplicator<string, Map<string, string>>();
  private interactionsDeduplicator = new RequestDeduplicator<string, Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>>();
  private countUserPostsDeduplicator = new RequestDeduplicator<string, number>();
  private countAllPostsDeduplicator = new RequestDeduplicator<string, number>();
  private countUniqueAuthorsDeduplicator = new RequestDeduplicator<string, number>();

  constructor() {
    super('post');
  }

  /**
   * Transform document to Post type.
   * Returns a Post with default placeholder values - callers should use
   * enrichPostFull() or enrichPostsBatch() to populate stats and author data.
   */
  protected transformDocument(doc: any): Post {
    // SDK may nest document fields under 'data' property
    const data = doc.data || doc;

    // SDK v3 toJSON() returns:
    // - System fields ($id, $ownerId, $createdAt): base58 strings
    // - Byte array fields (replyToPostId, etc): base64 strings (need conversion)
    // Handle both $ prefixed (query responses) and non-prefixed (creation responses) fields
    const id = doc.$id || doc.id;
    const ownerId = doc.$ownerId || doc.ownerId;
    const createdAt = doc.$createdAt || doc.createdAt;

    // Content and other fields may be in data or at root level
    const content = data.content || doc.content || '';
    const mediaUrl = data.mediaUrl || doc.mediaUrl;

    // Convert replyToPostId from base64 to base58 for consistent storage
    const rawReplyToId = data.replyToPostId || doc.replyToPostId;
    const replyToId = rawReplyToId ? identifierToBase58(rawReplyToId) || undefined : undefined;

    // Convert quotedPostId from base64 to base58 for consistent storage
    const rawQuotedPostId = data.quotedPostId || doc.quotedPostId;
    const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) || undefined : undefined;

    // Return a basic Post object - additional data will be loaded separately
    const post: Post = {
      id,
      author: this.getDefaultUser(ownerId),
      content,
      createdAt: new Date(createdAt),
      likes: 0,
      reposts: 0,
      replies: 0,
      views: 0,
      liked: false,
      reposted: false,
      bookmarked: false,
      media: mediaUrl ? [{
        id: id + '-media',
        type: 'image',
        url: mediaUrl
      }] : undefined,
      // Expose IDs for lazy loading at component level
      replyToId: replyToId || undefined,
      quotedPostId: quotedPostId || undefined
    };

    return post;
  }

  /**
   * Enrich post with background data (author, stats, interactions).
   * This is fire-and-forget - mutates the post object asynchronously.
   *
   * NOTE: Related entities (replyTo, quotedPost) are NOT fetched here.
   * Components that need them should fetch explicitly using the replyToId/quotedPostId fields.
   * This prevents cascade fetching and gives components control over what they load.
   */
  private async enrichPost(
    post: Post,
    postId: string,
    ownerId: string
  ): Promise<void> {
    try {
      // Get author information
      if (ownerId) {
        const author = await unifiedProfileService.getProfile(ownerId);
        if (author) {
          post.author = author;
        }
      }

      // Get post stats
      if (postId) {
        const stats = await this.getPostStats(postId);
        post.likes = stats.likes;
        post.reposts = stats.reposts;
        post.replies = stats.replies;
        post.views = stats.views;

        // Get interaction status for current user
        const interactions = await this.getUserInteractions(postId);
        post.liked = interactions.liked;
        post.reposted = interactions.reposted;
        post.bookmarked = interactions.bookmarked;
      }
    } catch (error) {
      console.error('Error enriching post:', error);
    }
  }

  /**
   * Enrich a single post with all data (stats, interactions, author).
   * This is the explicit, awaitable alternative to fire-and-forget enrichment.
   * Returns a new Post object with enriched data.
   */
  async enrichPostFull(post: Post): Promise<Post> {
    try {
      const [stats, interactions, author] = await Promise.all([
        this.getPostStats(post.id),
        this.getUserInteractions(post.id),
        unifiedProfileService.getProfileWithUsername(post.author.id)
      ]);

      // Determine if author has DPNS username (not a truncated ID)
      const authorToUse = author || post.author;
      const hasDpns = authorToUse.username && !authorToUse.username.includes('...');

      return {
        ...post,
        likes: stats.likes,
        reposts: stats.reposts,
        replies: stats.replies,
        views: stats.views,
        liked: interactions.liked,
        reposted: interactions.reposted,
        bookmarked: interactions.bookmarked,
        author: {
          ...authorToUse,
          hasDpns
        } as any
      };
    } catch (error) {
      console.error('Error enriching post:', error);
      return post;
    }
  }

  /**
   * Batch fetch parent posts to get their owner IDs.
   * Deduplicates in-flight requests.
   * Returns a Map of postId -> ownerId
   */
  async getParentPostOwners(parentPostIds: string[]): Promise<Map<string, string>> {
    if (parentPostIds.length === 0) {
      return new Map<string, string>();
    }

    const cacheKey = RequestDeduplicator.createBatchKey(parentPostIds);
    return this.parentOwnersDeduplicator.dedupe(cacheKey, () => this.fetchParentPostOwners(parentPostIds));
  }

  /** Internal: Actually fetch parent post owners */
  private async fetchParentPostOwners(parentPostIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // SDK v3 toJSON() returns base64 for byte array fields (like replyToPostId)
      // but $id queries expect base58. Convert all IDs to base58 first.
      const base58PostIds = parentPostIds
        .map(id => identifierToBase58(id))
        .filter((id): id is string => id !== null);

      if (base58PostIds.length === 0) {
        console.log('getParentPostOwners: No valid post IDs after conversion');
        return result;
      }

      console.log('getParentPostOwners: Querying', base58PostIds.length, 'posts');

      // Batch fetch parent posts using 'in' query with base58 IDs
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [['$id', 'in', base58PostIds]],
        limit: base58PostIds.length
      } as any);

      const documents = normalizeSDKResponse(response);

      // Extract owner IDs (system fields are already base58 in v3)
      for (const doc of documents) {
        const postId = doc.$id as string;
        const ownerId = doc.$ownerId as string;
        if (postId && ownerId) {
          result.set(postId, ownerId);
        }
      }
    } catch (error) {
      console.error('Error fetching parent post owners:', error);
    }

    return result;
  }

  /**
   * Batch enrich multiple posts efficiently.
   * Uses batch queries to minimize network requests.
   * Returns new Post objects with enriched data including _enrichment for N+1 avoidance.
   */
  async enrichPostsBatch(posts: Post[]): Promise<Post[]> {
    if (posts.length === 0) return posts;

    try {
      const postIds = posts.map(p => p.id);
      const authorIds = Array.from(new Set(posts.map(p => p.author.id).filter(Boolean)));

      // Collect parent post IDs from replies
      const parentPostIds = Array.from(new Set(
        posts.map(p => p.replyToId).filter((id): id is string => !!id)
      ));

      // Get current user ID for block/follow status
      const currentUserId = this.getCurrentUserId();

      const [
        statsMap,
        interactionsMap,
        usernameMap,
        profiles,
        parentOwnerMap,
        blockStatusMap,
        followStatusMap,
        avatarUrlMap
      ] = await Promise.all([
        this.getBatchPostStats(postIds),
        this.getBatchUserInteractions(postIds),
        dpnsService.resolveUsernamesBatch(authorIds),
        unifiedProfileService.getProfilesByIdentityIds(authorIds),
        this.getParentPostOwners(parentPostIds),
        // Batch block/follow status (only if user is logged in)
        currentUserId
          ? blockService.checkBlockedBatch(currentUserId, authorIds)
          : Promise.resolve(new Map<string, boolean>()),
        currentUserId
          ? followService.getFollowStatusBatch(authorIds, currentUserId)
          : Promise.resolve(new Map<string, boolean>()),
        // Batch avatar URLs
        unifiedProfileService.getAvatarUrlsBatch(authorIds)
      ]);

      // Seed shared caches so PostCard hooks don't fire individual queries
      if (currentUserId) {
        seedBlockStatusCache(currentUserId, blockStatusMap);
        seedFollowStatusCache(currentUserId, followStatusMap);
      }

      // Resolve usernames for parent post owners
      const parentOwnerIds = Array.from(new Set(parentOwnerMap.values()));
      const parentUsernameMap = parentOwnerIds.length > 0
        ? await dpnsService.resolveUsernamesBatch(parentOwnerIds)
        : new Map<string, string>();

      // Build profile map for quick lookup
      const profileMap = new Map<string, any>();
      profiles.forEach((profile: any) => {
        if (profile.$ownerId) {
          profileMap.set(profile.$ownerId, profile);
        }
      });

      return posts.map(post => {
        const stats = statsMap.get(post.id);
        const interactions = interactionsMap.get(post.id);
        const username = usernameMap.get(post.author.id);
        const profile = profileMap.get(post.author.id);
        const profileData = profile?.data || profile;

        // Get pre-fetched block/follow/avatar data
        const authorIsBlocked = blockStatusMap.get(post.author.id) ?? false;
        const authorIsFollowing = followStatusMap.get(post.author.id) ?? false;
        const authorAvatarUrl = avatarUrlMap.get(post.author.id) ?? '';

        // Build replyTo if this is a reply
        let replyTo = post.replyTo;
        if (post.replyToId && !replyTo) {
          const parentOwnerId = parentOwnerMap.get(post.replyToId);
          if (parentOwnerId) {
            const parentUsername = parentUsernameMap.get(parentOwnerId);
            replyTo = {
              id: post.replyToId,
              author: {
                id: parentOwnerId,
                username: parentUsername || `${parentOwnerId.slice(0, 8)}...`,
                displayName: parentUsername || 'Unknown User',
                avatar: '',
                followers: 0,
                following: 0,
                verified: false,
                joinedAt: new Date()
              },
              content: '',
              createdAt: new Date(),
              likes: 0,
              reposts: 0,
              replies: 0,
              views: 0
            };
          }
        }

        return {
          ...post,
          likes: stats?.likes ?? post.likes,
          reposts: stats?.reposts ?? post.reposts,
          replies: stats?.replies ?? post.replies,
          views: stats?.views ?? post.views,
          liked: interactions?.liked ?? post.liked,
          reposted: interactions?.reposted ?? post.reposted,
          bookmarked: interactions?.bookmarked ?? post.bookmarked,
          replyTo,
          author: {
            ...post.author,
            username: username || post.author.username,
            displayName: profileData?.displayName || post.author.displayName,
            avatar: authorAvatarUrl || post.author.avatar,
            hasDpns: username ? true : false
          },
          // Pre-fetched enrichment data to avoid N+1 queries in PostCard
          _enrichment: {
            authorIsBlocked,
            authorIsFollowing,
            authorAvatarUrl
          }
        };
      });
    } catch (error) {
      console.error('Error batch enriching posts:', error);
      return posts;
    }
  }

  /**
   * Get a fully enriched post by ID.
   * Convenience method that fetches and enriches in one call.
   */
  async getEnrichedPostById(postId: string): Promise<Post | null> {
    const post = await this.get(postId);
    if (!post) return null;
    return this.enrichPostFull(post);
  }

  /**
   * Create a new post
   */
  async createPost(
    ownerId: string,
    content: string,
    options: {
      mediaUrl?: string;
      replyToId?: string;
      quotedPostId?: string;
      firstMentionId?: string;
      primaryHashtag?: string;
      language?: string;
      sensitive?: boolean;
    } = {}
  ): Promise<Post> {
    const data: any = {
      content
    };

    // Add optional fields (use contract field names)
    if (options.mediaUrl) data.mediaUrl = options.mediaUrl;
    if (options.replyToId) data.replyToPostId = options.replyToId;
    if (options.quotedPostId) data.quotedPostId = options.quotedPostId;
    if (options.firstMentionId) data.firstMentionId = options.firstMentionId;
    if (options.primaryHashtag) data.primaryHashtag = options.primaryHashtag;
    if (options.language) data.language = options.language || 'en';
    if (options.sensitive !== undefined) data.sensitive = options.sensitive;

    return this.create(ownerId, data);
  }

  /**
   * Get timeline posts
   */
  async getTimeline(options: QueryOptions = {}): Promise<DocumentResult<Post>> {
    const defaultOptions: QueryOptions = {
      // Need a where clause on orderBy field for Dash Platform to respect ordering
      where: [['$createdAt', '>', 0]],
      orderBy: [['$createdAt', 'desc']],
      limit: 20,
      ...options
    };

    return this.query(defaultOptions);
  }

  /**
   * Get posts from followed users (following feed)
   * Uses compound query with $ownerId 'in' + $createdAt range via ownerAndTime index
   * to prevent prolific users from dominating the feed.
   *
   * Features adaptive window sizing based on post density to target ~50 posts per load.
   */
  async getFollowingFeed(
    userId: string,
    options: QueryOptions & {
      timeWindowStart?: Date;  // For pagination - start of time window
      timeWindowEnd?: Date;    // For pagination - end of time window
      windowHours?: number;    // Suggested window size (adaptive based on density)
    } = {}
  ): Promise<DocumentResult<Post>> {
    const TARGET_POSTS = 50;
    const DEFAULT_WINDOW_HOURS = 24;
    const MIN_WINDOW_HOURS = 1;
    // No arbitrary max - let it search as far back as needed

    try {
      // Get list of followed user IDs (up to 100 - platform limit for 'in' clause)
      const { followService } = await import('./follow-service');
      const following = await followService.getFollowing(userId, { limit: 100 });

      // Include the current user's ID so they see their own posts in the feed
      const followingIds = [...following.map(f => f.followingId), userId];

      if (followingIds.length === 0) {
        return { documents: [], nextCursor: undefined, prevCursor: undefined };
      }

      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const now = new Date();

      // Determine time window
      const windowEndMs = options.timeWindowEnd?.getTime() || now.getTime();
      let windowHours = options.windowHours || DEFAULT_WINDOW_HOURS;
      windowHours = Math.max(MIN_WINDOW_HOURS, windowHours);
      let windowStartMs = options.timeWindowStart?.getTime()
        || (windowEndMs - windowHours * 60 * 60 * 1000);

      // Helper to execute query and extract documents
      const executeQuery = async (whereClause: any[]): Promise<Post[]> => {
        const queryParams: any = {
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: whereClause,
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
          limit: 100,
        };

        const response = await sdk.documents.query(queryParams as any);
        const documents = normalizeSDKResponse(response);
        return documents.map(doc => this.transformDocument(doc));
      };

      // Build compound query using ownerAndTime index
      const buildWhere = (startMs: number, endMs?: number): any[] => {
        const where: any[] = [
          ['$ownerId', 'in', followingIds],
          ['$createdAt', '>=', startMs]
        ];
        if (endMs) {
          where.push(['$createdAt', '<', endMs]);
        }
        return where;
      };

      // Initial query
      let posts = await executeQuery(
        buildWhere(windowStartMs, options.timeWindowEnd?.getTime())
      );
      let actualWindowHours = (windowEndMs - windowStartMs) / (60 * 60 * 1000);

      // Handle different scenarios:
      // 1. Got 100 results (window may be incomplete) - narrow the window
      // 2. Got 0 results - expand the window to find posts (initial load only)
      // 3. Got 1-99 results - good, use these

      if (posts.length === 100 && !options.timeWindowEnd) {
        // Too many results - binary halve until < 100
        let currentWindowMs = windowHours * 60 * 60 * 1000;
        while (posts.length === 100) {
          currentWindowMs /= 2;
          windowStartMs = windowEndMs - currentWindowMs;
          posts = await executeQuery(buildWhere(windowStartMs));
          actualWindowHours = currentWindowMs / (60 * 60 * 1000);
        }
      } else if (posts.length === 0 && !options.timeWindowEnd) {
        // No posts in initial window - keep doubling until we find some
        let currentWindowMs = windowHours * 60 * 60 * 1000;
        const maxExpansions = 20; // Safety limit: 24h * 2^20 = ~2800 years
        let expansions = 0;
        while (posts.length === 0 && expansions < maxExpansions) {
          currentWindowMs *= 2;
          windowStartMs = windowEndMs - currentWindowMs;
          posts = await executeQuery(buildWhere(windowStartMs));
          actualWindowHours = currentWindowMs / (60 * 60 * 1000);
          expansions++;
        }
      }

      // Sort by createdAt descending (newest first)
      posts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      // Calculate post density and suggested window for next load
      const postsPerHour = posts.length > 0 ? posts.length / actualWindowHours : 0;
      let suggestedNextWindowHours: number;

      if (postsPerHour > 0) {
        // Calculate window size to get ~TARGET_POSTS posts
        suggestedNextWindowHours = TARGET_POSTS / postsPerHour;
        suggestedNextWindowHours = Math.max(MIN_WINDOW_HOURS, suggestedNextWindowHours);
      } else {
        // No posts found - try a larger window next time
        suggestedNextWindowHours = actualWindowHours * 2;
      }

      // Calculate next pagination window (goes backwards in time)
      const nextWindowEnd = new Date(windowStartMs);
      const nextWindowStart = new Date(windowStartMs - suggestedNextWindowHours * 60 * 60 * 1000);

      // Only return undefined cursor if we did an exhaustive initial search and found nothing
      const exhaustedSearch = posts.length === 0 && !options.timeWindowEnd;

      return {
        documents: posts,
        nextCursor: exhaustedSearch ? undefined : JSON.stringify({
          start: nextWindowStart.toISOString(),
          end: nextWindowEnd.toISOString(),
          windowHours: suggestedNextWindowHours
        }),
        prevCursor: undefined
      };
    } catch (error) {
      console.error('Error getting following feed:', error);
      return { documents: [], nextCursor: undefined, prevCursor: undefined };
    }
  }

  /**
   * Get posts by user
   */
  async getUserPosts(userId: string, options: QueryOptions = {}): Promise<DocumentResult<Post>> {
    const queryOptions: QueryOptions = {
      where: [
        ['$ownerId', '==', userId],
        ['$createdAt', '>', 0]
      ],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: 20,
      ...options
    };

    return this.query(queryOptions);
  }

  /**
   * Get a single post by its document ID using direct lookup.
   * More efficient than querying all posts and filtering.
   * Awaits author resolution to prevent "Unknown User" race condition.
   *
   * @param postId - The post document ID
   * @param options - Query options (skipEnrichment to disable auto-enrichment)
   */
  async getPostById(postId: string, options: PostQueryOptions = {}): Promise<Post | null> {
    try {
      const post = await this.get(postId);
      if (!post) return null;

      // For single post fetch, await author resolution to prevent race condition
      if (!options.skipEnrichment) {
        await this.resolvePostAuthor(post);
      }

      return post;
    } catch (error) {
      console.error('Error getting post by ID:', error);
      return null;
    }
  }

  /**
   * Resolve and set the author for a post (awaited).
   * This prevents the "Unknown User" race condition for single post views.
   */
  private async resolvePostAuthor(post: Post): Promise<void> {
    if (!post.author?.id || post.author.id === 'unknown') return;

    try {
      const author = await unifiedProfileService.getProfileWithUsername(post.author.id);
      if (author) {
        post.author = author;
      }
    } catch (error) {
      console.error('Error resolving post author:', error);
    }
  }

  /**
   * Count posts by user - uses direct SDK query for reliability.
   * Deduplicates in-flight requests.
   */
  async countUserPosts(userId: string): Promise<number> {
    return this.countUserPostsDeduplicator.dedupe(userId, async () => {
      try {
        const { getEvoSdk } = await import('./evo-sdk-service');
        const sdk = await getEvoSdk();

        const response = await sdk.documents.query({
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: [['$ownerId', '==', userId]],
          orderBy: [['$createdAt', 'asc']],
          limit: 100
        } as any);

        return normalizeSDKResponse(response).length;
      } catch (error) {
        console.error('Error counting user posts:', error);
        return 0;
      }
    });
  }

  /**
   * Count all posts on the platform - paginates through all results.
   * Deduplicates in-flight requests.
   */
  async countAllPosts(): Promise<number> {
    // Use a constant key since this counts all posts
    return this.countAllPostsDeduplicator.dedupe('all', async () => {
      const result = await retryAsync(
        async () => {
          const { getEvoSdk } = await import('./evo-sdk-service');
          const sdk = await getEvoSdk();
          let totalCount = 0;
          let startAfter: string | undefined = undefined;
          const PAGE_SIZE = 100;

          while (true) {
            const queryParams: any = {
              dataContractId: this.contractId,
              documentTypeName: 'post',
              orderBy: [['$createdAt', 'asc']],
              limit: PAGE_SIZE
            };

            if (startAfter) {
              queryParams.startAfter = startAfter;
            }

            const response = await sdk.documents.query(queryParams as any);
            const documents = normalizeSDKResponse(response);

            totalCount += documents.length;

            // If we got fewer than PAGE_SIZE, we've reached the end
            if (documents.length < PAGE_SIZE) {
              break;
            }

            // Get the last document's ID for pagination
            const lastDoc = documents[documents.length - 1];
            if (!lastDoc.$id) {
              break;
            }
            startAfter = lastDoc.$id as string;
          }

          return totalCount;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          backoffMultiplier: 2
        }
      );

      if (!result.success) {
        console.error('Error counting all posts after retries:', result.error);
        throw result.error || new Error('Failed to count posts');
      }

      return result.data!;
    });
  }

  /**
   * Get replies to a post.
   * Awaits author resolution for all replies to prevent "Unknown User" race condition.
   *
   * @param postId - The parent post ID
   * @param options - Query options (including skipEnrichment to disable auto-enrichment)
   */
  async getReplies(postId: string, options: QueryOptions & PostQueryOptions = {}): Promise<DocumentResult<Post>> {
    const { skipEnrichment, ...queryOpts } = options;

    // Pass identifier as base58 string - the SDK handles conversion
    // Dash Platform requires a where clause on the orderBy field for ordering to work
    const queryOptions: QueryOptions = {
      where: [
        ['replyToPostId', '==', postId],
        ['$createdAt', '>', 0]
      ],
      orderBy: [['$createdAt', 'asc']],
      limit: 20,
      ...queryOpts
    };

    const result = await this.query(queryOptions);

    // Await author resolution for all replies to prevent race condition
    if (!skipEnrichment) {
      await Promise.all(result.documents.map(post => this.resolvePostAuthor(post)));
    }

    return result;
  }

  /**
   * Get nested replies for multiple parent posts.
   * Returns a Map of parentPostId -> replies array.
   * Used for building 2-level threaded reply trees.
   */
  async getNestedReplies(
    parentPostIds: string[],
    options: PostQueryOptions = {}
  ): Promise<Map<string, Post[]>> {
    if (parentPostIds.length === 0) {
      return new Map();
    }

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Query using 'in' operator on replyToPostId index
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [['replyToPostId', 'in', parentPostIds]],
        orderBy: [['replyToPostId', 'asc']],
        limit: 100
      } as any);

      const documents = normalizeSDKResponse(response);

      // Initialize result map
      const result = new Map<string, Post[]>();
      parentPostIds.forEach(id => result.set(id, []));

      // Transform documents and group by parent
      for (const doc of documents) {
        const post = this.transformDocument(doc);
        const parentId = post.replyToId;
        if (parentId && result.has(parentId)) {
          result.get(parentId)!.push(post);
        }
      }

      // Sort replies by createdAt ascending within each parent
      result.forEach((replies) => {
        replies.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      });

      // Resolve authors if not skipping enrichment
      if (!options.skipEnrichment) {
        const allPosts = Array.from(result.values()).flat();
        await Promise.all(allPosts.map(p => this.resolvePostAuthor(p)));
      }

      return result;
    } catch (error) {
      console.error('Error getting nested replies:', error);
      // Return empty arrays for all requested IDs
      const result = new Map<string, Post[]>();
      parentPostIds.forEach(id => result.set(id, []));
      return result;
    }
  }

  /**
   * Get posts by hashtag
   */
  async getPostsByHashtag(hashtag: string, options: QueryOptions = {}): Promise<DocumentResult<Post>> {
    const queryOptions: QueryOptions = {
      where: [['primaryHashtag', '==', hashtag.replace('#', '')]],
      orderBy: [['$createdAt', 'desc']],
      limit: 20,
      ...options
    };

    return this.query(queryOptions);
  }

  /**
   * Get post statistics (likes, reposts, replies)
   */
  private async getPostStats(postId: string): Promise<PostStats> {
    // Check cache
    const cached = this.statsCache.get(postId);
    if (cached && Date.now() - cached.timestamp < 60000) { // 60 second cache for stats
      return cached.data;
    }

    try {
      // Parallel queries to reduce latency and rate limit pressure
      const [likes, reposts, replies] = await Promise.all([
        this.countLikes(postId),
        this.countReposts(postId),
        this.countReplies(postId)
      ]);

      const stats: PostStats = {
        postId,
        likes,
        reposts,
        replies,
        views: 0 // Views would need a separate tracking mechanism
      };

      // Cache the result
      this.statsCache.set(postId, {
        data: stats,
        timestamp: Date.now()
      });

      return stats;
    } catch (error) {
      console.error('Error getting post stats:', error);
      return { postId, likes: 0, reposts: 0, replies: 0, views: 0 };
    }
  }

  /**
   * Count likes for a post
   */
  private async countLikes(postId: string): Promise<number> {
    const { likeService } = await import('./like-service');
    return likeService.countLikes(postId);
  }

  /**
   * Count reposts for a post
   */
  private async countReposts(postId: string): Promise<number> {
    const { repostService } = await import('./repost-service');
    return repostService.countReposts(postId);
  }

  /**
   * Count replies to a post
   */
  private async countReplies(postId: string): Promise<number> {
    try {
      // Pass identifier as base58 string - the SDK handles conversion
      // Dash Platform requires a where clause on the orderBy field for ordering to work
      const result = await this.query({
        where: [
          ['replyToPostId', '==', postId],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['$createdAt', 'asc']],
        limit: 100
      });
      return result.documents.length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Get user interactions with a post
   */
  private async getUserInteractions(postId: string): Promise<{
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  }> {
    const currentUserId = this.getCurrentUserId();
    if (!currentUserId) {
      return { liked: false, reposted: false, bookmarked: false };
    }

    try {
      const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
        import('./like-service'),
        import('./repost-service'),
        import('./bookmark-service')
      ]);

      const [liked, reposted, bookmarked] = await Promise.all([
        likeService.isLiked(postId, currentUserId),
        repostService.isReposted(postId, currentUserId),
        bookmarkService.isBookmarked(postId, currentUserId)
      ]);

      return { liked, reposted, bookmarked };
    } catch (error) {
      console.error('Error getting user interactions:', error);
      return { liked: false, reposted: false, bookmarked: false };
    }
  }

  /**
   * Get current user ID from localStorage session
   */
  private getCurrentUserId(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      const savedSession = localStorage.getItem('yappr_session');
      if (savedSession) {
        const sessionData = JSON.parse(savedSession);
        return sessionData.user?.identityId || null;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * Get default user object when profile not found.
   * Sets username to empty string and hasDpns to false so display components
   * can properly show the identity ID instead of a fake username.
   */
  private getDefaultUser(userId: string | undefined): User & { hasDpns: boolean } {
    const id = userId || 'unknown';
    return {
      id,
      // Don't use fake username format - leave empty for display components to handle
      username: '',
      displayName: 'Unknown User',
      avatar: '',
      bio: '',
      followers: 0,
      following: 0,
      verified: false,
      joinedAt: new Date(),
      hasDpns: false
    };
  }

  /**
   * Public wrapper for getPostStats - for use by feed page
   */
  async getPostStatsPublic(postId: string): Promise<PostStats> {
    return this.getPostStats(postId);
  }

  /**
   * Public wrapper for getUserInteractions - for use by feed page
   */
  async getUserInteractionsPublic(postId: string): Promise<{
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  }> {
    return this.getUserInteractions(postId);
  }

  /**
   * Batch get user interactions for multiple posts.
   * Deduplicates in-flight requests.
   */
  async getBatchUserInteractions(postIds: string[]): Promise<Map<string, {
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  }>> {
    const currentUserId = this.getCurrentUserId();
    if (!currentUserId || postIds.length === 0) {
      const result = new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>();
      postIds.forEach(id => result.set(id, { liked: false, reposted: false, bookmarked: false }));
      return result;
    }

    // Include userId in cache key since interactions are user-specific
    const cacheKey = `${currentUserId}:${RequestDeduplicator.createBatchKey(postIds)}`;
    return this.interactionsDeduplicator.dedupe(cacheKey, () => this.fetchBatchUserInteractions(postIds, currentUserId));
  }

  /** Internal: Actually fetch user interactions */
  private async fetchBatchUserInteractions(postIds: string[], currentUserId: string): Promise<Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>> {
    const result = new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>();

    // Initialize all posts with false
    postIds.forEach(id => {
      result.set(id, { liked: false, reposted: false, bookmarked: false });
    });

    try {
      const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
        import('./like-service'),
        import('./repost-service'),
        import('./bookmark-service')
      ]);

      // Fetch interactions for these specific posts, not all user interactions
      // This scales properly regardless of how many total likes/reposts/bookmarks a user has
      const [allLikesForPosts, allRepostsForPosts, userBookmarks] = await Promise.all([
        likeService.getLikesByPostIds(postIds),
        repostService.getRepostsByPostIds(postIds),
        bookmarkService.getUserBookmarksForPosts(currentUserId, postIds)
      ]);

      // Filter likes/reposts to find current user's interactions
      const likedPostIds = new Set(
        allLikesForPosts.filter(l => l.$ownerId === currentUserId).map(l => l.postId)
      );
      const repostedPostIds = new Set(
        allRepostsForPosts.filter(r => r.$ownerId === currentUserId).map(r => r.postId)
      );
      const bookmarkedPostIds = new Set(userBookmarks.map(b => b.postId));

      // Check each post against the Sets
      postIds.forEach(postId => {
        result.set(postId, {
          liked: likedPostIds.has(postId),
          reposted: repostedPostIds.has(postId),
          bookmarked: bookmarkedPostIds.has(postId)
        });
      });
    } catch (error) {
      console.error('Error getting batch user interactions:', error);
    }

    return result;
  }

  /**
   * Get reply counts for multiple posts in a single batch query.
   * Deduplicates in-flight requests.
   */
  async getRepliesByPostIds(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) {
      return new Map<string, number>();
    }

    const cacheKey = RequestDeduplicator.createBatchKey(postIds);
    return this.repliesDeduplicator.dedupe(cacheKey, () => this.fetchRepliesByPostIds(postIds));
  }

  /** Internal: Actually fetch reply counts */
  private async fetchRepliesByPostIds(postIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    postIds.forEach(id => result.set(id, 0));

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Use 'in' operator for batch query on replyToPostId
      // Must include orderBy to match the replyToPost index: [replyToPostId, $createdAt]
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [['replyToPostId', 'in', postIds]],
        orderBy: [['replyToPostId', 'asc']],
        limit: 100
      } as any);

      const documents = normalizeSDKResponse(response);

      // Count replies per parent post
      for (const doc of documents) {
        // Handle different document structures from SDK
        const data = (doc.data || doc) as Record<string, unknown>;
        const rawParentId = data.replyToPostId || doc.replyToPostId;
        const parentId = rawParentId ? identifierToBase58(rawParentId) : null;

        if (parentId && result.has(parentId)) {
          result.set(parentId, (result.get(parentId) || 0) + 1);
        }
      }
    } catch (error) {
      console.error('Error getting replies batch:', error);
    }

    return result;
  }

  /**
   * Batch get stats for multiple posts using efficient batch queries.
   * Deduplicates in-flight requests: multiple callers with same postIds share one request.
   */
  async getBatchPostStats(postIds: string[]): Promise<Map<string, PostStats>> {
    if (postIds.length === 0) {
      return new Map<string, PostStats>();
    }

    const cacheKey = RequestDeduplicator.createBatchKey(postIds);
    return this.statsDeduplicator.dedupe(cacheKey, () => this.fetchBatchPostStats(postIds));
  }

  /** Internal: Actually fetch batch post stats */
  private async fetchBatchPostStats(postIds: string[]): Promise<Map<string, PostStats>> {
    const result = new Map<string, PostStats>();

    // Initialize all posts with zero stats
    postIds.forEach(id => {
      result.set(id, { postId: id, likes: 0, reposts: 0, replies: 0, views: 0 });
    });

    try {
      const [{ likeService }, { repostService }] = await Promise.all([
        import('./like-service'),
        import('./repost-service')
      ]);

      // 3 batch queries instead of 3*N queries
      const [likes, reposts, replyCounts] = await Promise.all([
        likeService.getLikesByPostIds(postIds),
        repostService.getRepostsByPostIds(postIds),
        this.getRepliesByPostIds(postIds)
      ]);

      // Count likes per post
      for (const like of likes) {
        const stats = result.get(like.postId);
        if (stats) stats.likes++;
      }

      // Count reposts per post
      for (const repost of reposts) {
        const stats = result.get(repost.postId);
        if (stats) stats.reposts++;
      }

      // Set reply counts
      replyCounts.forEach((count, postId) => {
        const stats = result.get(postId);
        if (stats) stats.replies = count;
      });
    } catch (error) {
      console.error('Error getting batch post stats:', error);
    }

    return result;
  }

  /**
   * Count unique authors across all posts
   * Paginates through all posts and counts unique $ownerId values
   */
  async countUniqueAuthors(): Promise<number> {
    // Use a constant key since this counts all unique authors
    return this.countUniqueAuthorsDeduplicator.dedupe('all', async () => {
      const result = await retryAsync(
        async () => {
          const { getEvoSdk } = await import('./evo-sdk-service');
          const sdk = await getEvoSdk();
          const uniqueAuthors = new Set<string>();
          let startAfter: string | undefined = undefined;
          const PAGE_SIZE = 100;

          while (true) {
            const queryParams: any = {
              dataContractId: this.contractId,
              documentTypeName: 'post',
              where: [['$createdAt', '>', 0]],
              orderBy: [['$createdAt', 'asc']],
              limit: PAGE_SIZE
            };

            if (startAfter) {
              queryParams.startAfter = startAfter;
            }

            const response = await sdk.documents.query(queryParams as any);
            const documents = normalizeSDKResponse(response);

            // Collect unique author IDs
            for (const doc of documents) {
              if (doc.$ownerId) {
                uniqueAuthors.add(doc.$ownerId as string);
              }
            }

            // If we got fewer than PAGE_SIZE, we've reached the end
            if (documents.length < PAGE_SIZE) {
              break;
            }

            // Get the last document's ID for pagination
            const lastDoc = documents[documents.length - 1];
            if (!lastDoc.$id) {
              break;
            }
            startAfter = lastDoc.$id as string;
          }

          return uniqueAuthors.size;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          backoffMultiplier: 2
        }
      );

      if (!result.success) {
        console.error('Error counting unique authors after retries:', result.error);
        throw result.error || new Error('Failed to count unique authors');
      }

      return result.data!;
    });
  }

  /**
   * Get top posts by like count
   * Fetches recent posts, gets their stats, and sorts by likes
   */
  async getTopPostsByLikes(limit: number = 5): Promise<Post[]> {
    try {
      // Fetch recent posts (more than we need to find top liked ones)
      const result = await this.getTimeline({ limit: 50 });
      const posts = result.documents;

      if (posts.length === 0) return [];

      // Get stats for all posts in batch
      const postIds = posts.map(p => p.id);
      const statsMap = await this.getBatchPostStats(postIds);

      // Sort by likes descending
      const postsWithLikes = posts.map(post => ({
        post,
        likes: statsMap.get(post.id)?.likes || 0
      }));

      postsWithLikes.sort((a, b) => b.likes - a.likes);

      // Take top N and enrich them
      const topPosts = postsWithLikes.slice(0, limit).map(p => p.post);

      // Enrich posts with full data (stats, authors, interactions)
      return this.enrichPostsBatch(topPosts);
    } catch (error) {
      console.error('Error getting top posts by likes:', error);
      return [];
    }
  }

  /**
   * Get post counts per author
   * Returns a Map of authorId -> post count
   */
  async getAuthorPostCounts(limit: number = 50): Promise<Map<string, number>> {
    const authorCounts = new Map<string, number>();

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();
      let startAfter: string | undefined = undefined;
      const PAGE_SIZE = 100;
      let totalProcessed = 0;
      const MAX_POSTS = 500; // Limit to prevent excessive queries

      while (totalProcessed < MAX_POSTS) {
        const queryParams: any = {
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: [['$createdAt', '>', 0]],
          orderBy: [['$createdAt', 'desc']],
          limit: PAGE_SIZE
        };

        if (startAfter) {
          queryParams.startAfter = startAfter;
        }

        const response = await sdk.documents.query(queryParams as any);
        const documents = normalizeSDKResponse(response);

        // Count posts per author
        for (const doc of documents) {
          if (doc.$ownerId) {
            const ownerId = doc.$ownerId as string;
            authorCounts.set(ownerId, (authorCounts.get(ownerId) || 0) + 1);
          }
        }

        totalProcessed += documents.length;

        // If we got fewer than PAGE_SIZE, we've reached the end
        if (documents.length < PAGE_SIZE) {
          break;
        }

        // Get the last document's ID for pagination
        const lastDoc = documents[documents.length - 1];
        if (!lastDoc.$id) {
          break;
        }
        startAfter = lastDoc.$id as string;
      }

      return authorCounts;
    } catch (error) {
      console.error('Error getting author post counts:', error);
      return authorCounts;
    }
  }

  /**
   * Get posts that quote a specific post.
   * NOTE: The contract lacks a quotedPostId index, so this uses client-side
   * filtering of recent posts. For production, a contract migration adding
   * the index would improve efficiency.
   */
  async getQuotePosts(quotedPostId: string, options: { limit?: number } = {}): Promise<Post[]> {
    const limit = options.limit || 50;

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Scan recent posts - without an index we have to filter client-side
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [['$createdAt', '>', 0]],
        orderBy: [['$createdAt', 'desc']],
        limit: 100 // Scan recent posts
      } as any);

      const documents = normalizeSDKResponse(response);

      // Filter for posts that quote the target post and transform
      const quotePosts = documents
        .map(doc => this.transformDocument(doc))
        .filter(post => post.quotedPostId === quotedPostId);

      return quotePosts.slice(0, limit);
    } catch (error) {
      console.error('Error getting quote posts:', error);
      return [];
    }
  }

  /**
   * Get multiple posts by their IDs.
   * Useful for fetching original posts when displaying reposts or quotes.
   * Author info is resolved for each post.
   */
  async getPostsByIds(postIds: string[]): Promise<Post[]> {
    if (postIds.length === 0) return [];

    try {
      // Fetch posts in parallel with concurrency limit
      const BATCH_SIZE = 5;
      const posts: Post[] = [];

      for (let i = 0; i < postIds.length; i += BATCH_SIZE) {
        const batch = postIds.slice(i, i + BATCH_SIZE);
        const batchPosts = await Promise.all(
          batch.map(id => this.getPostById(id)) // Don't skip enrichment - resolve authors
        );
        posts.push(...batchPosts.filter((p): p is Post => p !== null));
      }

      return posts;
    } catch (error) {
      console.error('Error getting posts by IDs:', error);
      return [];
    }
  }
}

// Singleton instance
export const postService = new PostService();