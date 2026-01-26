import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Post, User, PostQueryOptions } from '../types';
import { dpnsService } from './dpns-service';
import { blockService } from './block-service';
import { followService } from './follow-service';
import { unifiedProfileService } from './unified-profile-service';
import { identifierToBase58, normalizeSDKResponse, RequestDeduplicator, type DocumentWhereClause } from './sdk-helpers';
import type { DocumentsQuery } from '@dashevo/wasm-sdk';
import { seedBlockStatusCache, seedFollowStatusCache } from '../caches/user-status-cache';
import { retryAsync } from '../retry-utils';
import { paginateCount } from './pagination-utils';

export interface PostDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  content: string;
  mediaUrl?: string;
  quotedPostId?: string;
  quotedPostOwnerId?: string;
  firstMentionId?: string;
  primaryHashtag?: string;
  language?: string;
  sensitive?: boolean;
  // Private feed fields
  encryptedContent?: Uint8Array;
  epoch?: number;
  nonce?: Uint8Array;
}

/**
 * Encryption options for creating private posts
 */
export interface EncryptionOptions {
  /** Type of encryption: 'owner' for own private posts, 'inherited' for replies to private posts */
  type: 'owner' | 'inherited';
  /** Optional public teaser content (only for 'owner' type) */
  teaser?: string;
  /** Owner's encryption private key for automatic sync/recovery (only for 'owner' type) */
  encryptionPrivateKey?: Uint8Array;
  /** Encryption source for inherited encryption (only for 'inherited' type) */
  source?: { ownerId: string; epoch: number };
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
  protected transformDocument(doc: Record<string, unknown>): Post {
    // SDK may nest document fields under 'data' property
    const data = (doc.data || doc) as Record<string, unknown>;

    // SDK v3 toJSON() returns:
    // - System fields ($id, $ownerId, $createdAt): base58 strings
    // - Byte array fields (replyToPostId, etc): base64 strings (need conversion)
    // Handle both $ prefixed (query responses) and non-prefixed (creation responses) fields
    const id = (doc.$id || doc.id) as string;
    const ownerId = (doc.$ownerId || doc.ownerId) as string;
    const createdAt = (doc.$createdAt || doc.createdAt) as number;

    // Content and other fields may be in data or at root level
    const content = (data.content || doc.content || '') as string;
    const mediaUrl = (data.mediaUrl || doc.mediaUrl) as string | undefined;

    // Convert quotedPostId from base64 to base58 for consistent storage
    const rawQuotedPostId = data.quotedPostId || doc.quotedPostId;
    const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) || undefined : undefined;

    // Convert quotedPostOwnerId from base64 to base58 for consistent storage
    const rawQuotedPostOwnerId = data.quotedPostOwnerId || doc.quotedPostOwnerId;
    const quotedPostOwnerId = rawQuotedPostOwnerId ? identifierToBase58(rawQuotedPostOwnerId) || undefined : undefined;

    // Extract private feed fields if present
    const rawEncryptedContent = data.encryptedContent || doc.encryptedContent;
    const epoch = (data.epoch ?? doc.epoch) as number | undefined;
    const rawNonce = data.nonce || doc.nonce;

