import { logger } from '@/lib/logger';
import { BaseDocumentService, QueryOptions, DocumentResult, queryRawDocuments } from './document-service';
import { Reply, PostQueryOptions } from '../../types';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { identifierToBase58, normalizeSDKResponse, identifierStringToDocumentBytes, normalizeBytes, createDefaultUser } from './sdk-helpers';
import type { EncryptionOptions } from './post-service';
import { getEvoSdk } from './evo-sdk-service';
import { mediaDocumentFields, mediaFromDocument, type MediaItemInput } from '@/lib/media/media-fields';
import { documentCount, groupedDocumentCount, groupIdsByRoot, mapLimit } from './pagination-utils';
import type { DocumentWhereClause } from './sdk-helpers';
import { profileDataByOwnerId } from './post-enrichment-helpers';
import { tombstoneDocument } from './tombstone-helpers';
import { readNotificationWindow } from './notification-windows';
import {
  deletesAreTombstones,
  hasFlatThreads,
  mentionsAreInline,
  notificationWindowFor,
  privateFeedKeyFields,
  replyCountFieldFor,
  replyCountNeedsRoot,
  replyLinkage,
  replyOwnersProblem,
  replyOwnersAreDerived,
  repliesNameRootOwner,
  threadRootIdOf,
  tombstonePreservationFor,
  type TargetKind,
} from '../contract-topology';

/**
 * Replies per page in a thread view. v2 keeps its historical 20 (one level of a
 * tree); on v9 one query covers the whole thread, so the page is larger.
 */
function replyPageSize(): number {
  return hasFlatThreads() ? 50 : 20;
}

/** Where a new reply hangs, in the terms the configured topology uses. */
export interface ReplyTarget {
  /** The post at the root of the thread. On v2 this is the direct parent. */
  rootPostId: string;
  /** Set when replying to a reply rather than to the root post (v9 only). */
  replyToReplyId?: string;
  /**
   * Owner of the DIRECT target — what notification queries key on. Not
   * written on v14, where consensus reads it off the parent itself
   * ({@link replyOwnersAreDerived}).
   */
  parentOwnerId: string;
  /**
   * v13: the root post's owner, written as `rootOwnerId`. Consensus binds it
   * to the root (40127), and a top-level reply's `parentOwnerId` must equal
   * it (`parentIsRoot`); see {@link replyOwnersProblem}.
   */
  rootOwnerId?: string;
}

/**
 * Encryption source result for replies to private posts
 */
export interface EncryptionSource {
  ownerId: string;        // The feed owner whose CEK should be used
  keyGeneration: number;  // The key generation at which the root private post was created
  inherited: boolean;     // True if encryption is inherited from parent
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

    // Parent linkage, in whichever fields this topology declares. On v9 the
    // thread root and the presentational parent are separate properties, and
    // `parentId` is derived as "the thing this reply is a direct answer to" so
    // every pre-topology consumer of it keeps working.
    const { root: rootField, replyToReply: replyToReplyField } = replyLinkage();
    const toBase58 = (value: unknown): string | undefined => {
      if (!value) return undefined;
      return identifierToBase58(value) || undefined;
    };
    const rootPostId = replyToReplyField ? toBase58(data[rootField] ?? doc[rootField]) : undefined;
    const rootOwnerId = toBase58(data.rootOwnerId ?? doc.rootOwnerId);
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
    const { generation } = privateFeedKeyFields();
    const keyGeneration = (data[generation] ?? doc[generation]) as number | undefined;
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
      media: mediaFromDocument(id, data, doc),
      parentId,
      parentOwnerId,
      rootPostId,
      rootOwnerId,
      replyToReplyId,
      deleted: (data.deleted ?? doc.deleted) === true ? true : undefined,
      sensitive: (data.sensitive ?? doc.sensitive) === true ? true : undefined,
      // Private feed fields
      encryptedContent,
      keyGeneration,
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
   * The v9 `reply` doctype is `canBeDeleted: false`, so this is what "delete"
   * means there. Content, media and every encrypted field are dropped; the parent
   * linkage survives, INCLUDING the optional `replyToReplyId` — a tombstone is
   * still rendered in the thread, so losing its nesting would move it (and every
   * live reply under it) to the top of the thread.
   */
  async tombstoneReply(replyId: string, ownerId: string): Promise<boolean> {
    // The preserved set is exactly the doctype's `immutable` list.
    const ok = await tombstoneDocument({
      contractId: this.contractId,
      documentType: this.documentType,
      documentId: replyId,
      ownerId,
      preserve: tombstonePreservationFor('reply'),
    });
    // Mirror tombstonePost: drop the cached pre-tombstone document.
    if (ok) this.cache.delete(replyId);
    return ok;
  }

