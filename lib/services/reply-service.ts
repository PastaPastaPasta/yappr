import { logger } from '@/lib/logger';
import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Reply, PostQueryOptions } from '../types';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { identifierToBase58, normalizeSDKResponse, RequestDeduplicator, stringToIdentifierBytes, normalizeBytes, createDefaultUser } from './sdk-helpers';
import type { EncryptionOptions } from './post-service';

export interface ReplyDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  content: string;
  mediaUrl?: string;
  parentId: string;
  parentOwnerId: string;
  sensitive?: boolean;
  // Private feed fields
  encryptedContent?: Uint8Array;
  epoch?: number;
  nonce?: Uint8Array;
}

/**
 * Encryption source result for replies to private posts
 */
export interface EncryptionSource {
  ownerId: string;     // The feed owner whose CEK should be used
  epoch: number;       // The epoch at which the root private post was created
  inherited: boolean;  // True if encryption is inherited from parent
}

class ReplyService extends BaseDocumentService<Reply> {
  // Request deduplicators for batch operations
  private repliesDeduplicator = new RequestDeduplicator<string, Map<string, number>>();

  constructor() {
    super('reply');
  }

  /**
   * Transform document to Reply type.
   * Returns a Reply with default placeholder values - callers should use
   * enrichRepliesBatch() to populate stats and author data.
   */
  protected transformDocument(doc: Record<string, unknown>): Reply {
    // SDK may nest document fields under 'data' property
    const data = (doc.data || doc) as Record<string, unknown>;

    // Handle both $ prefixed (query responses) and non-prefixed (creation responses) fields
    const id = (doc.$id || doc.id) as string;
    const ownerId = (doc.$ownerId || doc.ownerId) as string;
    const createdAt = (doc.$createdAt || doc.createdAt) as number;

    // Content and other fields may be in data or at root level
    const content = (data.content || doc.content || '') as string;
    const mediaUrl = (data.mediaUrl || doc.mediaUrl) as string | undefined;

    // Convert parentId from base64 to base58 for consistent storage
    const rawParentId = data.parentId || doc.parentId;
    const parentId = rawParentId ? identifierToBase58(rawParentId) || '' : '';

    // Convert parentOwnerId from base64 to base58 for consistent storage
    const rawParentOwnerId = data.parentOwnerId || doc.parentOwnerId;
    const parentOwnerId = rawParentOwnerId ? identifierToBase58(rawParentOwnerId) || '' : '';

    // Extract private feed fields if present
    const rawEncryptedContent = data.encryptedContent || doc.encryptedContent;
    const epoch = (data.epoch ?? doc.epoch) as number | undefined;
    const rawNonce = data.nonce || doc.nonce;

    // Normalize byte arrays
    const encryptedContent = rawEncryptedContent ? normalizeBytes(rawEncryptedContent) ?? undefined : undefined;
    const nonce = rawNonce ? normalizeBytes(rawNonce) ?? undefined : undefined;

    const reply: Reply = {
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
      parentId,
      parentOwnerId,
      // Private feed fields
      encryptedContent,
      epoch,
      nonce,
    };

    return reply;
  }


