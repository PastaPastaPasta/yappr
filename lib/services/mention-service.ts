import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierToBase58 } from './sdk-helpers';
import { MENTION_CONTRACT_ID } from '../constants';
import { dpnsService } from './dpns-service';
import { paginateFetchAll } from './pagination-utils';

export interface PostMentionDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
  mentionedUserId: string;
}

class MentionService extends BaseDocumentService<PostMentionDocument> {
  constructor() {
    super('postMention', MENTION_CONTRACT_ID);
  }

  /**
   * Transform document from SDK response to typed object
   * SDK v3: System fields ($id, $ownerId) are base58, byte array fields are base64
   */
  protected transformDocument(doc: any): PostMentionDocument {
    const data = doc.data || doc;
    const rawPostId = data.postId || doc.postId;
    const rawMentionedUserId = data.mentionedUserId || doc.mentionedUserId;

    // Convert byte array fields from base64 to base58
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    const mentionedUserId = rawMentionedUserId ? identifierToBase58(rawMentionedUserId) : '';

    if (rawPostId && !postId) {
      console.error('MentionService: Invalid postId format:', rawPostId);
    }
    if (rawMentionedUserId && !mentionedUserId) {
      console.error('MentionService: Invalid mentionedUserId format:', rawMentionedUserId);
    }

    return {
      $id: doc.$id,
      $ownerId: doc.$ownerId,
      $createdAt: doc.$createdAt,
      postId: postId || '',
      mentionedUserId: mentionedUserId || ''
    };
  }

  /**
   * Create a single mention document for a post
   */
  async createPostMention(postId: string, ownerId: string, mentionedUserId: string): Promise<boolean> {
    if (!mentionedUserId) {
      console.warn('MentionService: Invalid mentionedUserId');
      return false;
    }

    try {
      // Check if already exists (unique index on postId + mentionedUserId)
      const existing = await this.getMentionForPost(postId, mentionedUserId);
      if (existing) {
        console.log('Mention already exists for post:', mentionedUserId);
        return true;
      }

      // Convert IDs to byte arrays with defensive error handling
      const bs58Module = await import('bs58');
      const bs58 = bs58Module.default;

      let postIdBytes: number[];
      let mentionedUserIdBytes: number[];

      try {
        postIdBytes = Array.from(bs58.decode(postId));
      } catch (decodeError) {
        console.error('MentionService: Invalid base58 postId:', postId, decodeError);
        return false;
      }

      try {
        mentionedUserIdBytes = Array.from(bs58.decode(mentionedUserId));
      } catch (decodeError) {
        console.error('MentionService: Invalid base58 mentionedUserId:', mentionedUserId, decodeError);
        return false;
      }

      // Create document via state transition
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        {
          postId: postIdBytes,
          mentionedUserId: mentionedUserIdBytes
        }
      );

      return result.success;
    } catch (error) {
      console.error('Error creating mention:', error);
      return false;
    }
  }

  /**
   * Create multiple mention documents for a post from username list
   * Resolves usernames to identity IDs via DPNS
   */
  async createPostMentionsFromUsernames(
    postId: string,
    ownerId: string,
    usernames: string[]
  ): Promise<boolean[]> {
    const results: boolean[] = [];

    // Deduplicate usernames (case-insensitive)
    const uniqueUsernames = Array.from(new Set(
      usernames.map(u => u.toLowerCase())
    ));

    for (const username of uniqueUsernames) {
      try {
        // Resolve username to identity ID via DPNS
        const identityId = await dpnsService.resolveIdentity(username);
        if (!identityId) {
          console.warn('MentionService: Could not resolve username:', username);
          results.push(false);
          continue;
        }

        const result = await this.createPostMention(postId, ownerId, identityId);
        results.push(result);
      } catch (error) {
        console.error('Error creating mention for username:', username, error);
        results.push(false);
      }
    }

    return results;
  }

  /**
   * Get a specific mention document for a post
   */
  async getMentionForPost(postId: string, mentionedUserId: string): Promise<PostMentionDocument | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['postId', '==', postId],
          ['mentionedUserId', '==', mentionedUserId]
        ],
        limit: 1
      } as any);

      // Handle Map response (v3 SDK)
      let documents: any[];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if (response && (response as any).documents) {
        documents = (response as any).documents;
      } else if (response && typeof (response as any).toJSON === 'function') {
        const json = (response as any).toJSON();
        documents = Array.isArray(json) ? json : json.documents || [];
      } else {
        documents = [];
      }

      return documents.length > 0 ? this.transformDocument(documents[0]) : null;
    } catch (error) {
      console.error('Error getting mention for post:', error);
      return null;
    }
  }

  /**
   * Get all mentions for a specific post
   */
  async getMentionsForPost(postId: string): Promise<PostMentionDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['postId', '==', postId],
          ['mentionedUserId', '>', '']  // Range query to enable ordering
        ],
        orderBy: [['postId', 'asc'], ['mentionedUserId', 'asc']],
        limit: 100
      } as any);

      // Handle Map response (v3 SDK)
      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if (response && (response as any).documents) {
        documents = (response as any).documents;
      } else if (response && typeof (response as any).toJSON === 'function') {
        const json = (response as any).toJSON();
        documents = Array.isArray(json) ? json : json.documents || [];
      }

      return documents.map((doc: any) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting mentions for post:', error);
      return [];
    }
  }

  /**
   * Get posts that mention a specific user.
   * Paginates through all results to return complete list.
   * Returns mention documents - caller should fetch actual posts and filter by ownership.
   */
  async getPostsMentioningUser(userId: string, options: QueryOptions = {}): Promise<PostMentionDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [
            ['mentionedUserId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      console.error('Error getting posts mentioning user:', error);
      return [];
    }
  }

  /**
   * Count posts that mention a specific user
   */
  async countMentionsForUser(userId: string): Promise<number> {
    try {
      const mentions = await this.getPostsMentioningUser(userId);
      return mentions.length;
    } catch (error) {
      console.error('Error counting mentions for user:', error);
      return 0;
    }
  }
}

// Singleton instance
export const mentionService = new MentionService();
