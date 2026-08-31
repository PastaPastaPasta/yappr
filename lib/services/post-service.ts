import { logger } from '@/lib/logger';
import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Post, PostQueryOptions, Reply } from '../../types';
import type { BlogPost } from '@/lib/types';
import { identifierToBase58, RequestDeduplicator, identifierStringToDocumentBytes, normalizeBytes, getCurrentUserId as getSessionUserId, createDefaultUser } from './sdk-helpers';
import { documentCount, groupedDocumentCount } from './pagination-utils';
import { fetchBatchPostStats, fetchBatchUserInteractions, fetchPostStats, fetchUserInteractions } from './post-stats-helpers';
import { authorFieldIsRequired, groupByInteractionSurface, hashtagIsOptional, hashtagMaxLength, hashtagsAreInline, quoteFieldFor, type KindedTarget, type TargetKind } from '@/lib/contract-topology';
import { firstHashtag } from '@/lib/post-helpers';
import { tombstoneDocument } from './tombstone-helpers';
import { enrichPostFull as enrichPostFullHelper, enrichPostsBatch as enrichPostsBatchHelper, resolvePostAuthor as resolvePostAuthorHelper } from './post-enrichment-helpers';
import { fetchAuthorPostCounts, fetchFollowingFeed, fetchQuotePosts, fetchQuotesOfMyPosts, fetchTopPostsByLikes, fetchUniqueAuthorCount } from './post-query-helpers';
import { extractPostEmbedFields, type PostEmbed } from '@/lib/poll-embed';
import { normalizeMediaUrl } from '@/lib/utils/ipfs-gateway';

export interface PostDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  content: string;
  mediaUrl?: string;
  quotedPostId?: string;
  quotedPostOwnerId?: string;
  language?: string;
  sensitive?: boolean;
  embedContractId?: string;
  embedDocType?: string;
  embedId?: string;
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
  quotes: number;
  views: number;
}

/**
 * Dedupe key for a batch of targets, namespaced per doctype set: the same id
 * list answers differently depending on which interaction surface it is asked
 * about, so two batches may only share an in-flight request when they resolve
 * to the same doctypes.
 */
function batchDedupeKey(targets: readonly KindedTarget[]): string {
  return groupByInteractionSurface(targets)
    .map(({ key, ids }) => `${key}#${RequestDeduplicator.createBatchKey(ids)}`)
    .sort()
    .join('||');
}

/**
 * Render a `reply` document through the Post shape, tagged with the doctype it
 * came from so engagements and deletes keep addressing `reply`.
 */
export function replyToPost(reply: Reply): Post {
  return {
    id: reply.id,
    targetKind: 'reply',
    author: reply.author,
    content: reply.content,
    createdAt: reply.createdAt,
    likes: reply.likes,
    reposts: reply.reposts,
    replies: reply.replies,
    quotes: 0,
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
    rootPostId: reply.rootPostId,
    replyToReplyId: reply.replyToReplyId,
    deleted: reply.deleted,
    _enrichment: reply._enrichment,
  };
}

/**
 * Load blog posts by id and render them through the Post shape used for embedded
 * blog-quote cards. Ids that are not blog posts are simply absent from the result.
 */
