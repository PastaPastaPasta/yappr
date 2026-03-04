import { logger } from '@/lib/logger';
import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Post, PostQueryOptions } from '../../types';
import type { BlogPost } from '@/lib/types';
import { identifierToBase58, RequestDeduplicator, stringToIdentifierBytes, normalizeBytes, getCurrentUserId as getSessionUserId, createDefaultUser } from './sdk-helpers';
import { paginateCount } from './pagination-utils';
import { fetchBatchPostStats, fetchBatchUserInteractions, fetchPostStats, fetchUserInteractions } from './post-stats-helpers';
import { enrichPostFull as enrichPostFullHelper, enrichPostsBatch as enrichPostsBatchHelper, resolvePostAuthor as resolvePostAuthorHelper } from './post-enrichment-helpers';
import { fetchAuthorPostCounts, fetchFollowingFeed, fetchQuotePosts, fetchQuotesOfMyPosts, fetchTopPostsByLikes, fetchUniqueAuthorCount } from './post-query-helpers';

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
    const encryptedContent = rawEncryptedContent ? normalizeBytes(rawEncryptedContent) ?? undefined : undefined;
    const nonce = rawNonce ? normalizeBytes(rawNonce) ?? undefined : undefined;

    // Return a basic Post object - additional data will be loaded separately
    const post: Post = {
      id,
      author: createDefaultUser(ownerId),
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
    return enrichPostFullHelper(
      post,
      (postId) => this.getPostStats(postId),
      (postId) => this.getUserInteractions(postId)
    );
  }

  /**
   * Batch enrich multiple posts efficiently.
   * Uses batch queries to minimize network requests.
   * Returns new Post objects with enriched data including _enrichment for N+1 avoidance.
   */
  async enrichPostsBatch(posts: Post[]): Promise<Post[]> {
    return enrichPostsBatchHelper(
      posts,
      (postIds) => this.getBatchPostStats(postIds),
      (postIds) => this.getBatchUserInteractions(postIds),
      this.getCurrentUserId()
    );
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
   * Delete a post by its ID.
   * Only the post owner can delete their own posts.
   */
  async deletePost(postId: string, ownerId: string): Promise<boolean> {
    try {
      const { stateTransitionService } = await import('./state-transition-service');

      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        postId,
        ownerId
      );

      return result.success;
    } catch (error) {
      logger.error('Error deleting post:', error);
      return false;
    }
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
    if (options.quotedPostId) data.quotedPostId = stringToIdentifierBytes(options.quotedPostId);
    if (options.quotedPostOwnerId) data.quotedPostOwnerId = stringToIdentifierBytes(options.quotedPostOwnerId);
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
    return fetchFollowingFeed(
      userId,
      this.contractId,
      (doc) => this.transformDocument(doc),
      options
    );
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
      logger.error('Error getting post by ID:', error);
      return null;
    }
  }

  /**
   * Resolve and set the author for a post (awaited).
   * This prevents the "Unknown User" race condition for single post views.
   */
  private async resolvePostAuthor(post: Post): Promise<void> {
    return resolvePostAuthorHelper(post);
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
        logger.error('Error counting user posts:', error);
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
        logger.error('Error counting all posts:', error);
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
    return fetchPostStats(postId, this.statsCache);
  }

  /**
   * Get user interactions with a post
   */
  private async getUserInteractions(postId: string): Promise<{
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  }> {
    return fetchUserInteractions(postId, this.getCurrentUserId());
  }

  /**
   * Get current user ID from localStorage session
   */
  private getCurrentUserId(): string | null {
    return getSessionUserId();
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
    return fetchBatchUserInteractions(postIds, currentUserId);
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
    return fetchBatchPostStats(postIds);
  }

  /**
   * Count unique authors across all posts
   * Paginates through all posts and counts unique $ownerId values.
   * Uses the languageTimeline index [language, $createdAt] to scan posts.
   * Note: Currently only counts authors of English posts (language='en').
   */
  async countUniqueAuthors(): Promise<number> {
    // Use a constant key since this counts all unique authors
    return this.countUniqueAuthorsDeduplicator.dedupe('all', () =>
      fetchUniqueAuthorCount(this.contractId)
    );
  }

  /**
   * Get top posts by like count
   * Fetches recent posts, gets their stats, and sorts by likes
   */
  async getTopPostsByLikes(limit: number = 5): Promise<Post[]> {
    return fetchTopPostsByLikes(
      limit,
      (options) => this.getTimeline(options),
      (postIds) => this.getBatchPostStats(postIds),
      (posts) => this.enrichPostsBatch(posts)
    );
  }

  /**
   * Get post counts per author
   * Returns a Map of authorId -> post count
   * Uses the languageTimeline index [language, $createdAt] to scan posts.
   * Note: Currently only counts English posts (language='en').
   */
  async getAuthorPostCounts(): Promise<Map<string, number>> {
    return fetchAuthorPostCounts(this.contractId);
  }

  /**
   * Get posts that quote a specific post.
   * Uses quotedPostAndOwner index via quotedPostId lookup.
   */
  async getQuotePosts(quotedPostId: string, options: { limit?: number } = {}): Promise<Post[]> {
    return fetchQuotePosts(
      quotedPostId,
      this.contractId,
      (doc) => this.transformDocument(doc),
      options
    );
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
    return fetchQuotesOfMyPosts(
      userId,
      this.contractId,
      (doc) => this.transformDocument(doc),
      since
    );
  }

  /**
   * Fetch content by IDs, trying posts first and then replies for any not found.
   * Replies are converted to Post format for unified feed rendering.
   */
  async fetchPostsOrReplies(ids: string[]): Promise<Post[]> {
    if (ids.length === 0) return [];

    const { replyService } = await import('./reply-service');
    const { blogPostService } = await import('./blog-post-service');
    const { blogService } = await import('./blog-service');
    const { dpnsService } = await import('./dpns-service');
    const { unifiedProfileService } = await import('./unified-profile-service');

    const posts = await this.getPostsByIds(ids);
    const foundPostIds = new Set(posts.map((post) => post.id));
    const missingIds = ids.filter((id) => !foundPostIds.has(id));

    if (missingIds.length === 0) {
      return posts;
    }

    const replies = await replyService.getRepliesByIds(missingIds);
    const foundReplyIds = new Set(replies.map((reply) => reply.id));
    const remainingIds = missingIds.filter((id) => !foundReplyIds.has(id));
    const convertedReplies: Post[] = replies.map((reply) => ({
      id: reply.id,
      author: reply.author,
      content: reply.content,
      createdAt: reply.createdAt,
      likes: reply.likes,
      reposts: reply.reposts,
      replies: reply.replies,
      views: reply.views,
      liked: reply.liked,
      reposted: reply.reposted,
      bookmarked: reply.bookmarked,
      media: reply.media,
      encryptedContent: reply.encryptedContent,
      epoch: reply.epoch,
      nonce: reply.nonce,
      parentId: reply.parentId,
      parentOwnerId: reply.parentOwnerId,
      _enrichment: reply._enrichment,
    }));

    if (remainingIds.length === 0) {
      return [...posts, ...convertedReplies];
    }

    const blogPostResults = await Promise.allSettled(remainingIds.map((id) => blogPostService.getPost(id)));
    const blogPosts = blogPostResults
      .filter((r): r is PromiseFulfilledResult<BlogPost | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((post): post is BlogPost => post !== null);

    const convertedBlogPosts: Post[] = await Promise.all(
      blogPosts.map(async (blogPost) => {
        const [blog, username, profile] = await Promise.all([
          blogService.getBlog(blogPost.blogId).catch((err) => {
            logger.warn('Failed to load quoted blog:', err);
            return null;
          }),
          dpnsService.resolveUsername(blogPost.ownerId).catch((err) => {
            logger.warn('Failed to resolve quoted blog username:', err);
            return null;
          }),
          unifiedProfileService.getProfile(blogPost.ownerId).catch((err) => {
            logger.warn('Failed to load quoted blog profile:', err);
            return null;
          }),
        ]);

        const blogText = blogPost.subtitle || blogPost.title;

        return {
          id: blogPost.id,
          author: {
            id: blogPost.ownerId,
            username: username || '',
            displayName: profile?.displayName || blog?.name || 'Blog author',
            avatar: profile?.avatar || blog?.avatar || '',
            followers: 0,
            following: 0,
            verified: false,
            joinedAt: new Date(0),
            hasDpns: username ? true : undefined,
          },
          content: blogText,
          createdAt: blogPost.createdAt,
          likes: 0,
          reposts: 0,
          replies: 0,
          views: 0,
          liked: false,
          reposted: false,
          bookmarked: false,
          __isBlogPostQuote: true,
          title: blogPost.title,
          subtitle: blogPost.subtitle,
          coverImage: blogPost.coverImage,
          slug: blogPost.slug,
          blogId: blogPost.blogId,
          blogName: blog?.name,
          blogUsername: username || undefined,
          blogContent: blogPost.content,
        };
      })
    );

    return [...posts, ...convertedReplies, ...convertedBlogPosts];
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
      logger.error('Error getting posts by IDs:', error);
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