  /**
   * Delete a reply by its ID.
   * Only the reply owner can delete their own replies.
   */
  async deleteReply(replyId: string, ownerId: string): Promise<boolean> {
    try {
      const { stateTransitionService } = await import('./state-transition-service');

      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        replyId,
        ownerId
      );

      return result.success;
    } catch (error) {
      logger.error('Error deleting reply:', error);
      return false;
    }
  }

  /**
   * Create a reply to a post or another reply
   *
   * @param ownerId - Identity ID of the reply author
   * @param content - Reply content
   * @param parentId - ID of post or reply being replied to
   * @param parentOwnerId - Identity ID of the parent owner
   * @param options - Optional fields including encryption for private replies
   */
  async createReply(
    ownerId: string,
    content: string,
    parentId: string,
    parentOwnerId: string,
    options: {
      mediaUrl?: string;
      sensitive?: boolean;
      encryption?: EncryptionOptions;
    } = {}
  ): Promise<Reply> {
    const PRIVATE_REPLY_PLACEHOLDER = '🔒';
    const data: Record<string, unknown> = {
      parentId: stringToIdentifierBytes(parentId),
      parentOwnerId: stringToIdentifierBytes(parentOwnerId),
    };

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

      data.encryptedContent = encryptionResult.data.encryptedContent;
      data.epoch = encryptionResult.data.epoch;
      data.nonce = encryptionResult.data.nonce;
      data.content = encryptionResult.data.teaser || PRIVATE_REPLY_PLACEHOLDER;
    } else {
      data.content = content;
    }

    if (options.mediaUrl) data.mediaUrl = options.mediaUrl;
    if (options.sensitive !== undefined) data.sensitive = options.sensitive;

    return this.create(ownerId, data);
  }

  /**
   * Get replies to a post or reply.
   * Uses the parentAndTime index: [parentId, $createdAt]
   *
   * @param parentId - The parent post/reply ID
   * @param options - Query options
   */
  async getReplies(parentId: string, options: QueryOptions & PostQueryOptions = {}): Promise<DocumentResult<Reply>> {
    const { skipEnrichment, ...queryOpts } = options;

    const queryOptions: QueryOptions = {
      where: [
        ['parentId', '==', parentId],
        ['$createdAt', '>', 0]
      ],
      orderBy: [['parentId', 'asc'], ['$createdAt', 'asc']],
      limit: 20,
      ...queryOpts
    };

    const result = await this.query(queryOptions);

    // Resolve authors if not skipping enrichment
    if (!skipEnrichment) {
      await this.resolveAuthors(result.documents);
    }

    return result;
  }

  /**
   * Get user's replies for profile page.
   * Uses the ownerAndTime index: [$ownerId, $createdAt]
   *
   * @param userId - Identity ID of the user
   * @param options - Query options
   */
  async getUserReplies(userId: string, options: QueryOptions & PostQueryOptions = {}): Promise<DocumentResult<Reply>> {
    const { skipEnrichment, ...queryOpts } = options;

    const queryOptions: QueryOptions = {
      where: [
        ['$ownerId', '==', userId],
        ['$createdAt', '>', 0]
      ],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: 20,
      ...queryOpts
    };

    const result = await this.query(queryOptions);

    if (!skipEnrichment) {
      await this.resolveAuthors(result.documents);
    }

    return result;
  }

  /**
   * Get replies where user's content was replied to - for notifications.
   * Uses the parentOwnerAndTime index: [parentOwnerId, $createdAt]
   * Limited to 100 most recent replies for notification purposes.
   *
   * @param userId - Identity ID of the content owner
   * @param since - Only return replies created after this timestamp (optional)
   */
  async getRepliesToMyContent(userId: string, since?: Date): Promise<Reply[]> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const sinceTimestamp = since?.getTime() || 0;

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'reply',
        where: [
          ['parentOwnerId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['parentOwnerId', 'asc'], ['$createdAt', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      logger.error('Error getting replies to my content:', error);
      return [];
    }
  }

  /**
   * Get nested replies for multiple parent posts/replies.
   * Returns a Map of parentId -> replies array.
   * Used for building 2-level threaded reply trees.
   */
  async getNestedReplies(
    parentIds: string[],
    options: PostQueryOptions = {}
  ): Promise<Map<string, Reply[]>> {
    if (parentIds.length === 0) {
      return new Map();
    }

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'reply',
        where: [['parentId', 'in', parentIds]],
        orderBy: [['parentId', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);

      // Initialize result map
      const result = new Map<string, Reply[]>();
      parentIds.forEach(id => result.set(id, []));

      // Transform documents and group by parent
      for (const doc of documents) {
        const reply = this.transformDocument(doc);
        const parentId = reply.parentId;
        if (parentId) {
          const parentReplies = result.get(parentId);
          if (parentReplies) {
            parentReplies.push(reply);
          }
        }
      }

      // Sort replies by createdAt ascending within each parent
      result.forEach((replies) => {
        replies.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      });

      // Resolve authors if not skipping enrichment
      if (!options.skipEnrichment) {
        const allReplies = Array.from(result.values()).flat();
        await this.resolveAuthors(allReplies);
      }

      return result;
    } catch (error) {
      logger.error('Error getting nested replies:', error);
      const result = new Map<string, Reply[]>();
      parentIds.forEach(id => result.set(id, []));
      return result;
    }
  }

  /**
   * Count replies to a post/reply
   */
  async countReplies(parentId: string): Promise<number> {
    try {
      const result = await this.query({
        where: [
          ['parentId', '==', parentId],
          ['$createdAt', '>', 0]
        ],
        orderBy: [['parentId', 'asc'], ['$createdAt', 'asc']],
        limit: 100
      });
      return result.documents.length;
    } catch {
      return 0;
    }
  }

  /**
   * Batch count replies for multiple posts.
   * Deduplicates in-flight requests.
   */
  async countRepliesByParentIds(parentIds: string[]): Promise<Map<string, number>> {
    if (parentIds.length === 0) {
      return new Map<string, number>();
    }

    const cacheKey = RequestDeduplicator.createBatchKey(parentIds);
    return this.repliesDeduplicator.dedupe(cacheKey, () => this.fetchRepliesByParentIds(parentIds));
  }

  /** Internal: Actually fetch reply counts */
  private async fetchRepliesByParentIds(parentIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    parentIds.forEach(id => result.set(id, 0));

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'reply',
        where: [['parentId', 'in', parentIds]],
        orderBy: [['parentId', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);

      // Count replies per parent
      for (const doc of documents) {
        const data = (doc.data || doc) as Record<string, unknown>;
        const rawParentId = data.parentId || doc.parentId;
        const parentId = rawParentId ? identifierToBase58(rawParentId) : null;

        if (parentId && result.has(parentId)) {
          result.set(parentId, (result.get(parentId) || 0) + 1);
        }
      }
    } catch (error) {
      logger.error('Error getting replies batch:', error);
    }

    return result;
  }

  /**
   * Get reply by ID
   */
  async getReplyById(replyId: string, options: PostQueryOptions = {}): Promise<Reply | null> {
    try {
      const reply = await this.get(replyId);
      if (!reply) return null;

      if (!options.skipEnrichment) {
        await this.resolveAuthors([reply]);
      }

      return reply;
    } catch (error) {
      logger.error('Error getting reply by ID:', error);
      return null;
    }
  }

  /**
   * Get multiple replies by IDs
   */
  async getRepliesByIds(replyIds: string[]): Promise<Reply[]> {
    if (replyIds.length === 0) return [];

    try {
      const BATCH_SIZE = 5;
      const replies: Reply[] = [];

      for (let i = 0; i < replyIds.length; i += BATCH_SIZE) {
        const batch = replyIds.slice(i, i + BATCH_SIZE);
        const batchReplies = await Promise.all(
          batch.map(id => this.getReplyById(id))
        );
        replies.push(...batchReplies.filter((r): r is Reply => r !== null));
      }

      return replies;
    } catch (error) {
      logger.error('Error getting replies by IDs:', error);
      return [];
    }
  }

  /**
   * Resolve and set authors for replies
   */
  private async resolveAuthors(replies: Reply[]): Promise<void> {
    const authorIds = Array.from(new Set(replies.map(r => r.author.id).filter(Boolean)));
    if (authorIds.length === 0) return;

    try {
      const [usernameMap, profiles, avatarUrls] = await Promise.all([
        dpnsService.resolveUsernamesBatch(authorIds),
        unifiedProfileService.getProfilesByIdentityIds(authorIds),
        unifiedProfileService.getAvatarUrlsBatch(authorIds)
      ]);

      const profileMap = new Map<string, Record<string, unknown>>();
      profiles.forEach((profile) => {
        const profileRec = profile as unknown as Record<string, unknown>;
        if (profileRec.$ownerId) {
          profileMap.set(profileRec.$ownerId as string, profileRec);
        }
      });

      for (const reply of replies) {
        const username = usernameMap.get(reply.author.id);
        const profile = profileMap.get(reply.author.id);
        const profileData = (profile?.data || profile) as Record<string, unknown> | undefined;
        const avatarUrl = avatarUrls.get(reply.author.id);

        reply.author = {
          ...reply.author,
          username: username || reply.author.username,
          displayName: (profileData?.displayName as string) || reply.author.displayName,
          avatar: avatarUrl || reply.author.avatar,
          hasDpns: Boolean(username)
        };
      }
    } catch (error) {
      logger.error('Error resolving reply authors:', error);
    }
  }
}