async function fetchBlogPostsAsQuotes(blogPostIds: string[]): Promise<Post[]> {
  if (blogPostIds.length === 0) return [];

  const { blogPostService } = await import('./blog-post-service');
  const { blogService } = await import('./blog-service');
  const { dpnsService } = await import('./dpns-service');
  const { unifiedProfileService } = await import('./unified-profile-service');

  const settled = await Promise.allSettled(blogPostIds.map((id) => blogPostService.getPost(id)));
  const blogPosts = settled
    .filter((r): r is PromiseFulfilledResult<BlogPost | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((post): post is BlogPost => post !== null);

  return Promise.all(
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
          hasDpns: Boolean(username),
        },
        content: blogPost.subtitle || blogPost.title,
        createdAt: blogPost.createdAt,
        likes: 0,
        reposts: 0,
        replies: 0,
        quotes: 0,
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
    // - Identifier-like document fields (quotedPostId, etc): base64 strings or byte arrays
    // Handle both $ prefixed (query responses) and non-prefixed (creation responses) fields
    const id = (doc.$id || doc.id) as string;
    const ownerId = (doc.$ownerId || doc.ownerId) as string;
    const createdAt = (doc.$createdAt || doc.createdAt) as number;

    // Content and other fields may be in data or at root level
    const content = (data.content || doc.content || '') as string;
    const mediaUrl = (data.mediaUrl || doc.mediaUrl) as string | undefined;

    // Normalize identifier-like fields to base58 for consistent storage.
    const rawQuotedPostId = data.quotedPostId || doc.quotedPostId;
    const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) || undefined : undefined;

    const rawQuotedPostOwnerId = data.quotedPostOwnerId || doc.quotedPostOwnerId;
    const quotedPostOwnerId = rawQuotedPostOwnerId ? identifierToBase58(rawQuotedPostOwnerId) || undefined : undefined;

    // v3 only: a quote of a REPLY lands in its own field so the reference can be
    // refersTo-checked. Absent on v2 documents.
    const rawQuotedReplyId = data.quotedReplyId || doc.quotedReplyId;
    const quotedReplyId = rawQuotedReplyId ? identifierToBase58(rawQuotedReplyId) || undefined : undefined;

    // Cross-contract embed (native polls); identifiers normalized to base58.
    const embed = extractPostEmbedFields(data, doc);

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
      // This transform only ever reads `post` documents.
      targetKind: 'post',
      author: createDefaultUser(ownerId),
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
      media: mediaUrl ? [{
        id: id + '-media',
        type: 'image',
        url: normalizeMediaUrl(mediaUrl)
      }] : undefined,
      // Expose IDs for lazy loading at component level
      quotedPostId: quotedPostId || undefined,
      quotedPostOwnerId: quotedPostOwnerId || undefined,
      quotedReplyId,
      deleted: (data.deleted ?? doc.deleted) === true ? true : undefined,
      sensitive: (data.sensitive ?? doc.sensitive) === true ? true : undefined,
      // v4/v5 only: the single indexed hashtag ('' = untagged in memory).
      // Absent on v2/v3 documents; the like path reads it for the
      // consensus-checked agreement. On v5 the chain spells "untagged" as an
      // ABSENT property — normalized back to the client's '' sentinel here, so
      // downstream consumers (like path, caches) keep one convention:
      // '' = known untagged, undefined = unknown/not-a-v4+ document.
      hashtag: typeof (data.hashtag ?? doc.hashtag) === 'string'
        ? (data.hashtag ?? doc.hashtag) as string
        : hashtagIsOptional() ? '' : undefined,
      ...embed,
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
      (target) => this.getPostStats(target),
      (target) => this.getUserInteractions(target)
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
      (targets) => this.getBatchPostStats(targets),
      (targets) => this.getBatchUserInteractions(targets),
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
   * Blank a post in place, leaving a tombstone.
   *
   * The v3/v4 `post` doctype is `canBeDeleted: false`, so this is what "delete"
   * means there. Only the required content properties survive; body, media,
   * quote, embed and every encrypted field are dropped. On v3 that is just
   * `language`; v4 adds `author` and `hashtag`, both carried over VERBATIM:
   * `author` must keep equalling `$ownerId`, and `hashtag` is client-immutable
   * because existing likes repeated it under a consensus-checked agreement —
   * blanking it on the tombstone REPLACE would leave the post claiming
   * "untagged" while its likes still carry the original tag (and any later
   * like sourced from a stale UI object would be rejected with 40127). The
   * tombstone therefore stays in its tag's `tagAndTime` listing, rendered as a
   * deleted card — same treatment `language` timelines already get.
   *
   * On v5 an UNTAGGED post has no `hashtag` property at all;
   * `tombstoneDocument` skips absent preserveScalars, so the tombstone
   * reproduces the absence verbatim (writing `''` instead would both fail the
   * pattern and break the likes' absence agreement).
   */
  async tombstonePost(postId: string, ownerId: string): Promise<boolean> {
    const ok = await tombstoneDocument({
      contractId: this.contractId,
      documentType: this.documentType,
      documentId: postId,
      ownerId,
      preserveScalars: hashtagsAreInline() ? ['language', 'hashtag'] : ['language'],
      preserveIdentifiers: authorFieldIsRequired() ? ['author'] : undefined,
    });
    // The inherited 2-minute content cache would otherwise re-serve the
    // pre-tombstone plaintext to a detail view reached via SPA navigation.
    if (ok) this.cache.delete(postId);
    return ok;
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
      /** v3 only: quoting a reply instead of a post (mutually exclusive with quotedPostId). */
      quotedReplyId?: string;
      language?: string;
      sensitive?: boolean;
      /**
       * Cross-contract embed (e.g. a Pollr poll). All three parts are written
       * together; the two identifiers go out as raw bytes.
       */
      embed?: PostEmbed;
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

    // v4: the poster-attested author (must equal $ownerId — consensus can't
    // bind the agreement to a system field, so the client writes it) and the
    // single indexed hashtag — the FIRST tag of the PUBLIC content only
    // (`data.content` is already the teaser/placeholder for private posts, so
    // encrypted text never leaks into the index), '' when untagged.
    if (authorFieldIsRequired()) {
      data.author = identifierStringToDocumentBytes(ownerId);
    }
    if (hashtagsAreInline()) {
      const tag = firstHashtag(data.content as string, hashtagMaxLength());
      // v5: an untagged post OMITS the optional property — likes mirror the
      // absence under the absence-aware propertyAgreement, and `skipIfAbsent`
      // keeps untagged likes out of byHashtagPost entirely. v4 has no optional
      // hashtag and writes the '' sentinel.
      if (tag !== '' || !hashtagIsOptional()) {
        data.hashtag = tag;
      }
    }

    // Add optional fields (use contract field names)
    if (options.mediaUrl && options.encryption) {
      // A plaintext mediaUrl on an encrypted post would leak the private media
      // reference; callers must keep it inside the encrypted content instead.
      throw new Error('mediaUrl cannot be combined with encryption');
    }
    if (options.mediaUrl) data.mediaUrl = options.mediaUrl;
    if (options.quotedPostId) data.quotedPostId = identifierStringToDocumentBytes(options.quotedPostId);
    if (options.quotedReplyId) data.quotedReplyId = identifierStringToDocumentBytes(options.quotedReplyId);
    if (options.quotedPostOwnerId) data.quotedPostOwnerId = identifierStringToDocumentBytes(options.quotedPostOwnerId);
    if (options.sensitive !== undefined) data.sensitive = options.sensitive;
    if (options.embed) {
      data.embedContractId = identifierStringToDocumentBytes(options.embed.contractId);
      data.embedDocType = options.embed.docType;
      data.embedId = identifierStringToDocumentBytes(options.embed.id);
    }

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
   * Count posts by user via the `byOwner` count tree (O(1)).
   * Deduplicates in-flight requests.
   */
  async countUserPosts(userId: string): Promise<number> {
    return this.countUserPostsDeduplicator.dedupe(userId, async () => {
      try {
        const { getEvoSdk } = await import('./evo-sdk-service');
        const sdk = await getEvoSdk();

        return await documentCount(sdk, {
          dataContractId: this.contractId,
          documentTypeName: 'post',
          where: [['$ownerId', '==', userId]],
        });
      } catch (error) {
        logger.error('Error counting user posts:', error);
        return 0;
      }
    });
  }

  /**
   * Count all posts on the platform via the doctype's primary-key count tree
   * (`documentsCountable`, O(1) — counts every post regardless of language).
   * Deduplicates in-flight requests.
   */
  async countAllPosts(): Promise<number> {
    // Use a constant key since this counts all posts
    return this.countAllPostsDeduplicator.dedupe('all', async () => {
      try {
        const { getEvoSdk } = await import('./evo-sdk-service');
        const sdk = await getEvoSdk();

        return await documentCount(sdk, {
          dataContractId: this.contractId,
          documentTypeName: 'post',
        });
      } catch (error) {
        logger.error('Error counting all posts:', error);
        return 0;
      }
    });
  }

  /**
   * Get statistics (likes, reposts, replies) for a post or reply
   */
  private async getPostStats(target: KindedTarget): Promise<PostStats> {
    return fetchPostStats(target, this.statsCache);
  }

  /**
   * Get user interactions with a post or reply
   */
  private async getUserInteractions(target: KindedTarget): Promise<{
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  }> {
    return fetchUserInteractions(target, this.getCurrentUserId());
  }

  /**
   * Get current user ID from localStorage session
   */
  private getCurrentUserId(): string | null {
    return getSessionUserId();
  }

  /**
   * Batch get user interactions for multiple posts/replies.
   * Deduplicates in-flight requests.
   */
  async getBatchUserInteractions(targets: readonly KindedTarget[]): Promise<Map<string, {
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  }>> {
    const currentUserId = this.getCurrentUserId();
    if (!currentUserId || targets.length === 0) {
      const result = new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>();
      targets.forEach(({ id }) => result.set(id, { liked: false, reposted: false, bookmarked: false }));
      return result;
    }

    // Include userId in the key since interactions are user-specific, and the
    // doctype set because the same id list answers differently per surface.
    const cacheKey = `${currentUserId}:${batchDedupeKey(targets)}`;
    return this.interactionsDeduplicator.dedupe(cacheKey, () => fetchBatchUserInteractions(targets, currentUserId));
  }

  /**
   * Batch get stats for multiple posts/replies using efficient batch queries.
   * Deduplicates in-flight requests: multiple callers with the same targets
   * share one request.
   */
  async getBatchPostStats(targets: readonly KindedTarget[]): Promise<Map<string, PostStats>> {
    if (targets.length === 0) {
      return new Map<string, PostStats>();
    }

    return this.statsDeduplicator.dedupe(batchDedupeKey(targets), () => fetchBatchPostStats(targets));
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
      (targets) => this.getBatchPostStats(targets),
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
   * Get posts that quote a specific post or reply, newest first.
   *
   * The listing index depends on the kind: `quotedPostAndOwner` on v2, and the
   * chronological `quotesOfPost`/`quotesOfReply` indexes on v3 (where the old
   * unique index is gone, because re-quoting a target is legitimate).
   */
  async getQuotePosts(quotedPostId: string, kind: TargetKind = 'post', options: { limit?: number } = {}): Promise<Post[]> {
    const quoteField = quoteFieldFor(kind);
    if (!quoteField) return [];
    return fetchQuotePosts(
      quotedPostId,
      quoteField,
      this.contractId,
      (doc) => this.transformDocument(doc),
      options
    );
  }

  /**
   * Count quotes of a post or reply — O(1) count tree on the quote field for
   * that kind (`quoteCount` on v2, plus `quoteReplyCount` on v3).
   */
  async countQuotes(quotedPostId: string, kind: TargetKind = 'post'): Promise<number> {
    const quoteField = quoteFieldFor(kind);
    if (!quoteField) return 0;
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();
      return await documentCount(sdk, {
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [[quoteField, '==', quotedPostId]],
      });
    } catch (error) {
      logger.error('Error counting quotes:', error);
      return 0;
    }
  }

  /** Quote counts for multiple targets via one grouped count-tree query (falls back to per-target reads). */
  async countQuotesForPosts(quotedPostIds: string[], kind: TargetKind = 'post'): Promise<Map<string, number>> {
    const quoteField = quoteFieldFor(kind);
    if (!quoteField) return new Map(quotedPostIds.map((id) => [id, 0]));
    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();
    return groupedDocumentCount(
      sdk,
      { dataContractId: this.contractId, documentTypeName: this.documentType, groupField: quoteField },
      quotedPostIds,
      (id) => this.countQuotes(id, kind)
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

    const posts = await this.getPostsByIds(ids);
    const foundPostIds = new Set(posts.map((post) => post.id));
    const missingIds = ids.filter((id) => !foundPostIds.has(id));

    if (missingIds.length === 0) {
      return posts;
    }

    const replies = await replyService.getRepliesByIds(missingIds);
    const foundReplyIds = new Set(replies.map((reply) => reply.id));
    const remainingIds = missingIds.filter((id) => !foundReplyIds.has(id));
    const convertedReplies = replies.map(replyToPost);

    if (remainingIds.length === 0) {
      return [...posts, ...convertedReplies];
    }

    const convertedBlogPosts = await fetchBlogPostsAsQuotes(remainingIds);
    return [...posts, ...convertedReplies, ...convertedBlogPosts];
  }

  /**
   * Resolve quote targets when each quote field names exactly ONE doctype (v3).
   *
   * `fetchPostsOrReplies`'s cascade exists because v2's single `quotedPostId`
   * could hold a post id, a reply id or a blog-post id, so every miss had to be
   * retried against the next doctype. v3 splits those into `quotedPostId`,
   * `quotedReplyId` and the cross-contract embed triple, so the caller already
   * knows where each id lives and nothing is probed.
   */
  async fetchQuotedTargets(ids: {
    postIds: string[];
    replyIds: string[];
    blogPostIds: string[];
  }): Promise<Post[]> {
    const { replyService } = await import('./reply-service');
    const [posts, replies, blogPosts] = await Promise.all([
      ids.postIds.length > 0 ? this.getPostsByIds(ids.postIds) : Promise.resolve<Post[]>([]),
      ids.replyIds.length > 0 ? replyService.getRepliesByIds(ids.replyIds) : Promise.resolve<Reply[]>([]),
      fetchBlogPostsAsQuotes(ids.blogPostIds),
    ]);
    return [...posts, ...replies.map(replyToPost), ...blogPosts];
  }

  /**
   * v4 tag page listing: posts carrying `hashtag`, newest first, via the
   * `tagAndTime [hashtag, $createdAt]` index. Replaces the postHashtag-document
   * indirection (doctype absent on v4) — the documents ARE the posts, written
   * by their owners, so no ownership cross-check is needed.
   */
  async getPostsByHashtag(hashtag: string, options: { limit?: number } = {}): Promise<Post[]> {
    try {
      const result = await this.query({
        where: [
          ['hashtag', '==', hashtag],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']],
        limit: options.limit ?? 50,
      });
      return result.documents;
    } catch (error) {
      logger.error('Error getting posts by hashtag:', error);
      return [];
    }
  }

  /**
   * v4: how many posts carry `hashtag`. `tagAndTime` is not countable, so this
   * pages through the index and counts — bounded (maxResults 1000), which is
   * plenty for the search-suggestion count it serves.
   */
  async countPostsByHashtag(hashtag: string): Promise<number> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();
      const { paginateCount } = await import('./pagination-utils');
      const { count } = await paginateCount(sdk, () => ({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['hashtag', '==', hashtag],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']],
      }));
      return count;
    } catch (error) {
      logger.error('Error counting posts by hashtag:', error);
      return 0;
    }
  }

  /**
   * Get multiple posts by their IDs.
   * Useful for fetching original posts when displaying reposts or quotes.
   * Author info is resolved for each post.
   */
  async getPostsByIds(postIds: string[], options: PostQueryOptions = {}): Promise<Post[]> {
    if (postIds.length === 0) return [];

    try {
      // Fetch posts in parallel with concurrency limit
      const BATCH_SIZE = 5;
      const posts: Post[] = [];

      for (let i = 0; i < postIds.length; i += BATCH_SIZE) {
        const batch = postIds.slice(i, i + BATCH_SIZE);
        const batchPosts = await Promise.all(
          // Authors resolve per post by default; callers that batch-enrich
          // afterwards pass skipEnrichment to avoid paying for them twice.
          batch.map(id => this.getPostById(id, options))
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
