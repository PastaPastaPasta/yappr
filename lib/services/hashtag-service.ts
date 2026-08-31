import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierStringToDocumentBytes, identifierToBase58, normalizeSDKResponse } from './sdk-helpers';
import { documentCount, paginateFetchAll } from './pagination-utils';
import { hashtagsAreInline, prefixRankingsAvailable } from '../contract-topology';

export interface PostHashtagDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
  hashtag: string; // lowercase, no # prefix
}

export interface TrendingHashtag {
  hashtag: string;
  postCount: number;
}

class HashtagService extends BaseDocumentService<PostHashtagDocument> {
  private trendingCache: {
    data: TrendingHashtag[];
    timestamp: number;
  } | null = null;
  private readonly TRENDING_CACHE_TTL = 300000; // 5 minutes

  constructor() {
    super('postHashtag');
  }

  /**
   * Transform document from SDK response to typed object
   * System identifier fields arrive as base58, while identifier-like document fields may
   * arrive as base64 or raw bytes in query results.
   */
  protected transformDocument(doc: Record<string, unknown>): PostHashtagDocument {
    const data = (doc.data || doc) as Record<string, unknown>;
    const rawPostId = data.postId || doc.postId;
    const hashtag = (data.hashtag || doc.hashtag) as string;

    // Normalize the identifier-like postId field to base58.
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    if (rawPostId && !postId) {
      logger.error('HashtagService: Invalid postId format:', rawPostId);
    }

    return {
      $id: doc.$id as string,
      $ownerId: doc.$ownerId as string,
      $createdAt: doc.$createdAt as number,
      postId: postId || '',
      hashtag
    };
  }

