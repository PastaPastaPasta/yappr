import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierStringToDocumentBytes, normalizeSDKResponse, identifierToBase58, type DocumentOrderByClause, type DocumentWhereClause } from './sdk-helpers';
import { paginateFetchAll, documentCount, groupedDocumentCount, queryOwnedPostIds } from './pagination-utils';
import { isFrozenBalanceError, isInsufficientTokenError } from '../error-utils';
import { hashtagIsOptional, indexOnlyLikeShapeFor, likeIndexFor, type IndexOnlyLikeShape, type TargetKind } from '../contract-topology';

export interface LikeDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
  postOwnerId?: string;
  /**
   * Which doctype this like came out of — `post` for `like`, `reply` for v3's
   * `likeReply`. Callers that render or navigate off a like (notifications) need
   * it, because `postId` alone no longer says what it points at.
   */
  targetKind: TargetKind;
}

/**
 * What the UI knows about a like's target, forwarded so the v4/v5 (indexOnly)
 * write paths can fill the agreement-bound fields without a fetch. Both values
 * are consensus-checked against the target document (40127), so they must be
 * the TARGET's own values: `author` its `author` property (== its `$ownerId`)
 * and `hashtag` its `post.hashtag` (`''` when untagged — the CLIENT convention
 * on v4 and v5 alike; on v5 the chain stores untagged as an absent property
 * and `indexOnlyLikeData` translates at the boundary. Irrelevant for replies).
 * `undefined` means "unknown" and is fetched from the target document instead
 * — it must NEVER be used to mean "untagged", or a like of a tagged post
 * sourced from a hashtag-less UI object would fail the agreement.
 */
export interface LikeTargetInfo {
  author?: string;
  hashtag?: string;
}

/** The delete tuple an indexOnly unlike needs beyond the content values. */
interface LikeTuple {
  documentId: string;
  createdAt: number;
}

const LIKE_RECOVERY_PAGE_SIZE = 100;
const LIKE_RECOVERY_MAX_PAGES = 5;

/**
 * Likes of posts and likes of replies share this service, but not necessarily a
 * document type: the v3 topology routes reply likes to `likeReply` with
 * `replyId`/`replyOwnerId` in place of `postId`/`postOwnerId`. Every method that
 * touches the chain therefore takes the target's kind and resolves the doctype
 * and field names through the topology descriptor. `kind` defaults to `post`,
 * which on v2 is the same surface a reply resolves to — so v2 queries are
 * unchanged whichever kind is passed.
 *
 * On the v4 topology likes are **indexOnly** — see `likeIndexOnly`/
 * `unlikeIndexOnly`. The read surfaces are shape-compatible (owner-first liked
 * state lowers onto `byLiker`, counts onto the countable `byPost`/`byReply`),
 * so every query method below serves all three topologies unchanged.
 */
class LikeService extends BaseDocumentService<LikeDocument> {
  /**
   * Session cache of indexOnly delete tuples, keyed by (kind, ownerId,
   * targetId) — NEVER by a like document's `$id`: create-time ids and the
   * deterministic ids synthesized by queries differ, so a like has no single id
   * to key on. Warmed best-effort after a like lands; `recoverLikeTuple` is the
   * authoritative fallback.
   */
  private likeTupleCache = new Map<string, LikeTuple>();

  /**
   * Monotonic token per tuple-cache key. A background warm-up may only write
   * its result if no newer like/unlike for the same key started after it —
   * otherwise a slow recovery from a previous like could clobber the cache
   * with an already-deleted tuple after an unlike→re-like.
   */
  private tupleWarmTokens = new Map<string, number>();
  private tupleWarmCounter = 0;

  constructor() {
    super('like');
  }

  private tupleCacheKey(targetId: string, ownerId: string, kind: TargetKind): string {
    return `${kind}:${ownerId}:${targetId}`;
  }

  protected transformDocument(doc: Record<string, unknown>): LikeDocument {
    return this.transformDocumentFor(doc, 'post');
  }

