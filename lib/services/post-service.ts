import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Post, User, PostQueryOptions } from '../types';
import { identityService } from './identity-service';
import { profileService } from './profile-service';
import { dpnsService } from './dpns-service';

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
   * Transform document to Post type.
   * Returns a Post with default placeholder values - callers should use
   * enrichPostFull() or enrichPostsBatch() to populate stats and author data.
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
   * Enrich a single post with all data (stats, interactions, author).
   * This is the explicit, awaitable alternative to fire-and-forget enrichment.
   * Returns a new Post object with enriched data.
   */
  async enrichPostFull(post: Post): Promise<Post> {
    try {
      const [stats, interactions, author] = await Promise.all([
        this.getPostStats(post.id),
        this.getUserInteractions(post.id),
        profileService.getProfileWithUsername(post.author.id)
      ]);

      return {
        ...post,
        likes: stats.likes,
        reposts: stats.reposts,
        replies: stats.replies,
        views: stats.views,
        liked: interactions.liked,
        reposted: interactions.reposted,
        bookmarked: interactions.bookmarked,
        author: author || post.author
      };
    } catch (error) {
      console.error('Error enriching post:', error);
      return post;
    }
  }

  /**
   * Batch enrich multiple posts efficiently.
   * Uses batch queries to minimize network requests.
   * Returns new Post objects with enriched data.
   */
  async enrichPostsBatch(posts: Post[]): Promise<Post[]> {
    if (posts.length === 0) return posts;

    try {
      const postIds = posts.map(p => p.id);
      const authorIds = Array.from(new Set(posts.map(p => p.author.id).filter(Boolean)));

      const [statsMap, interactionsMap, usernameMap, profiles] = await Promise.all([
        this.getBatchPostStats(postIds),
        this.getBatchUserInteractions(postIds),
        dpnsService.resolveUsernamesBatch(authorIds),
        profileService.getProfilesByIdentityIds(authorIds)
      ]);

      // Build profile map for quick lookup
      const profileMap = new Map<string, any>();
      profiles.forEach((profile: any) => {
        const ownerId = profile.$ownerId || profile.ownerId;
        if (ownerId) {
          profileMap.set(ownerId, profile);
        }
      });

      return posts.map(post => {
        const stats = statsMap.get(post.id);
        const interactions = interactionsMap.get(post.id);
        const username = usernameMap.get(post.author.id);
        const profile = profileMap.get(post.author.id);
        const profileData = profile?.data || profile;

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
            displayName: profileData?.displayName || post.author.displayName,
            hasDpns: username ? true : false
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
   * Batch get user interactions for multiple posts
   * Much more efficient than calling getUserInteractions per post
   * Makes 3 queries total instead of 3 per post
   */
  async getBatchUserInteractions(postIds: string[]): Promise<Map<string, {
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  }>> {
    const result = new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>();

    // Initialize all posts with false
    postIds.forEach(id => {
      result.set(id, { liked: false, reposted: false, bookmarked: false });
    });

    const currentUserId = this.getCurrentUserId();
    if (!currentUserId) {
      return result;
    }

    try {
      // Fetch all user's likes, reposts, and bookmarks in 3 queries total
      const [{ likeService }, { repostService }, { bookmarkService }] = await Promise.all([
        import('./like-service'),
        import('./repost-service'),
        import('./bookmark-service')
      ]);

      const [userLikes, userReposts, userBookmarks] = await Promise.all([
        likeService.getUserLikes(currentUserId),
        repostService.getUserReposts(currentUserId),
        bookmarkService.getUserBookmarks(currentUserId)
      ]);

      // Create Sets of post IDs the user has interacted with
      const likedPostIds = new Set(userLikes.map(l => l.postId));
      const repostedPostIds = new Set(userReposts.map(r => r.postId));
      const bookmarkedPostIds = new Set(userBookmarks.map(b => b.postId));

      // Check each post against the Sets
      postIds.forEach(postId => {
        result.set(postId, {
          liked: likedPostIds.has(postId),
          reposted: repostedPostIds.has(postId),
          bookmarked: bookmarkedPostIds.has(postId)
        });
      });

      return result;
    } catch (error) {
      console.error('Error getting batch user interactions:', error);
      return result;
    }
  }

  /**
   * Get reply counts for multiple posts in a single batch query
   * Uses 'in' operator for efficient querying
   */
  async getRepliesByPostIds(postIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    postIds.forEach(id => result.set(id, 0));

    if (postIds.length === 0) return result;

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // Use 'in' operator for batch query on replyToPostId
      // Must include orderBy to match the replyToPost index: [replyToPostId, $createdAt]
      const response = await sdk.documents.query({
        contractId: this.contractId,
        type: 'post',
        where: [['replyToPostId', 'in', postIds]],
        orderBy: [['replyToPostId', 'asc']],
        limit: 100
      });

      let documents: any[] = [];
      if (Array.isArray(response)) {
        documents = response;
      } else if (response && response.documents) {
        documents = response.documents;
      } else if (response && typeof response.toJSON === 'function') {
        const json = response.toJSON();
        documents = Array.isArray(json) ? json : json.documents || [];
      }

      // Count replies per parent post
      for (const doc of documents) {
        // Handle different document structures from SDK
        // Batch queries return: { id, ownerId, data: { replyToPostId } }
        const data = doc.data || doc;
        let parentId = data.replyToPostId || doc.replyToPostId;

        // Convert replyToPostId from bytes to base58 string if needed
        if (parentId && typeof parentId !== 'string') {
          try {
            const bytes = parentId instanceof Uint8Array ? parentId : new Uint8Array(parentId);
            const bs58 = require('bs58');
            parentId = bs58.encode(bytes);
          } catch (e) {
            console.warn('Failed to convert replyToPostId to base58:', e);
            continue;
          }
        }

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
   * Batch get stats for multiple posts using efficient batch queries
   * Makes 3 batch queries total instead of 3 per post
   */
  async getBatchPostStats(postIds: string[]): Promise<Map<string, PostStats>> {
    const result = new Map<string, PostStats>();

    // Initialize all posts with zero stats
    postIds.forEach(id => {
      result.set(id, { postId: id, likes: 0, reposts: 0, replies: 0, views: 0 });
    });

    if (postIds.length === 0) return result;

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
}

// Singleton instance
export const postService = new PostService();