  /**
   * Create a single hashtag document for a post
   */
  async createPostHashtag(postId: string, ownerId: string, hashtag: string): Promise<boolean> {
    // v4: the postHashtag doctype does not exist — a post's single hashtag is
    // written inline at post creation and cannot be added afterwards.
    if (hashtagsAreInline()) {
      logger.warn('createPostHashtag called on an inline-hashtag topology — nothing to write');
      return false;
    }

    // Validate and normalize hashtag
    const normalizedTag = this.normalizeHashtag(hashtag);
    if (!normalizedTag) {
      logger.warn('Invalid hashtag:', hashtag);
      return false;
    }

    try {
      // Check if already exists (unique index on postId + hashtag)
      const existing = await this.getHashtagForPost(postId, normalizedTag);
      if (existing) {
        logger.info('Hashtag already exists for post:', normalizedTag);
        return true;
      }

      // Create document via state transition
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        {
          postId: identifierStringToDocumentBytes(postId),
          hashtag: normalizedTag
        }
      );

      // Invalidate trending cache when new hashtag is created
      this.trendingCache = null;

      return result.success;
    } catch (error) {
      logger.error('Error creating hashtag:', error);
      return false;
    }
  }

  /**
   * Create multiple hashtag documents for a post
   */
  async createPostHashtags(postId: string, ownerId: string, hashtags: string[]): Promise<boolean[]> {
    const results: boolean[] = [];

    // Normalize and deduplicate hashtags
    const uniqueHashtags = Array.from(new Set(
      hashtags
        .map(h => this.normalizeHashtag(h))
        .filter((h): h is string => h !== null)
    ));

    for (const hashtag of uniqueHashtags) {
      const result = await this.createPostHashtag(postId, ownerId, hashtag);
      results.push(result);
    }

    return results;
  }

  /**
   * Get a specific hashtag document for a post
   */
  async getHashtagForPost(postId: string, hashtag: string): Promise<PostHashtagDocument | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const normalizedTag = this.normalizeHashtag(hashtag);

      if (!normalizedTag) return null;

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['postId', '==', postId],
          ['hashtag', '==', normalizedTag]
        ],
        limit: 1
      });

      const documents = normalizeSDKResponse(response);
      return documents.length > 0 ? this.transformDocument(documents[0]) : null;
    } catch (error) {
      logger.error('Error getting hashtag for post:', error);
      return null;
    }
  }

  /**
   * Get all hashtags for a specific post
   */
  async getHashtagsForPost(postId: string): Promise<PostHashtagDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['postId', '==', postId],
          ['hashtag', '>', '']  // Range query on string field for ordering
        ],
        orderBy: [['postId', 'asc'], ['hashtag', 'asc']],
        limit: 20
      });

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      logger.error('Error getting hashtags for post:', error);
      return [];
    }
  }

  /**
   * Get the count of posts with a specific hashtag via the `byHashtag`
   * count tree (O(1)).
   */
  async getPostCountByHashtag(hashtag: string): Promise<number> {
    try {
      const normalizedTag = this.normalizeHashtag(hashtag);
      if (!normalizedTag) return 0;

      // v4: no postHashtag count tree — count posts on post.tagAndTime instead.
      if (hashtagsAreInline()) {
        const { postService } = await import('./post-service');
        return postService.countPostsByHashtag(normalizedTag);
      }

      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      return await documentCount(sdk, {
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['hashtag', '==', normalizedTag]],
      });
    } catch (error) {
      logger.error('Error getting post count by hashtag:', error);
      return 0;
    }
  }

  /**
   * Get post IDs that have a specific hashtag.
   * Paginates through all results to return complete list.
   * Returns postHashtag documents - caller should fetch actual posts and filter by ownership.
   */
  async getPostIdsByHashtag(hashtag: string): Promise<PostHashtagDocument[]> {
    try {
      // v4: no postHashtag documents to list — tag pages query post.tagAndTime
      // directly (see postService.getPostsByHashtag / app/hashtag).
      if (hashtagsAreInline()) return [];

      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const normalizedTag = this.normalizeHashtag(hashtag);

      if (!normalizedTag) return [];

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [
            ['hashtag', '==', normalizedTag],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      logger.error('Error getting posts by hashtag:', error);
      return [];
    }
  }

  /**
   * Get recent hashtag documents for trending calculation.
   * Paginates through all results to return complete list.
   */
  async getRecentHashtags(hours: number = 24): Promise<PostHashtagDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Calculate timestamp for X hours ago
      const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [['$createdAt', '>', cutoffTime]],
          orderBy: [['$createdAt', 'desc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      logger.error('Error getting recent hashtags:', error);
      return [];
    }
  }

  /**
   * Get trending hashtags (with caching)
   */
  async getTrendingHashtags(options: {
    timeWindowHours?: number;
    minPosts?: number;
    limit?: number;
  } = {}): Promise<TrendingHashtag[]> {
    const {
      timeWindowHours = 24,
      minPosts = 1,
      limit = 12
    } = options;

    // Check cache
    if (this.trendingCache &&
        Date.now() - this.trendingCache.timestamp < this.TRENDING_CACHE_TTL) {
      return this.trendingCache.data.slice(0, limit);
    }

    // v5: trending is a PROVED prefix ranked page — groupBy at `hashtag` on
    // `like.byHashtagPost {at: hashtag}` (skipIfAbsent, so only tagged likes
    // exist in the index). NOTE the metric change: under v5 the count is
    // LIKES ON TAGGED POSTS per tag, not post-count — a ranking of tag
    // engagement rather than tag usage. It rides the TrendingHashtag shape
    // unchanged; consumers that print a unit label gate on
    // `prefixRankingsAvailable()`. Fail-soft: on any error (e.g. a pre-dev.7
    // node that cannot serve the prefix form yet) trending degrades to empty
    // rather than falling back to the unproven v4 derivation.
    if (prefixRankingsAvailable()) {
      try {
        const { topHashtagsByLikes } = await import('./ranked-likes');
        const ranked = await topHashtagsByLikes(limit);
        const trending: TrendingHashtag[] = ranked
          .filter((entry) => entry.count >= minPosts)
          .map((entry) => ({ hashtag: entry.key, postCount: entry.count }));
        this.trendingCache = { data: trending, timestamp: Date.now() };
        return trending.slice(0, limit);
      } catch (error) {
        logger.error('Error fetching proved trending hashtags:', error);
        return [];
      }
    }

    // v4: trending rode the postHashtag doctype, which no longer exists, and a
    // PROVED tag ranking is not servable (it would need prefix-level groupBy on
    // `like.byHashtagPost` — which only the v5 contract's at-form declares).
    // Trending is derived client-side from recent post activity: an unproven
    // sample, labeled as such in the UI.
    if (hashtagsAreInline()) {
      try {
        const trending = await this.deriveTrendingFromRecentPosts(minPosts);
        this.trendingCache = { data: trending, timestamp: Date.now() };
        return trending.slice(0, limit);
      } catch (error) {
        logger.error('Error deriving trending hashtags from recent posts:', error);
        return [];
      }
    }

    try {
      // Fetch recent hashtag documents
      const recentHashtags = await this.getRecentHashtags(timeWindowHours);

      // Group by hashtag and count
      const hashtagCounts = new Map<string, number>();
      for (const doc of recentHashtags) {
        const count = hashtagCounts.get(doc.hashtag) || 0;
        hashtagCounts.set(doc.hashtag, count + 1);
      }

      // Convert to array and filter by minimum posts
      const trending: TrendingHashtag[] = [];
      hashtagCounts.forEach((postCount, hashtag) => {
        if (postCount >= minPosts) {
          trending.push({ hashtag, postCount });
        }
      });

      // Sort by post count descending
      trending.sort((a, b) => b.postCount - a.postCount);

      // Cache the full result
      this.trendingCache = {
        data: trending,
        timestamp: Date.now()
      };

      return trending.slice(0, limit);
    } catch (error) {
      logger.error('Error calculating trending hashtags:', error);
      return [];
    }
  }

  /**
   * v4 trending, client-derived (D-R1a): sample the most recent ~200 posts off
   * the `languageTimeline` index and count their inline `hashtag` values.
   *
   * NOT a proved ranking — it is a recency-weighted activity signal, which is
   * why consumers label it "based on recent activity". Counting the indexed
   * `hashtag` property (rather than re-parsing content for inline tags) keeps
   * the numbers consistent with what a tag page can actually list: on v4 a post
   * is discoverable under exactly one tag via `post.tagAndTime`.
   *
   * Posts are scanned newest-first and JS sorts are stable, so among tags with
   * equal counts the most recently used one ranks first — a fresh tag surfaces
   * immediately instead of being buried under older ties.
   */
  private async deriveTrendingFromRecentPosts(minPosts: number): Promise<TrendingHashtag[]> {
    const { queryRawDocuments } = await import('./document-service');

    const SAMPLE_TARGET = 200;
    const PAGE_SIZE = 100;
    const counts = new Map<string, number>();
    let sampled = 0;
    let startAfter: string | undefined;

    while (sampled < SAMPLE_TARGET) {
      const documents = await queryRawDocuments({
        dataContractId: this.contractId,
        documentTypeName: 'post',
        where: [
          ['language', '==', 'en'],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['language', 'asc'], ['$createdAt', 'desc']],
        limit: PAGE_SIZE,
        startAfter,
      });

      for (const doc of documents) {
        const data = (doc.data || doc) as Record<string, unknown>;
        const tag = data.hashtag ?? doc.hashtag;
        // '' is the untagged stand-in, not a tag.
        if (typeof tag === 'string' && tag !== '') {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }

      sampled += documents.length;
      if (documents.length < PAGE_SIZE) break;

      const lastId = documents[documents.length - 1].$id;
      if (typeof lastId !== 'string' || lastId === '') break;
      startAfter = lastId;
    }

    const trending: TrendingHashtag[] = [];
    counts.forEach((postCount, hashtag) => {
      if (postCount >= minPosts) {
        trending.push({ hashtag, postCount });
      }
    });

    // Stable sort: ties keep newest-first encounter order.
    trending.sort((a, b) => b.postCount - a.postCount);
    return trending;
  }

  /**
   * Clear trending cache (call when new posts are created)
   */
  invalidateTrendingCache(): void {
    this.trendingCache = null;
  }

  /**
   * Normalize hashtag: lowercase, strip #, validate pattern
   */
  private normalizeHashtag(hashtag: string): string | null {
    if (!hashtag) return null;

    // Remove # prefix if present
    let normalized = hashtag.startsWith('#') ? hashtag.slice(1) : hashtag;

    // Convert to lowercase
    normalized = normalized.toLowerCase();

    // Validate pattern: ^[a-z0-9_]{1,63}$ (max 63 chars for indexed properties)
    if (!/^[a-z0-9_]{1,63}$/.test(normalized)) {
      return null;
    }

    return normalized;
  }
}

// Singleton instance
export const hashtagService = new HashtagService();