  /**
   * The author's delete, whatever it means on this topology: a tombstone where
   * replies are permanent ({@link deletesAreTombstones}: v9, v11, v12), a
   * document delete elsewhere. Throws the refusal of a banned or suspended
   * author's tombstone (41107/41108, v9/v11 only, {@link tombstoneDocument});
   * false for any other failure.
   */
  async deleteOwnReply(replyId: string, ownerId: string): Promise<boolean> {
    return deletesAreTombstones() ? this.tombstoneReply(replyId, ownerId) : this.deleteReply(replyId, ownerId);
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
      /** Stored URLs, with their hashes from v10 on (see `mediaDocumentFields`). One item before v13, up to four on v13. */
      media?: MediaItemInput[];
      sensitive?: boolean;
      encryption?: EncryptionOptions;
    } = {}
  ): Promise<Reply> {
    const PRIVATE_REPLY_PLACEHOLDER = '🔒';
    const ownersProblem = replyOwnersProblem(target);
    if (ownersProblem) throw new Error(ownersProblem);
    const { root: rootField, replyToReply: replyToReplyField } = replyLinkage();
    const data: Record<string, unknown> = {
      // On v2 the single `parentId` names the DIRECT parent, which is
      // `replyToReplyId` when there is one and the root post otherwise — so both
      // topologies get the reference they can actually resolve.
      [rootField]: identifierStringToDocumentBytes(
        replyToReplyField ? target.rootPostId : target.replyToReplyId ?? target.rootPostId
      ),
    };
    // v14 stores no owner: its windows read them off the root and the parent.
    if (!replyOwnersAreDerived()) data.parentOwnerId = identifierStringToDocumentBytes(target.parentOwnerId);
    if (replyToReplyField && target.replyToReplyId) {
      data[replyToReplyField] = identifierStringToDocumentBytes(target.replyToReplyId);
    }
    if (repliesNameRootOwner() && target.rootOwnerId) {
      data.rootOwnerId = identifierStringToDocumentBytes(target.rootOwnerId);
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
          options.encryption.source,
          ownerId,
          options.encryption.encryptionPrivateKey
        );
      } else {
        throw new Error('Invalid encryption options: inherited type requires source');
      }

      if (!encryptionResult.success) {
        throw new Error(encryptionResult.error);
      }

      data.encryptedContent = encryptionResult.data.encryptedContent;
      data[privateFeedKeyFields().generation] = encryptionResult.data.keyGeneration;
      data.nonce = encryptionResult.data.nonce;
      data.content = encryptionResult.data.teaser || PRIVATE_REPLY_PLACEHOLDER;
    } else {
      data.content = content;
    }

    if (options.media?.length && options.encryption) {
      // A plaintext media URL on an encrypted reply would leak the private media
      // reference; callers must keep it inside the encrypted content instead.
      throw new Error('Media URLs cannot be combined with encryption');
    }
    Object.assign(data, mediaDocumentFields(options.media));
    if (options.sensitive !== undefined) data.sensitive = options.sensitive;

    // v10: the one indexed mention, by the rule posts use — the first
    // @mention of the PUBLIC content (a private reply's teaser or placeholder,
    // never its ciphertext), resolved through DPNS; omitted when there is none
    // or it does not resolve.
    if (mentionsAreInline()) {
      const { resolveMentionedIdentity } = await import('./post-service');
      const mentionedUserId = await resolveMentionedIdentity(data.content as string);
      if (mentionedUserId) data.mentionedUserId = identifierStringToDocumentBytes(mentionedUserId);
    }

    return this.create(ownerId, data);
  }

  /**
   * Get a thread's replies.
   *
   * On v2 this is one level of the tree: the direct replies to `rootPostId`, via
   * `parentAndTime [parentId, $createdAt]`. On v9 it is the WHOLE thread in one
   * query, via `rootAndTime [rootPostId, $createdAt]`, oldest first across
   * every branch — nesting is reconstructed client-side from `replyToReplyId`.
   *
   * On v10 it is still the whole thread, but read off `repliesOf [rootPostId,
   * replyToReplyId, $createdAt]` as `rootPostId ==` ordered by
   * `[replyToReplyId, $createdAt]`: grouped by parent, not by time. The direct
   * replies (the null `replyToReplyId` branch) come first, oldest first; then
   * each reply's children, parent by parent in identifier order, oldest first
   * within a parent. A later page can therefore hold children of any branch
   * rather than the next-oldest replies of the thread.
   *
   * The page size is a real page, not a cap: `nextCursor` is returned whenever a
   * full page came back, and callers page on with `startAfter` (see
   * `usePostDetail`'s Load More) instead of silently truncating a busy thread the
   * way the old hardcoded `limit: 20` did.
   *
   * @param rootPostId - The thread root (v9) or the direct parent (v2)
   * @param options - Query options
   */
  async getReplies(rootPostId: string, options: QueryOptions & PostQueryOptions = {}): Promise<DocumentResult<Reply>> {
    const { skipEnrichment, ...queryOpts } = options;
    const { root: rootField, replyToReply, nestedUnderRoot } = replyLinkage();

    const queryOptions: QueryOptions = nestedUnderRoot && replyToReply
      ? {
        where: [[rootField, '==', rootPostId]],
        orderBy: [[replyToReply, 'asc'], ['$createdAt', 'asc']],
        limit: replyPageSize(),
        ...queryOpts
      }
      : {
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

    const nextCursor = result.documents.length >= (queryOptions.limit ?? 20)
      ? result.documents[result.documents.length - 1]?.id
      : undefined;
    return { ...result, nextCursor };
  }

  /**
   * Get replies where user's content was replied to - for notifications.
   * Uses the parentOwnerAndTime index: [parentOwnerId, $createdAt], limited
   * to the 100 most recent replies. On v10 it is the two open
   * `parentOwnerRecent [$createdAt, parentOwnerId]` windows, read whole (paged)
   * and since-filtered client-side (see readNotificationWindow).
   *
   * On v14 a reply names no owner, so the answer is two sources
   * ({@link repliesToMeOnV14}): the nested replies to the user's replies, and
   * the top-level replies of the user's threads.
   *
   * Rejects when the read fails: an empty answer would let the notification
   * watermark move past the replies it missed.
   *
   * @param userId - Identity ID of the content owner
   * @param since - Only return replies created after this timestamp (optional)
   */
  async getRepliesToMyContent(userId: string, since?: Date, preloaded?: Record<string, unknown>[]): Promise<Reply[]> {
    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();

    const sinceTimestamp = since?.getTime() || 0;

    if (!preloaded && replyOwnersAreDerived()) return this.repliesToMeOnV14(userId, sinceTimestamp);

    const window = notificationWindowFor('reply');
    const response = preloaded ?? (window
      ? await readNotificationWindow(window, userId, sinceTimestamp)
      : await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'reply',
        where: [
          ['parentOwnerId', '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [['parentOwnerId', 'asc'], ['$createdAt', 'desc']],
        limit: 100
      }));

    const documents = normalizeSDKResponse(response);
    return this.withTrueParentOwner(userId, documents.map((doc) => this.transformDocument(doc)));
  }

  /**
   * v14's replies to `userId`'s content since `since`, each once:
   *
   * - `parentOwnerRecent` (keyed by `replyToReplyId.$ownerId`): the nested
   *   replies whose parent reply is the user's. Top-level replies are skipped
   *   by the index, so all of these are "replied to your reply".
   * - `rootOwnerRecent` (keyed by `rootPostId.$ownerId`): EVERY reply of the
   *   user's threads, nested replies between other people included. Only the
   *   top-level ones answer the user's post; a nested one is either already in
   *   the first window (its parent is the user's) or not addressed to the user
   *   at all, and is dropped.
   *
   * Consensus derives both keys from the referenced documents, so nothing here
   * can be forged and no root needs re-reading. A failed read rejects.
   */
  private async repliesToMeOnV14(userId: string, since: number): Promise<Reply[]> {
    const toMyReplies = notificationWindowFor('reply');
    const inMyThreads = notificationWindowFor('threadReply');
    if (!toMyReplies || !inMyThreads) throw new Error('v14 reads replies off rootOwnerRecent and parentOwnerRecent');
    const [nested, thread] = await Promise.all([
      readNotificationWindow(toMyReplies, userId, since),
      readNotificationWindow(inMyThreads, userId, since),
    ]);
    const toMe = [
      ...nested.map((doc) => this.transformDocument(doc)),
      ...thread.map((doc) => this.transformDocument(doc)).filter((reply) => !reply.replyToReplyId),
    ];
    const seen = new Set<string>();
    return toMe.filter((reply) => {
      if (seen.has(reply.id)) return false;
      seen.add(reply.id);
      return true;
    });
  }

  /**
   * Drops replies that name `userId` as their parent's owner falsely. On v9 the
   * contract binds `parentOwnerId` to the parent reply's `$ownerId` only when
   * `replyToReplyId` is present; a DIRECT reply (to the thread root) is not
   * bound, so anyone could file one that lands in a stranger's notifications.
   * Those are kept only when the root post really is `userId`'s: one batched
   * `$id in` read of the roots (cached), and a root that cannot be read is not
   * trusted. On v2 nothing is bound and there is no root field, so nothing
   * changes there.
   */
  private async withTrueParentOwner(userId: string, replies: Reply[]): Promise<Reply[]> {
    // v13 binds a direct reply's parentOwnerId to its root's owner (`parentIsRoot`).
    if (!replyLinkage().replyToReply || repliesNameRootOwner() || replyOwnersAreDerived()) return replies;
    const direct = replies.filter((reply) => !reply.replyToReplyId && reply.rootPostId);
    if (direct.length === 0) return replies;
    const { postService } = await import('./post-service');
    const roots = await postService.getMany(direct.map((reply) => reply.rootPostId as string));
    const mine = new Set(roots.filter((post) => post.author.id === userId).map((post) => post.id));
    return replies.filter((reply) => reply.replyToReplyId || !reply.rootPostId || mine.has(reply.rootPostId));
  }

  /**
   * Get nested replies for multiple parent posts/replies.
   * Returns a Map of parentId -> replies array.
   * Used for building 2-level threaded reply trees.
   *
   * v2 builds its tree with this. On v9/v10 `getReplies` already returns the
   * whole thread and nesting is a client-side grouping; the thread view only
   * calls this to reach a focused reply's subtree past the loaded page.
   *
   * On v10 a reply's children sit under its thread root in `repliesOf`, so
   * `rootPostId` is required there: each parent is read as `rootPostId == R &&
   * replyToReplyId == P` ordered by `$createdAt` (one query per parent, at most
   * 100 children each; not a composite bundle, whose siblings would all sit
   * under the same `rootPostId` prefix). Without it nothing is fetched.
   */
  async getNestedReplies(
    parentIds: string[],
    options: PostQueryOptions & { rootPostId?: string } = {}
  ): Promise<Map<string, Reply[]>> {
    if (parentIds.length === 0) {
      return new Map();
    }

    // The nesting link is `replyToReplyId` where the topology has one, and the
    // double-duty `parentId` otherwise.
    const { root, replyToReply, nestedUnderRoot } = replyLinkage();
    const nestingField = replyToReply ?? root;

    try {
      let documents: Record<string, unknown>[];
      if (nestedUnderRoot) {
        if (!options.rootPostId) {
          logger.warn('getNestedReplies: repliesOf needs the thread root; nothing fetched');
          documents = [];
        } else {
          const rootPostId = options.rootPostId;
          documents = (await mapLimit(parentIds, 4, (parentId) => queryRawDocuments({
            dataContractId: this.contractId,
            documentTypeName: 'reply',
            where: [[root, '==', rootPostId], [nestingField, '==', parentId]],
            orderBy: [['$createdAt', 'asc']],
            limit: 100,
          }))).flat();
        }
      } else {
        const { getEvoSdk } = await import('./evo-sdk-service');
        const sdk = await getEvoSdk();

        const response = await sdk.documents.query({
          dataContractId: this.contractId,
          documentTypeName: 'reply',
          where: [[nestingField, 'in', parentIds]],
          orderBy: [[nestingField, 'asc']],
          limit: 100
        });

        documents = normalizeSDKResponse(response);
      }

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
   * The count tree used depends on the target kind, because on v9/v10 "replies
   * to a post" means the whole thread (`rootPostId ==`: v9 `byRoot`, v10
   * `repliesOf`) while "replies to a reply" means its direct children (v9
   * `byReplyToReply`). On v2 both resolve to `byParent`, so this stays the
   * single polymorphic query it has always been.
   *
   * On v10 a reply's children are only countable under its root
   * (`rootPostId == R && replyToReplyId == P` on `repliesOf`). Pass the reply's
   * `rootPostId` when known; otherwise the reply is read to learn it, and a
   * reply that cannot be read counts 0.
   */
  async countReplies(parentId: string, kind: TargetKind = 'post', rootPostId?: string): Promise<number> {
    try {
      const where = await this.replyCountClauses(parentId, kind, rootPostId);
      if (!where) return 0;
      const sdk = await getEvoSdk();
      return await documentCount(sdk, {
        dataContractId: this.contractId,
        documentTypeName: 'reply',
        where,
      });
    } catch {
      return 0;
    }
  }

  /** The where clauses counting one target's replies, or null when a v10 reply's root cannot be found. */
  private async replyCountClauses(parentId: string, kind: TargetKind, rootPostId?: string): Promise<DocumentWhereClause[] | null> {
    const field = replyCountFieldFor(kind);
    if (!replyCountNeedsRoot(kind)) return [[field, '==', parentId]];
    const root = rootPostId ?? (await this.get(parentId))?.rootPostId;
    return root ? [[replyLinkage().root, '==', root], [field, '==', parentId]] : null;
  }

  /**
   * Reply counts for multiple targets via one grouped count-tree query (falls
   * back to per-target reads).
   *
   * On v10 a reply's child count must pin its root, so reply targets are
   * grouped by `roots` (reply id → thread root) into one
   * `rootPostId == R && replyToReplyId in [...]` query per root; a reply with no
   * known root is counted on its own ({@link countReplies}).
   */
  async countRepliesForPosts(
    parentIds: string[],
    kind: TargetKind = 'post',
    roots: ReadonlyMap<string, string> = new Map()
  ): Promise<Map<string, number>> {
    const sdk = await getEvoSdk();
    const groupField = replyCountFieldFor(kind);
    const base = { dataContractId: this.contractId, documentTypeName: 'reply', groupField };
    if (!replyCountNeedsRoot(kind)) {
      return groupedDocumentCount(sdk, base, parentIds, (id) => this.countReplies(id, kind));
    }

    const result = new Map<string, number>();
    const { byRoot, unrooted } = groupIdsByRoot(parentIds, roots);
    await mapLimit(Array.from(byRoot), 2, async ([root, ids]) => {
      const counts = await groupedDocumentCount(
        sdk,
        { ...base, where: [[replyLinkage().root, '==', root]] },
        ids,
        (id) => this.countReplies(id, kind, root)
      );
      counts.forEach((count, id) => result.set(id, count));
    });
    const loose = await mapLimit(unrooted, 6, (id) => this.countReplies(id, kind));
    unrooted.forEach((id, index) => result.set(id, loose[index]));
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
      // One `$id in` query per 100 ids plus one batched author pass, instead
      // of a fetch + author resolution round trip per reply.
      const replies = await this.getMany(replyIds);
      await this.resolveAuthors(replies);
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

      const profileMap = profileDataByOwnerId(profiles);

      for (const reply of replies) {
        const username = usernameMap.get(reply.author.id);
        const profileData = profileMap.get(reply.author.id);
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
 * (v9) that is one lookup. On v2 the only link is the polymorphic direct parent,
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
    if (!rootPost?.encryptedContent || rootPost.keyGeneration === undefined || !rootPost.nonce) {
      return null;
    }
    return { ownerId: rootPost.author.id, keyGeneration: rootPost.keyGeneration, inherited: true };
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
      if (parentPost.encryptedContent && parentPost.keyGeneration !== undefined && parentPost.nonce) {
        // This is the root private post - use its encryption
        return {
          ownerId: parentPost.author.id,
          keyGeneration: parentPost.keyGeneration,
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
    if (parentReply.encryptedContent && parentReply.keyGeneration !== undefined && parentReply.nonce) {
      // This reply is encrypted - recurse to find the root
      const rootSource = await walkEncryptionSource(parentReply.parentId, depth + 1);
      if (rootSource) {
        return rootSource;
      }
      // No root found - use this reply's author as encryption source
      return {
        ownerId: parentReply.author.id,
        keyGeneration: parentReply.keyGeneration,
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