  /**
   * Reads a like document into the canonical `{postId, postOwnerId}` shape,
   * regardless of what the topology calls those fields on this kind's doctype.
   */
  private transformDocumentFor(doc: Record<string, unknown>, kind: TargetKind): LikeDocument {
    const data = (doc.data || doc) as Record<string, unknown>;
    const { field, ownerField } = likeIndexFor(kind);

    const rawPostId = data[field] || doc[field];
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    if (rawPostId && !postId) {
      logger.error('LikeService: Invalid target id format:', rawPostId);
    }

    // Owner denormalization is optional in the schema (and absent on some doctypes).
    const rawPostOwnerId = ownerField ? (data[ownerField] || doc[ownerField]) : undefined;
    const postOwnerId = rawPostOwnerId ? identifierToBase58(rawPostOwnerId) : undefined;

    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      postId: postId || '',
      postOwnerId: postOwnerId || undefined,
      targetKind: kind,
    };
  }

  /**
   * Like a post or a reply
   * @param postId - ID of the post/reply being liked
   * @param ownerId - Identity ID of the user liking it
   * @param postOwnerId - Identity ID of the target's author (for efficient notification queries; on v4 the agreement-bound author field)
   * @param kind - Whether the target is a post or a reply
   * @param target - v4 only: agreement-bound values off the target the UI holds (fetched when absent)
   */
  async likePost(postId: string, ownerId: string, postOwnerId?: string, kind: TargetKind = 'post', target?: LikeTargetInfo): Promise<boolean> {
    try {
      // Check if already liked
      const existing = await this.getLike(postId, ownerId, kind);
      if (existing) {
        logger.info('Post already liked');
        return true;
      }

      const shape = indexOnlyLikeShapeFor(kind);
      if (shape) {
        return await this.likeIndexOnly(postId, ownerId, kind, shape, {
          author: target?.author ?? postOwnerId,
          hashtag: target?.hashtag,
        });
      }

      const { docType, field, ownerField } = likeIndexFor(kind);

      // Build document data
      const documentData: Record<string, unknown> = {
        [field]: identifierStringToDocumentBytes(postId)
      };

      // Add the target-owner denormalization if provided (for notification queries)
      if (postOwnerId && ownerField) {
        documentData[ownerField] = identifierStringToDocumentBytes(postOwnerId);
      }

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        docType,
        ownerId,
        documentData
      );

      if (!result.success) {
        throw new Error(result.error || 'Like failed');
      }
      return true;
    } catch (error) {
      logger.error('Error liking post:', error);
      // Let the UI prompt to buy YAPP on insufficient-token failures, and explain
      // the suspension on frozen-account failures (buying YAPP would not help).
      if (isInsufficientTokenError(error) || isFrozenBalanceError(error)) throw error;
      return false;
    }
  }

  /**
   * Unlike a post or reply
   * @param target - v4 only: agreement-bound values off the target (fetched when absent)
   */
  async unlikePost(postId: string, ownerId: string, kind: TargetKind = 'post', target?: LikeTargetInfo): Promise<boolean> {
    try {
      const shape = indexOnlyLikeShapeFor(kind);
      if (shape) {
        return await this.unlikeIndexOnly(postId, ownerId, kind, shape, target);
      }

      const like = await this.getLike(postId, ownerId, kind);
      if (!like) {
        logger.info('Post not liked');
        return true;
      }

      // Use state transition service for deletion
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        likeIndexFor(kind).docType,
        like.$id,
        ownerId
      );

      return result.success;
    } catch (error) {
      logger.error('Error unliking post:', error);
      return false;
    }
  }

  /**
   * Resolve the agreement-bound values an indexOnly like must repeat, fetching
   * the target document for anything the caller could not supply. Consensus
   * compares these byte-for-byte with the target (40127), so on any doubt the
   * on-chain document is the source of truth.
   */
  private async resolveTargetInfo(
    targetId: string,
    kind: TargetKind,
    shape: IndexOnlyLikeShape,
    target?: LikeTargetInfo
  ): Promise<{ author: string; hashtag: string | null }> {
    let author = target?.author;
    let hashtag: string | undefined = shape.hashtagField ? target?.hashtag : undefined;

    if (!author || (shape.hashtagField !== null && hashtag === undefined)) {
      if (kind === 'reply') {
        const { replyService } = await import('./reply-service');
        const reply = await replyService.getReplyById(targetId, { skipEnrichment: true });
        if (!reply) throw new Error(`Cannot resolve like target: reply ${targetId} not found`);
        author = author || reply.author.id;
      } else {
        const { postService } = await import('./post-service');
        const post = await postService.getPostById(targetId, { skipEnrichment: true });
        if (!post) throw new Error(`Cannot resolve like target: post ${targetId} not found`);
        author = author || post.author.id;
        if (hashtag === undefined) hashtag = post.hashtag ?? '';
      }
    }

    if (!author) throw new Error(`Cannot resolve like target author for ${targetId}`);
    return { author, hashtag: shape.hashtagField !== null ? hashtag ?? '' : null };
  }

  /**
   * Build an indexOnly like/likeReply's content properties — the create's data
   * AND the delete-by-values tuple, so like and unlike can never disagree on
   * how a value (or its absence) is spelled.
   *
   * The hashtag translation happens here, once: the client-side '' sentinel
   * ("known untagged") becomes an OMITTED property on v5, where `hashtag` is
   * optional and the propertyAgreement is absence-aware (both absent = agree;
   * writing '' against an absent `post.hashtag` is a 40127 mismatch, and ''
   * fails the v5 pattern anyway). v4 keeps writing '' verbatim. Because the
   * unlike path rebuilds its tuple through this same method, the delete
   * reproduces the create's absence exactly.
   */
  private indexOnlyLikeData(
    targetId: string,
    shape: IndexOnlyLikeShape,
    kind: TargetKind,
    info: { author: string; hashtag: string | null }
  ): Record<string, unknown> {
    const { field } = likeIndexFor(kind);
    const tag = info.hashtag ?? '';
    const writesHashtag = shape.hashtagField !== null && !(hashtagIsOptional() && tag === '');
    return {
      [field]: identifierStringToDocumentBytes(targetId),
      [shape.authorField]: identifierStringToDocumentBytes(info.author),
      ...(writesHashtag && shape.hashtagField !== null ? { [shape.hashtagField]: tag } : {}),
    };
  }

  /**
   * v4 like: create an indexOnly document.
   *
   * The create carries the target's agreement-bound values and confirms via
   * affected-state (indexOnly never yields ExecutionProved). KNOWN SDK QUIRK:
   * the js create path can fail *after* a successful broadcast without ever
   * returning a usable confirmed Document — so a reported failure is
   * re-checked against the chain (the byLiker readback) before being believed,
   * and nothing here relies on the returned document or its `$id`.
   */
  private async likeIndexOnly(
    targetId: string,
    ownerId: string,
    kind: TargetKind,
    shape: IndexOnlyLikeShape,
    target?: LikeTargetInfo
  ): Promise<boolean> {
    const info = await this.resolveTargetInfo(targetId, kind, shape, target);
    const { docType } = likeIndexFor(kind);

    const result = await stateTransitionService.createDocument(
      this.contractId,
      docType,
      ownerId,
      this.indexOnlyLikeData(targetId, shape, kind, info),
      { confirmation: 'affectedState' }
    );

    if (!result.success) {
      // Definitive, user-actionable failures propagate to the UI untouched.
      const err = new Error(result.error || 'Like failed');
      if (isInsufficientTokenError(err) || isFrozenBalanceError(err)) throw err;

      // Anything else may be the post-broadcast throw: believe the chain.
      const landed = await this.waitForLikeVisible(targetId, ownerId, kind);
      if (!landed) throw err;
      logger.warn('Like create reported failure but the like is on-chain — treating as success');
    }

    // Warm the unlike tuple ((ownerId, targetId) → $createdAt/$id) while the
    // covering index is fresh. Best effort: recovery re-runs at unlike time.
    // The token keeps a slow warm-up from a previous like of this key from
    // clobbering the cache after an unlike→re-like.
    const warmKey = this.tupleCacheKey(targetId, ownerId, kind);
    const warmToken = ++this.tupleWarmCounter;
    this.tupleWarmTokens.set(warmKey, warmToken);
    this.recoverLikeTuple(targetId, ownerId, info.author, kind, shape)
      .then((tuple) => {
        if (tuple && this.tupleWarmTokens.get(warmKey) === warmToken) {
          this.likeTupleCache.set(warmKey, tuple);
        }
      })
      .catch(() => { /* recovery is the fallback path */ });

    return true;
  }

  /** Poll the liked-state readback briefly — the post-broadcast-failure check. */
  private async waitForLikeVisible(
    targetId: string,
    ownerId: string,
    kind: TargetKind,
    { attempts = 4, intervalMs = 2_500 }: { attempts?: number; intervalMs?: number } = {}
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await this.getLike(targetId, ownerId, kind)) return true;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return false;
  }

  /** Poll for liked-state ABSENCE — the delete-side twin of waitForLikeVisible. */
  private async waitForLikeGone(
    targetId: string,
    ownerId: string,
    kind: TargetKind,
    { attempts = 3, intervalMs = 2_500 }: { attempts?: number; intervalMs?: number } = {}
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!(await this.getLike(targetId, ownerId, kind))) return true;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return false;
  }

  /**
   * v4 unlike: delete-by-values.
   *
   * The delete transition must carry the like's FULL tuple — every content
   * property plus the consensus `$createdAt`, which only Platform knows.
   * Recovery (validated live on moutai): walk `byAuthorTimePost` /
   * `byAuthorTimeReply` pinned on the target's author, newest first — its
   * projection is the only one carrying `$createdAt` — and match the entry
   * whose target id and `$ownerId` are ours. The remaining values (hashtag,
   * author) come from the target document, exactly as the create wrote them.
   */
  private async unlikeIndexOnly(
    targetId: string,
    ownerId: string,
    kind: TargetKind,
    shape: IndexOnlyLikeShape,
    target?: LikeTargetInfo
  ): Promise<boolean> {
    const info = await this.resolveTargetInfo(targetId, kind, shape, target);
    const cacheKey = this.tupleCacheKey(targetId, ownerId, kind);
    // Invalidate any in-flight warm-up for this key: its tuple describes the
    // like being deleted and must not repopulate the cache afterwards.
    this.tupleWarmTokens.set(cacheKey, ++this.tupleWarmCounter);

    let tuple = this.likeTupleCache.get(cacheKey) ?? null;
    if (!tuple) {
      tuple = await this.recoverLikeTuple(targetId, ownerId, info.author, kind, shape);
    }
    if (!tuple) {
      // No tuple anywhere: either there is no like to remove, or the covering
      // index disagrees with the unique-index readback (which would be a bug).
      const like = await this.getLike(targetId, ownerId, kind);
      if (!like) {
        logger.info('Post not liked');
        return true;
      }
      logger.error('Unlike failed: like exists but its delete tuple could not be recovered', { targetId, kind });
      return false;
    }

    const result = await stateTransitionService.deleteDocumentByValues(
      this.contractId,
      likeIndexFor(kind).docType,
      ownerId,
      {
        documentId: tuple.documentId,
        createdAtMs: tuple.createdAt,
        data: this.indexOnlyLikeData(targetId, shape, kind, info),
      }
    );

    if (result.success) {
      this.likeTupleCache.delete(cacheKey);
      return true;
    }
    // The chain, not the SDK's throw, decides: indexOnly waits can fail after a
    // broadcast that landed (same quirk as creates). If the like is gone now,
    // the delete succeeded.
    if (await this.waitForLikeGone(targetId, ownerId, kind)) {
      this.likeTupleCache.delete(cacheKey);
      logger.warn('Unlike reported failure but the like is gone from the chain — treating as success');
      return true;
    }
    // A stale cached tuple (e.g. re-like from another device changed $createdAt)
    // fails the delete; retry once with a fresh recovery.
    if (this.likeTupleCache.has(cacheKey)) {
      this.likeTupleCache.delete(cacheKey);
      const fresh = await this.recoverLikeTuple(targetId, ownerId, info.author, kind, shape);
      if (fresh && (fresh.createdAt !== tuple.createdAt || fresh.documentId !== tuple.documentId)) {
        const retry = await stateTransitionService.deleteDocumentByValues(
          this.contractId,
          likeIndexFor(kind).docType,
          ownerId,
          {
            documentId: fresh.documentId,
            createdAtMs: fresh.createdAt,
            data: this.indexOnlyLikeData(targetId, shape, kind, info),
          }
        );
        return retry.success;
      }
    }
    return false;
  }

  /**
   * Recover an indexOnly like's delete tuple from the notification index
   * (`byAuthorTimePost [postAuthor, $createdAt, postId]` terminal `$ownerId`,
   * and the `byAuthorTimeReply` mirror) — the only projection that carries the
   * consensus `$createdAt`. Pinned on the target's author, newest first, so a
   * recent like is on the first page; bounded rather than exhaustive.
   */
  private async recoverLikeTuple(
    targetId: string,
    ownerId: string,
    targetAuthor: string,
    kind: TargetKind,
    shape: IndexOnlyLikeShape
  ): Promise<LikeTuple | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const { docType } = likeIndexFor(kind);

      let startAfter: string | undefined;
      for (let page = 0; page < LIKE_RECOVERY_MAX_PAGES; page++) {
        const response = await sdk.documents.query({
          dataContractId: this.contractId,
          documentTypeName: docType,
          where: [[shape.authorField, '==', targetAuthor]],
          orderBy: [[shape.authorField, 'asc'], ['$createdAt', 'desc']],
          limit: LIKE_RECOVERY_PAGE_SIZE,
          ...(startAfter ? { startAfter } : {}),
        });

        const documents = normalizeSDKResponse(response);
        for (const doc of documents) {
          const like = this.transformDocumentFor(doc, kind);
          if (like.postId === targetId && like.$ownerId === ownerId && like.$createdAt) {
            return { documentId: like.$id, createdAt: Number(like.$createdAt) };
          }
        }

        if (documents.length < LIKE_RECOVERY_PAGE_SIZE) break;
        const lastId = documents[documents.length - 1]?.$id;
        if (typeof lastId !== 'string' || !lastId) break;
        startAfter = lastId;
      }
      return null;
    } catch (error) {
      logger.error('Error recovering like delete tuple:', error);
      return null;
    }
  }

  /**
   * Check if a post/reply is liked by user
   */
  async isLiked(postId: string, ownerId: string, kind: TargetKind = 'post'): Promise<boolean> {
    const like = await this.getLike(postId, ownerId, kind);
    return like !== null;
  }

  /**
   * Get a like by target and owner, via the doctype's unique (target, owner) index.
   */
  async getLike(postId: string, ownerId: string, kind: TargetKind = 'post'): Promise<LikeDocument | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const { docType, field, ownerFirst } = likeIndexFor(kind);

      // Equality on both index properties. `in` is a RANGE to Drive, and a query
      // may only range over the last property it constrains — so on a
      // target-first index like `like.postAndOwner` / `likeReply.replyAndOwner`,
      // `[field in [...], $ownerId ==]` comes back EMPTY rather than erroring
      // (see queryOwnedPostIds). Both where and orderBy list the index's
      // properties in the order the contract declares them, so orderBy is derived
      // from where and the two cannot drift apart.
      const targetClause: DocumentWhereClause = [field, '==', postId];
      const ownerClause: DocumentWhereClause = ['$ownerId', '==', ownerId];
      const where = ownerFirst ? [ownerClause, targetClause] : [targetClause, ownerClause];
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: docType,
        where,
        orderBy: where.map(([property]) => [property, 'asc'] as DocumentOrderByClause),
        limit: 1
      });

      const documents = normalizeSDKResponse(response);
      return documents.length > 0 ? this.transformDocumentFor(documents[0], kind) : null;
    } catch (error) {
      logger.error('Error getting like:', error);
      return null;
    }
  }

  /**
   * Get likes for a post or reply.
   * Paginates through all results to return complete list.
   */
  async getPostLikes(postId: string, kind: TargetKind = 'post'): Promise<LikeDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const { docType, field } = likeIndexFor(kind);

      if (indexOnlyLikeShapeFor(kind)) {
        // indexOnly queries reject id-shaped startAfter cursors (synthesized
        // $ids address nothing), so paginateFetchAll's cursor would error on
        // page two. Keyset-paginate on the terminal instead. Verified live:
        // page one must be the PLAIN prefix shape (members come back in
        // $ownerId key order; a terminal orderBy without a terminal clause is
        // refused), and later pages use the full terminal shape — prefix
        // equality + `$ownerId > last` + orderBy on the terminal.
        const PAGE = 100;
        const documents: LikeDocument[] = [];
        let lastOwner: string | null = null;
        for (;;) {
          const where: DocumentWhereClause[] = [[field, '==', postId]];
          if (lastOwner) where.push(['$ownerId', '>', lastOwner]);
          const response = await sdk.documents.query({
            dataContractId: this.contractId,
            documentTypeName: docType,
            where,
            ...(lastOwner ? { orderBy: [['$ownerId', 'asc'] as DocumentOrderByClause] } : {}),
            limit: PAGE
          });
          const page = normalizeSDKResponse(response);
          documents.push(...page.map((doc) => this.transformDocumentFor(doc, kind)));
          if (page.length < PAGE) return documents;
          lastOwner = documents[documents.length - 1].$ownerId;
        }
      }

      // Use 'in' with single-element array - matches working feed pattern
      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: docType,
          where: [[field, 'in', [postId]]],
          orderBy: [[field, 'asc']]
        }),
        (doc) => this.transformDocumentFor(doc, kind)
      );

      return documents;
    } catch (error) {
      logger.error('Error getting post likes:', error);
      return [];
    }
  }

  /**
   * Count likes for a post
   */
  /**
   * Which of the given targets the user has liked — queries only the user's OWN
   * likes via the doctype's unique (target, owner) index, so the result is
   * bounded by the number of targets (not total likes) and never undercounts.
   */
  async getUserLikedPostIds(userId: string, postIds: string[], kind: TargetKind = 'post'): Promise<Set<string>> {
    // v2 `like.postAndOwner` is [postId, $ownerId] → ownerFirst: false.
    const { docType, field, ownerFirst } = likeIndexFor(kind);
    return queryOwnedPostIds({
      getSdk: () => import('../services/evo-sdk-service').then(m => m.getEvoSdk()),
      dataContractId: this.contractId,
      documentTypeName: docType,
      userId,
      postIds,
      ownerFirst,
      field,
      getPostId: (doc) => this.transformDocumentFor(doc, kind)?.postId,
      errorLabel: 'Error fetching user liked post ids:',
    });
  }

  async countLikes(postId: string, kind: TargetKind = 'post'): Promise<number> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
      const { docType, field } = likeIndexFor(kind);
      // O(1) count tree on the doctype's countable [target] index.
      return await documentCount(sdk, {
        dataContractId: this.contractId,
        documentTypeName: docType,
        where: [[field, '==', postId]],
      });
    } catch (error) {
      logger.error('Error counting likes:', error);
      return 0;
    }
  }

  /** Like counts for multiple targets via one grouped count-tree query (falls back to per-target reads). */
  async countLikesForPosts(postIds: string[], kind: TargetKind = 'post'): Promise<Map<string, number>> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    const { docType, field } = likeIndexFor(kind);
    return groupedDocumentCount(
      sdk,
      { dataContractId: this.contractId, documentTypeName: docType, groupField: field },
      postIds,
      (id) => this.countLikes(id, kind)
    );
  }

  /**
   * Get likes on content owned by a specific user (for notification queries).
   *
   * Uses the doctype's target-owner index — `like.postOwnerLikes [postOwnerId,
   * $createdAt]` for posts, and on v3 `likeReply.replyOwnerLikes [replyOwnerId,
   * $createdAt]` for replies. The two are separate doctypes there, so a caller
   * wanting both has to ask twice (see `notification-service`); on v2 they are
   * the same query and asking twice would double-count.
   *
   * @param userId - Identity ID of the content owner
   * @param since - Only return likes created after this timestamp (optional)
   * @param kind - Whether to read likes of posts or likes of replies
   */
  async getLikesOnMyPosts(userId: string, since?: Date, kind: TargetKind = 'post'): Promise<LikeDocument[]> {
    const { docType, ownerField } = likeIndexFor(kind);
    if (!ownerField) return [];

    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const sinceTimestamp = since?.getTime() || 0;

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: docType,
        where: [
          [ownerField, '==', userId],
          ['$createdAt', '>', sinceTimestamp]
        ],
        orderBy: [[ownerField, 'asc'], ['$createdAt', 'asc']],
        limit: 100
      });

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocumentFor(doc, kind));
    } catch (error) {
      logger.error('Error getting likes on my posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const likeService = new LikeService();