    // Normalize byte arrays (SDK may return as base64 string, Uint8Array, or regular array)
    // normalizeBytes returns null on decode failure to avoid treating malformed data as encrypted
    const encryptedContent = rawEncryptedContent ? this.normalizeBytes(rawEncryptedContent) ?? undefined : undefined;
    const nonce = rawNonce ? this.normalizeBytes(rawNonce) ?? undefined : undefined;

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
      quotedPostId: quotedPostId || undefined,
      quotedPostOwnerId: quotedPostOwnerId || undefined,
      // Private feed fields
      encryptedContent,
      epoch,
      nonce,
    };

    return post;
  }

  /**
   * Enrich a single post with all data (stats, interactions, author).
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
        } as User & { hasDpns: boolean }
      };
    } catch (error) {
      console.error('Error enriching post:', error);
      return post;
    }
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

      // Get current user ID for block/follow status
      const currentUserId = this.getCurrentUserId();

      const [
        statsMap,
        interactionsMap,
        usernameMap,
        profiles,
        blockStatusMap,
        followStatusMap,
        avatarUrlMap
      ] = await Promise.all([
        this.getBatchPostStats(postIds),
        this.getBatchUserInteractions(postIds),
        dpnsService.resolveUsernamesBatch(authorIds),
        unifiedProfileService.getProfilesByIdentityIds(authorIds),
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

      // Build profile map for quick lookup
      const profileMap = new Map<string, Record<string, unknown>>();
      profiles.forEach((profile) => {
        const profileRec = profile as unknown as Record<string, unknown>;
        if (profileRec.$ownerId) {
          profileMap.set(profileRec.$ownerId as string, profileRec);
        }
      });

      return posts.map(post => {
        const stats = statsMap.get(post.id);
        const interactions = interactionsMap.get(post.id);
        const username = usernameMap.get(post.author.id);
        const profile = profileMap.get(post.author.id);
        const profileData = (profile?.data || profile) as Record<string, unknown> | undefined;

        // Get pre-fetched block/follow/avatar data
        const authorIsBlocked = blockStatusMap.get(post.author.id) ?? false;
        const authorIsFollowing = followStatusMap.get(post.author.id) ?? false;
        const authorAvatarUrl = avatarUrlMap.get(post.author.id) ?? '';

        return {
          ...post,
          likes: stats?.likes ?? post.likes,
          reposts: stats?.reposts ?? post.reposts,
          replies: stats?.replies ?? post.replies,
          views: stats?.views ?? post.views,
          liked: interactions?.liked ?? post.liked,
          reposted: interactions?.reposted ?? post.reposted,
          bookmarked: interactions?.bookmarked ?? post.bookmarked,
          author: {
            ...post.author,
            username: username || post.author.username,
            displayName: (profileData?.displayName as string) || post.author.displayName,
            avatar: authorAvatarUrl || post.author.avatar,
            hasDpns: Boolean(username)
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
   * Create a new post (public or private)
   *
   * This is the unified post creation method that handles both public and private posts.
   * For private posts, pass the `encryption` option with the appropriate type.
   *
   * @param ownerId - Identity ID of the post author
   * @param content - Post content (plaintext - will be encrypted if encryption option is provided)
   * @param options - Optional fields including encryption for private posts
   */
  async createPost(
    ownerId: string,
    content: string,
    options: {
      mediaUrl?: string;
      quotedPostId?: string;
      quotedPostOwnerId?: string;
      firstMentionId?: string;
      primaryHashtag?: string;
      language?: string;
      sensitive?: boolean;
      /** Encryption options for private posts */
      encryption?: EncryptionOptions;
    } = {}
  ): Promise<Post> {
    const PRIVATE_POST_PLACEHOLDER = '🔒';
    const data: Record<string, unknown> = {};

    // Handle encryption if provided
    if (options.encryption) {
      const { prepareOwnerEncryption, prepareInheritedEncryption } = await import('./private-feed-service');

      let encryptionResult;
      if (options.encryption.type === 'owner') {
        encryptionResult = await prepareOwnerEncryption(
          ownerId,
          content,
          options.encryption.teaser,
          options.encryption.encryptionPrivateKey
        );
      } else if (options.encryption.type === 'inherited' && options.encryption.source) {
        encryptionResult = await prepareInheritedEncryption(
          content,
          options.encryption.source
        );
      } else {
        throw new Error('Invalid encryption options: inherited type requires source');
      }

      if (!encryptionResult.success) {
        throw new Error(encryptionResult.error);
      }

      // Set encrypted fields
      data.encryptedContent = encryptionResult.data.encryptedContent;
      data.epoch = encryptionResult.data.epoch;
      data.nonce = encryptionResult.data.nonce;

      // Use teaser or placeholder as public content
      data.content = encryptionResult.data.teaser || PRIVATE_POST_PLACEHOLDER;
    } else {
      // Public post - use content directly
      data.content = content;
    }

    // Language is required - default to 'en' if not provided
    data.language = options.language || 'en';

    // Add optional fields (use contract field names)
    if (options.mediaUrl) data.mediaUrl = options.mediaUrl;
    if (options.quotedPostId) data.quotedPostId = options.quotedPostId;
    if (options.quotedPostOwnerId) data.quotedPostOwnerId = options.quotedPostOwnerId;
    if (options.firstMentionId) data.firstMentionId = options.firstMentionId;
    if (options.primaryHashtag) data.primaryHashtag = options.primaryHashtag;
    if (options.sensitive !== undefined) data.sensitive = options.sensitive;

    return this.create(ownerId, data);
  }

  /**
   * Get timeline posts.
   * Uses the languageTimeline index: [language, $createdAt].
   * @param language - Language code to filter by (defaults to 'en')
   * @param options - Query options
   */
  async getTimeline(options: QueryOptions & { language?: string } = {}): Promise<DocumentResult<Post>> {
    const { language = 'en', ...queryOptions } = options;

    const defaultOptions: QueryOptions = {
      // Use languageTimeline index: [language, $createdAt]
      where: [
        ['language', '==', language],
        ['$createdAt', '>', 0]
      ],
      orderBy: [['language', 'asc'], ['$createdAt', 'desc']],
      limit: 20,
      ...queryOptions
    };

    return this.query(defaultOptions);
  }

  /**
   * Get posts from followed users (following feed)
   * Uses compound query with $ownerId 'in' + $createdAt range via ownerAndTime index
   * to prevent prolific users from dominating the feed.
   *
   * Features adaptive window sizing based on post density to target ~50 posts per load.
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
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
      const following = await followService.getFollowing(userId);

      const followingIds = following.map(f => f.followingId);

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
      const executeQuery = async (whereClause: DocumentWhereClause[]): Promise<Post[]> => {
        const queryParams: DocumentsQuery = {
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: whereClause,
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
          limit: 100,
        };

        const response = await sdk.documents.query(queryParams);
        const documents = normalizeSDKResponse(response);
        return documents.map(doc => this.transformDocument(doc));
      };

      // Build compound query using ownerAndTime index
      const buildWhere = (startMs: number, endMs?: number): DocumentWhereClause[] => {
        const where: DocumentWhereClause[] = [
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
   * Count posts by user.
   * Paginates through all results for accurate count.
   * Deduplicates in-flight requests.
   */
  async countUserPosts(userId: string): Promise<number> {
    return this.countUserPostsDeduplicator.dedupe(userId, async () => {
      try {
        const { getEvoSdk } = await import('./evo-sdk-service');
        const sdk = await getEvoSdk();

        const { count } = await paginateCount(
          sdk,
          () => ({
            dataContractId: this.contractId,
            documentTypeName: 'post',
            where: [
              ['$ownerId', '==', userId],
              ['$createdAt', '>', 0]
            ],
            orderBy: [['$createdAt', 'asc']]
          })
        );

        return count;
      } catch (error) {
        console.error('Error counting user posts:', error);
        return 0;
      }
    });
  }

  /**
   * Count all posts on the platform - paginates through all results.
   * Uses the languageTimeline index [language, $createdAt] to scan posts.
   * Note: Currently only counts English posts (language='en') since most posts
   * use the default language. For accurate total counts across all languages,
   * would need to iterate through all language codes or add a dedicated index.
   * Deduplicates in-flight requests.
   */
  async countAllPosts(): Promise<number> {
    // Use a constant key since this counts all posts
    return this.countAllPostsDeduplicator.dedupe('all', async () => {
      try {
        const { getEvoSdk } = await import('./evo-sdk-service');
        const sdk = await getEvoSdk();

        // Use languageTimeline index: [language, $createdAt]
        // This requires a language prefix to use the index
        const { count } = await paginateCount(
          sdk,
          () => ({
            dataContractId: this.contractId,
            documentTypeName: 'post',
            where: [
              ['language', '==', 'en'],
              ['$createdAt', '>', 0]
            ],
            orderBy: [['language', 'asc'], ['$createdAt', 'asc']]
          }),
          { maxResults: 10000 } // Higher limit for platform-wide count
        );

        return count;
      } catch (error) {
        console.error('Error counting all posts:', error);
        return 0;
      }
    });
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
   * Count replies to a post (uses reply-service)
   */
  private async countReplies(postId: string): Promise<number> {
    const { replyService } = await import('./reply-service');
    return replyService.countReplies(postId);
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
   * Normalize bytes from SDK response (may be base64 string, Uint8Array, or regular array).
   * Returns null on decode failure to prevent malformed data from being treated as valid encrypted content.
   */
  private normalizeBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (Array.isArray(value)) {
      return new Uint8Array(value);
    }
    if (typeof value === 'string') {
      // Try base64 decode
      try {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      } catch {
        // Might be hex - validate even length for proper decoding
        if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
          const bytes = new Uint8Array(value.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(value.substr(i * 2, 2), 16);
          }
          return bytes;
        }
      }
    }
    console.warn('Unable to normalize bytes in post-service:', value);
    return null;
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
      const [{ likeService }, { repostService }, { replyService }] = await Promise.all([
        import('./like-service'),
        import('./repost-service'),
        import('./reply-service')
      ]);

      // 3 batch queries instead of 3*N queries
      const [likes, reposts, replyCounts] = await Promise.all([
        likeService.getLikesByPostIds(postIds),
        repostService.getRepostsByPostIds(postIds),
        replyService.countRepliesByParentIds(postIds)
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
   * Paginates through all posts and counts unique $ownerId values.
   * Uses the languageTimeline index [language, $createdAt] to scan posts.
   * Note: Currently only counts authors of English posts (language='en').
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
            // Use languageTimeline index: [language, $createdAt]
            const queryParams: DocumentsQuery = {
              dataContractId: this.contractId,
              documentTypeName: 'post',
              where: [
                ['language', '==', 'en'],
                ['$createdAt', '>', 0]
              ],
              orderBy: [['language', 'asc'], ['$createdAt', 'asc']],
              limit: PAGE_SIZE,
              startAfter
            };

            const response = await sdk.documents.query(queryParams);
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

      if (!result.success || result.data === undefined) {
        console.error('Error counting unique authors after retries:', result.error);
        throw result.error || new Error('Failed to count unique authors');
      }

      return result.data;
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
   * Uses the languageTimeline index [language, $createdAt] to scan posts.
   * Note: Currently only counts English posts (language='en').
   */
  async getAuthorPostCounts(): Promise<Map<string, number>> {
    const authorCounts = new Map<string, number>();

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();
      let startAfter: string | undefined = undefined;
      const PAGE_SIZE = 100;
      let totalProcessed = 0;
      const MAX_POSTS = 10000; // Limit to prevent excessive queries

      while (totalProcessed < MAX_POSTS) {
        // Use languageTimeline index: [language, $createdAt]
        const queryParams: DocumentsQuery = {
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: [
            ['language', '==', 'en'],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['language', 'asc'], ['$createdAt', 'desc']],
          limit: PAGE_SIZE,
          startAfter
        };

        const response = await sdk.documents.query(queryParams);
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
   * filtering of recent posts. Uses languageTimeline index to scan.
   * For production, a contract migration adding the index would improve efficiency.
   */
  async getQuotePosts(quotedPostId: string, options: { limit?: number } = {}): Promise<Post[]> {
    const limit = options.limit || 50;

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Scan recent posts using languageTimeline index - without a dedicated index
      // we have to filter client-side
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [
          ['language', '==', 'en'],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['language', 'asc'], ['$createdAt', 'desc']],
        limit: 100 // Scan recent posts
      });

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
   * Get quotes of posts owned by a specific user (for notification queries).
   * Uses the quotedPostOwnerAndTime index: [quotedPostOwnerId, $createdAt]
   * Returns posts with non-empty content (quote tweets, not pure reposts).
   * Limited to 100 most recent quotes for notification purposes.
   * @param userId - Identity ID of the post owner
   * @param since - Only return quotes created after this timestamp (optional)
   */
  async getQuotesOfMyPosts(userId: string, since?: Date): Promise<Post[]> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

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

      // Transform and filter for quote tweets only (non-empty content)
      return documents
        .map((doc) => this.transformDocument(doc))
        .filter((post) => post.content && post.content.trim() !== '');
    } catch (error) {
      console.error('Error getting quotes of my posts:', error);
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

// Re-export EncryptionSource type and getEncryptionSource function from reply-service
// for backward compatibility with existing code
export type { EncryptionSource } from './reply-service';
export { getEncryptionSource } from './reply-service';

// Singleton instance
export const postService = new PostService();