import { logger } from '@/lib/logger';
import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { Reply, PostQueryOptions } from '../../types';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { identifierToBase58, normalizeSDKResponse, identifierStringToDocumentBytes, normalizeBytes, createDefaultUser } from './sdk-helpers';
import type { EncryptionOptions } from './post-service';
import { getEvoSdk } from './evo-sdk-service';
import { normalizeMediaUrl } from '@/lib/utils/ipfs-gateway';
import { documentCount, groupedDocumentCount } from './pagination-utils';
import { tombstoneDocument } from './tombstone-helpers';
import {
  hasFlatThreads,
  replyCountFieldFor,
  replyLinkage,
  threadRootIdOf,
  type TargetKind,
} from '../contract-topology';

export interface ReplyDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  content: string;
  mediaUrl?: string;
  /** v2 only — the polymorphic direct parent. */
  parentId?: string;
  /** v3 only — the post the whole thread hangs off. */
  rootPostId?: string;
  /** v3 only — the reply this one is nested under. */
  replyToReplyId?: string;
  parentOwnerId: string;
  sensitive?: boolean;
  deleted?: boolean;
  // Private feed fields
  encryptedContent?: Uint8Array;
  epoch?: number;
  nonce?: Uint8Array;
}

/**
 * Replies per page in a thread view. v2 keeps its historical 20 (one level of a
 * tree); on v3 one query covers the whole thread, so the page is larger.
 */
function replyPageSize(): number {
  return hasFlatThreads() ? 50 : 20;
}

/** Where a new reply hangs, in the terms the configured topology uses. */
export interface ReplyTarget {
  /** The post at the root of the thread. On v2 this is the direct parent. */
  rootPostId: string;
  /** Set when replying to a reply rather than to the root post (v3 only). */
  replyToReplyId?: string;
  /** Owner of the DIRECT target — what notification queries key on. */
  parentOwnerId: string;
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