/**
 * Get the encryption source for a reply (PRD §5.5).
 *
 * Walks up the reply chain to find the root private post:
 * - If the parent is a private post, use that post author's CEK
 * - If the parent is public or if the parent's parent is private, recurse
 * - Returns null if this is a reply to a public thread
 *
 * This enables replies to private posts to inherit the same encryption,
 * so anyone who can see the parent can also see replies.
 */
export async function getEncryptionSource(
  parentId: string,
  depth: number = 0
): Promise<EncryptionSource | null> {
  const MAX_DEPTH = 100;
  if (depth >= MAX_DEPTH) {
    logger.warn('getEncryptionSource: Max recursion depth reached, possible circular reference');
    return null;
  }

  try {
    // First try to get the parent as a post
    const { postService } = await import('./post-service');
    const parentPost = await postService.getPostById(parentId, { skipEnrichment: true });

    if (parentPost) {
      // Check if parent post is encrypted
      if (parentPost.encryptedContent && parentPost.epoch !== undefined && parentPost.nonce) {
        // This is the root private post - use its encryption
        return {
          ownerId: parentPost.author.id,
          epoch: parentPost.epoch,
          inherited: true
        };
      }
      // Parent post is public - no inherited encryption
      return null;
    }

    // If not a post, try as a reply
    const parentReply = await replyService.getReplyById(parentId, { skipEnrichment: true });

    if (!parentReply) {
      logger.warn('Parent not found:', parentId);
      return null;
    }

    // Check if parent reply is encrypted
    if (parentReply.encryptedContent && parentReply.epoch !== undefined && parentReply.nonce) {
      // This reply is encrypted - recurse to find the root
      const rootSource = await getEncryptionSource(parentReply.parentId, depth + 1);
      if (rootSource) {
        return rootSource;
      }
      // No root found - use this reply's author as encryption source
      return {
        ownerId: parentReply.author.id,
        epoch: parentReply.epoch,
        inherited: true
      };
    }

    // Parent reply is not encrypted - no inherited encryption
    return null;
  } catch (error) {
    logger.error('Error getting encryption source:', error);
    return null;
  }
}

// Singleton instance
export const replyService = new ReplyService();
