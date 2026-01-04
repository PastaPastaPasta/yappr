import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { HASHTAG_CONTRACT_ID, YAPPR_CONTRACT_ID } from '../constants';

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
    super('postHashtag', HASHTAG_CONTRACT_ID);
  }

  /**
   * Transform document from SDK response to typed object
   */
  protected transformDocument(doc: any): PostHashtagDocument {
    const data = doc.data || doc;
    let postId = data.postId || doc.postId;
    let hashtag = data.hashtag || doc.hashtag;

    // Convert postId from bytes to base58 string if needed
    if (postId && typeof postId !== 'string') {
      try {
        const bytes = postId instanceof Uint8Array ? postId : new Uint8Array(postId);
        const bs58 = require('bs58');
        postId = bs58.encode(bytes);
      } catch (e) {
        console.warn('Failed to convert postId to base58:', e);
        postId = String(postId);
      }
    }

    return {
      $id: doc.$id || doc.id,
      $ownerId: doc.$ownerId || doc.ownerId,
      $createdAt: doc.$createdAt || doc.createdAt,
      postId,
      hashtag
    };
  }

  /**
   * Create a single hashtag document for a post
   */
  async createPostHashtag(postId: string, ownerId: string, hashtag: string): Promise<boolean> {
    // Validate and normalize hashtag
    const normalizedTag = this.normalizeHashtag(hashtag);
    if (!normalizedTag) {
      console.warn('Invalid hashtag:', hashtag);
      return false;
    }

    try {
      // Check if already exists (unique index on postId + hashtag)
      const existing = await this.getHashtagForPost(postId, normalizedTag);
      if (existing) {
        console.log('Hashtag already exists for post:', normalizedTag);
        return true;
      }

      // Convert postId to byte array
      const bs58Module = await import('bs58');
      const bs58 = bs58Module.default;
      const postIdBytes = Array.from(bs58.decode(postId));

      // Create document via state transition
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        {
          postId: postIdBytes,
          hashtag: normalizedTag
        }
      );

      // Invalidate trending cache when new hashtag is created
      this.trendingCache = null;

      return result.success;
    } catch (error) {
      console.error('Error creating hashtag:', error);
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
        contractId: this.contractId,
        type: this.documentType,
        where: [
          ['postId', '==', postId],
          ['hashtag', '==', normalizedTag]
        ],
        limit: 1
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

      return documents.length > 0 ? this.transformDocument(documents[0]) : null;
    } catch (error) {
      console.error('Error getting hashtag for post:', error);
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
        contractId: this.contractId,
        type: this.documentType,
        where: [
          ['postId', '==', postId],
          ['hashtag', '>', '']  // Range query to enable ordering
        ],
        orderBy: [['postId', 'asc'], ['hashtag', 'asc']],
        limit: 20
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

      return documents.map((doc: any) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting hashtags for post:', error);
      return [];
    }
  }

  /**
   * Get post IDs that have a specific hashtag
   * Returns postHashtag documents - caller should fetch actual posts and filter by ownership
   */
  async getPostIdsByHashtag(hashtag: string, options: QueryOptions = {}): Promise<PostHashtagDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const normalizedTag = this.normalizeHashtag(hashtag);

      if (!normalizedTag) return [];

      // Use hashtagAndTime index: [hashtag, $createdAt]
      const response = await sdk.documents.query({
        contractId: this.contractId,
        type: this.documentType,
        where: [
          ['hashtag', '==', normalizedTag],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']],
        limit: options.limit || 50
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

      return documents.map((doc: any) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting posts by hashtag:', error);
      return [];
    }
  }

  /**
   * Get recent hashtag documents for trending calculation
   */
  async getRecentHashtags(hours: number = 24): Promise<PostHashtagDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Calculate timestamp for X hours ago
      const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

      // Use ownerHashtags index: [$ownerId, $createdAt]
      // We need to query all documents created after cutoffTime
      // Unfortunately we can't query just by $createdAt without $ownerId in this index
      // So we use the timeline-style approach with a range
      const response = await sdk.documents.query({
        contractId: this.contractId,
        type: this.documentType,
        where: [
          ['$createdAt', '>', cutoffTime]
        ],
        orderBy: [['$createdAt', 'desc']],
        limit: 500 // Get enough for trending calculation
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

      return documents.map((doc: any) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting recent hashtags:', error);
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
      console.error('Error calculating trending hashtags:', error);
      return [];
    }
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