    // Parent linkage, in whichever fields this topology declares. On v3 the
    // thread root and the presentational parent are separate properties, and
    // `parentId` is derived as "the thing this reply is a direct answer to" so
    // every pre-topology consumer of it keeps working.
    const { root: rootField, replyToReply: replyToReplyField } = replyLinkage();
    const toBase58 = (value: unknown): string | undefined => {
      if (!value) return undefined;
      return identifierToBase58(value) || undefined;
    };
    const rootPostId = replyToReplyField ? toBase58(data[rootField] ?? doc[rootField]) : undefined;
    const replyToReplyId = replyToReplyField
      ? toBase58(data[replyToReplyField] ?? doc[replyToReplyField])
      : undefined;
    const parentId = replyToReplyField
      ? (replyToReplyId ?? rootPostId ?? '')
      : toBase58(data.parentId ?? doc.parentId) ?? '';

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
        url: normalizeMediaUrl(mediaUrl)
      }] : undefined,
      parentId,
      parentOwnerId,
      rootPostId,
      replyToReplyId,
      deleted: (data.deleted ?? doc.deleted) === true ? true : undefined,
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
   * Blank a reply in place, leaving a tombstone.
   *
   * The v3 `reply` doctype is `canBeDeleted: false`, so this is what "delete"
   * means there. Content, media and every encrypted field are dropped; the parent
   * linkage survives, INCLUDING the optional `replyToReplyId` — a tombstone is
   * still rendered in the thread, so losing its nesting would move it (and every
   * live reply under it) to the top of the thread.
   */
  async tombstoneReply(replyId: string, ownerId: string): Promise<boolean> {
    const ok = await tombstoneDocument({
      contractId: this.contractId,
      documentType: this.documentType,
      documentId: replyId,
      ownerId,
      preserveIdentifiers: ['rootPostId', 'replyToReplyId', 'parentOwnerId'],
    });
    // Mirror tombstonePost: drop the cached pre-tombstone document.
    if (ok) this.cache.delete(replyId);
    return ok;
  }

  /**
   * Create a reply to a post or another reply
   *
   * @param ownerId - Identity ID of the reply author
   * @param content - Reply content
   * @param target - Where the reply hangs (thread root, optional nested parent, direct target's owner)
   * @param options - Optional fields including encryption for private replies
   */
  async createReply(
    ownerId: string,
    content: string,
    target: ReplyTarget,
    options: {
      mediaUrl?: string;
      sensitive?: boolean;
      encryption?: EncryptionOptions;
    } = {}
  ): Promise<Reply> {
    const PRIVATE_REPLY_PLACEHOLDER = '🔒';
    const { root: rootField, replyToReply: replyToReplyField } = replyLinkage();
    const data: Record<string, unknown> = {
      // On v2 the single `parentId` names the DIRECT parent, which is
      // `replyToReplyId` when there is one and the root post otherwise — so both
      // topologies get the reference they can actually resolve.
      [rootField]: identifierStringToDocumentBytes(
        replyToReplyField ? target.rootPostId : target.replyToReplyId ?? target.rootPostId
      ),
      parentOwnerId: identifierStringToDocumentBytes(target.parentOwnerId),
    };
    if (replyToReplyField && target.replyToReplyId) {
      data[replyToReplyField] = identifierStringToDocumentBytes(target.replyToReplyId);
    }

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

    if (options.mediaUrl && options.encryption) {
      // A plaintext mediaUrl on an encrypted reply would leak the private media
      // reference; callers must keep it inside the encrypted content instead.
      throw new Error('mediaUrl cannot be combined with encryption');
    }
    if (options.mediaUrl) data.mediaUrl = options.mediaUrl;
    if (options.sensitive !== undefined) data.sensitive = options.sensitive;

    return this.create(ownerId, data);
  }

  /**
   * Get a thread's replies.
   *
   * On v2 this is one level of the tree: the direct replies to `rootPostId`, via
   * `parentAndTime [parentId, $createdAt]`. On v3 it is the WHOLE thread in one
   * query, via `rootAndTime [rootPostId, $createdAt]` — nesting is reconstructed
   * client-side from `replyToReplyId`.
   *
   * The page size is a real page, not a cap: `nextCursor` is returned whenever a
   * full page came back, and callers page on with `startAfter` (see
   * `usePostDetail`'s Load More) instead of silently truncating a busy thread the
   * way the old hardcoded `limit: 20` did.
   *
   * @param rootPostId - The thread root (v3) or the direct parent (v2)
   * @param options - Query options
   */
  async getReplies(rootPostId: string, options: QueryOptions & PostQueryOptions = {}): Promise<DocumentResult<Reply>> {
    const { skipEnrichment, ...queryOpts } = options;
    const rootField = replyLinkage().root;

    const queryOptions: QueryOptions = {
      where: [
        [rootField, '==', rootPostId],
        ['$createdAt', '>', 0]
      ],
      orderBy: [[rootField, 'asc'], ['$createdAt', 'asc']],
      limit: replyPageSize(),
      ...queryOpts
    };

    const result = await this.query(queryOptions);

    // Resolve authors if not skipping enrichment
    if (!skipEnrichment) {
      await this.resolveAuthors(result.documents);
    }

    // A full page means there may be more. Document ids double as the SDK's
    // startAfter cursor, and a reply's id IS its document id.
    const limit = queryOptions.limit ?? replyPageSize();
    const nextCursor = result.documents.length >= limit
      ? result.documents[result.documents.length - 1]?.id
      : undefined;

    return { ...result, nextCursor };
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
   *
   * Only the v2 path needs this: on v3 `getReplies` already returns the whole
   * thread in one query and nesting is a client-side grouping.
   */
  async getNestedReplies(
    parentIds: string[],
    options: PostQueryOptions = {}
  ): Promise<Map<string, Reply[]>> {
    if (parentIds.length === 0) {
      return new Map();
    }

    // The nesting link is `replyToReplyId` where the topology has one, and the
    // double-duty `parentId` otherwise.
    const { root, replyToReply } = replyLinkage();
    const nestingField = replyToReply ?? root;

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'reply',
        where: [[nestingField, 'in', parentIds]],
        orderBy: [[nestingField, 'asc']],
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
   * Count replies to a post/reply.
   *
   * The count tree used depends on the target kind, because on v3 "replies to a
   * post" means the whole thread (`byRoot`) while "replies to a reply" means its
   * direct children (`byReplyToReply`). On v2 both resolve to `byParent`, so this
   * stays the single polymorphic query it has always been.
   */
  async countReplies(parentId: string, kind: TargetKind = 'post'): Promise<number> {
    try {
      const sdk = await getEvoSdk();
      return await documentCount(sdk, {
        dataContractId: this.contractId,
        documentTypeName: 'reply',
        where: [[replyCountFieldFor(kind), '==', parentId]],
      });
    } catch {
      return 0;
    }
  }

  /** Reply counts for multiple targets via one grouped count-tree query (falls back to per-target reads). */
  async countRepliesForPosts(parentIds: string[], kind: TargetKind = 'post'): Promise<Map<string, number>> {
    const sdk = await getEvoSdk();
    return groupedDocumentCount(
      sdk,
      { dataContractId: this.contractId, documentTypeName: 'reply', groupField: replyCountFieldFor(kind) },
      parentIds,
      (id) => this.countReplies(id, kind)
    );
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
 * Get the encryption source a reply to `target` must inherit (PRD §5.5).
 *
 * A thread's encryption belongs to the ROOT post's author: anyone who can read
 * the root can read every reply under it. Where a reply names its root directly
 * (v3) that is one lookup. On v2 the only link is the polymorphic direct parent,
 * so the chain has to be walked — which is what `walkEncryptionSource` below does.
 */
export async function getEncryptionSource(
  target: { id: string; targetKind?: TargetKind; parentId?: string; rootPostId?: string }
): Promise<EncryptionSource | null> {
  if (!hasFlatThreads()) {
    return walkEncryptionSource(target.id);
  }

  try {
    const { postService } = await import('./post-service');
    const rootPost = await postService.getPostById(threadRootIdOf(target), { skipEnrichment: true });
    if (!rootPost?.encryptedContent || rootPost.epoch === undefined || !rootPost.nonce) {
      return null;
    }
    return { ownerId: rootPost.author.id, epoch: rootPost.epoch, inherited: true };
  } catch (error) {
    logger.error('Error getting encryption source:', error);
    return null;
  }
}

/** v2 only: walk the polymorphic parent chain looking for the root private post. */
async function walkEncryptionSource(
  parentId: string,
  depth: number = 0
): Promise<EncryptionSource | null> {
  const MAX_DEPTH = 100;
  if (depth >= MAX_DEPTH) {
    logger.warn('walkEncryptionSource: Max recursion depth reached, possible circular reference');
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
      const rootSource = await walkEncryptionSource(parentReply.parentId, depth + 1);
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
