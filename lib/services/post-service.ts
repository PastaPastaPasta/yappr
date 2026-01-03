import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Post, User } from '../types';
import { identityService } from './identity-service';
import { profileService } from './profile-service';

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

  constructor() {
    super('post');
  }

  /**
   * Transform document to Post type
   */
  protected transformDocument(doc: any): Post {
    // SDK may nest document fields under 'data' property
    const data = doc.data || doc;

    // Handle different field naming conventions from SDK
    const id = doc.$id || doc.id;
    const ownerId = doc.$ownerId || doc.ownerId;
    const createdAt = doc.$createdAt || doc.createdAt;

    // Content and other fields may be in data or at root level
    const content = data.content || doc.content || '';
    const mediaUrl = data.mediaUrl || doc.mediaUrl;
    const replyToId = data.replyToPostId || doc.replyToPostId;
    const quotedPostId = data.quotedPostId || doc.quotedPostId;

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

    // Fire-and-forget enrichment for background data (author, stats)
    // Related entities (replyTo, quotedPost) should be fetched explicitly by components that need them
    this.enrichPost(post, id, ownerId);

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
        const author = await profileService.getProfile(ownerId);
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

    // Add optional fields
    if (options.mediaUrl) data.mediaUrl = options.mediaUrl;
    if (options.replyToId) data.replyToId = options.replyToId;
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
   * Get posts by user
   */
  async getUserPosts(userId: string, options: QueryOptions = {}): Promise<DocumentResult<Post>> {
    const queryOptions: QueryOptions = {
      where: [['$ownerId', '==', userId]],
      orderBy: [['$createdAt', 'desc']],
      limit: 20,
      ...options
    };

    return this.query(queryOptions);
  }

  /**
   * Get a single post by its document ID using direct lookup.
   * More efficient than querying all posts and filtering.
   * Awaits author resolution to prevent "Unknown User" race condition.
   */
  async getPostById(postId: string): Promise<Post | null> {
    try {
      const post = await this.get(postId);
      if (!post) return null;

      // For single post fetch, await author resolution to prevent race condition
      await this.resolvePostAuthor(post);

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
      const author = await profileService.getProfileWithUsername(post.author.id);
      if (author) {
        post.author = author;
      }
    } catch (error) {
      console.error('Error resolving post author:', error);
    }
  }

  /**
   * Count posts by user - uses direct SDK query for reliability
   */
  async countUserPosts(userId: string): Promise<number> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');

      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        contractId: this.contractId,
        type: 'post',
        where: [['$ownerId', '==', userId]],
        orderBy: [['$createdAt', 'asc']],
        limit: 100
      });

      let documents;
      if (Array.isArray(response)) {
        documents = response;
      } else if (response && response.documents) {
        documents = response.documents;
      } else if (response && typeof response.toJSON === 'function') {
        const json = response.toJSON();
        documents = Array.isArray(json) ? json : json.documents || [];
      } else {
        documents = [];
      }

      return documents.length;
    } catch (error) {
      console.error('Error counting user posts:', error);
      return 0;
    }
  }

  /**
   * Count all posts on the platform - paginates through all results
   */
  async countAllPosts(): Promise<number> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');

      const sdk = await getEvoSdk();
      let totalCount = 0;
      let startAfter: string | undefined = undefined;
      const PAGE_SIZE = 100;

      while (true) {
        const queryParams: any = {
          contractId: this.contractId,
          type: 'post',
          orderBy: [['$createdAt', 'asc']],
          limit: PAGE_SIZE
        };

        if (startAfter) {
          queryParams.startAfter = startAfter;
        }

        const response = await sdk.documents.query(queryParams);

        let documents: any[];
        if (Array.isArray(response)) {
          documents = response;
        } else if (response && response.documents) {
          documents = response.documents;
        } else if (response && typeof response.toJSON === 'function') {
          const json = response.toJSON();
          documents = Array.isArray(json) ? json : json.documents || [];
        } else {
          documents = [];
        }

        totalCount += documents.length;

        // If we got fewer than PAGE_SIZE, we've reached the end
        if (documents.length < PAGE_SIZE) {
          break;
        }

        // Get the last document's ID for pagination
        const lastDoc = documents[documents.length - 1];
        const lastId = lastDoc.$id || lastDoc.id;
        if (!lastId) {
          break;
        }
        startAfter = lastId;
      }

      return totalCount;
    } catch (error) {
      console.error('Error counting all posts:', error);
      return 0;
    }
  }

  /**
   * Get replies to a post.
   * Awaits author resolution for all replies to prevent "Unknown User" race condition.
   */
  async getReplies(postId: string, options: QueryOptions = {}): Promise<DocumentResult<Post>> {
    // Pass identifier as base58 string - the SDK handles conversion
    // Dash Platform requires a where clause on the orderBy field for ordering to work
    const queryOptions: QueryOptions = {
      where: [
        ['replyToPostId', '==', postId],
        ['$createdAt', '>', 0]
      ],
      orderBy: [['$createdAt', 'asc']],
      limit: 20,
      ...options
    };

    const result = await this.query(queryOptions);

    // Await author resolution for all replies to prevent race condition
    await Promise.all(result.documents.map(post => this.resolvePostAuthor(post)));

    return result;
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
    // This would check if the current user has liked/reposted/bookmarked
    // For now, return false for all
    return {
      liked: false,
      reposted: false,
      bookmarked: false
    };
  }

  /**
   * Get default user object when profile not found
   */
  private getDefaultUser(userId: string | undefined): User {
    const id = userId || 'unknown';
    return {
      id,
      username: id.length > 8 ? id.substring(0, 8) + '...' : id,
      displayName: 'Unknown User',
      avatar: '',
      bio: '',
      followers: 0,
      following: 0,
      verified: false,
      joinedAt: new Date()
    };
  }
}

// Singleton instance
export const postService = new PostService();