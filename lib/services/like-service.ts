import bs58 from 'bs58';
import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { documentToPlainObject, identifierStringToDocumentBytes, normalizeSDKResponse, identifierToBase58, type DocumentOrderByClause, type DocumentWhereClause } from './sdk-helpers';
import { paginateFetchAll, documentCount, groupedDocumentCount, mapLimit, queryOwnedPostIds } from './pagination-utils';
import { isFrozenBalanceError, isInsufficientTokenError } from '../error-utils';
import type { getEvoSdk } from './evo-sdk-service';
import type { RecentTarget } from '../like-notification-snapshot';
import { indexOnlyLikeShapeFor, likeIndexFor, type IndexOnlyLikeShape, type TargetKind, beatCompanionFor } from '../contract-topology';

export interface LikeDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
  postOwnerId?: string;
  /**
   * Which doctype this like came out of — `post` for `like`, `reply` for v9's
   * `likeReply`. Callers that render or navigate off a like (notifications) need
   * it, because `postId` alone no longer says what it points at.
   */
  targetKind: TargetKind;
}

/**
 * What the UI knows about a like's target, forwarded so the v9 (indexOnly)
 * write paths can fill the agreement-bound fields without a fetch. Both values
 * are consensus-checked against the target document (40127), so they must be
 * the TARGET's own values: `author` its `$ownerId` and `hashtag` its
 * `post.hashtag` (`''` when untagged — the CLIENT convention; the chain stores
 * untagged as an absent property and `indexOnlyLikeData` translates at the
 * boundary. Irrelevant for replies).
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
/** One keyset page of a single indexOnly target's likes (`getPostLikes`, timeless notifications). */
const TARGET_LIKES_PAGE_SIZE = 100;
const LIKE_RECOVERY_MAX_PAGES = 5;

/**
 * v10 like notifications (design C): how many of the recipient's newest posts
 * (and, separately, replies) are checked for likes, how many of those with a
 * like are read per poll, and each read's page. Likes of older content do not
 * notify — the accepted compromise of dropping `byAuthorTimePost`.
 */
const LIKE_NOTIFICATION_RECENT_TARGETS = 20;
/** Recent content read to find those targets: bare reposts (own quote posts with nothing of their own) never gain likes and are skipped. */
const LIKE_NOTIFICATION_RECENT_SCAN = 50;

/** Lexicographic byte order: how Drive orders identifier index keys. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** A raw post that quotes something and carries nothing of its own (a v10 bare repost). */
function isRawBareRepost(doc: Record<string, unknown>): boolean {
  const quotes = Boolean(doc.quotedPostId || doc.quotedReplyId);
  const content = typeof doc.content === 'string' ? doc.content.trim() : '';
  return quotes && !content && !doc.encryptedContent && !doc.mediaUrl && !doc.embedId;
}
const LIKE_NOTIFICATION_PAGE_SIZE = 100;
/**
 * v11 timeless like notifications: keyset pages of one target's likers read
 * when diffing it. Three pages, so a target with exactly 200 likers (what the
 * snapshot tracks) still reads complete; past 200 it stops naming new likers.
 */
const LIKER_READ_MAX_PAGES = 3;
/** v12: per-target liker reads in flight at once (one request each, the targets whose count moved). */
const LIKER_READ_CONCURRENCY = 4;
/** One target's likers (identity ids), and whether the read reached the last of them. */
type TargetLikers = { likers: string[]; complete: boolean };
/** Keyset pages per target when the one `in` read comes back full (1,000 likes of one target since the last poll). */
const LIKE_NOTIFICATION_MAX_PAGES = 10;

/**
 * Likes of posts and likes of replies share this service, but not necessarily a
 * document type: the v9 topology routes reply likes to `likeReply` with
 * `replyId`/`replyOwnerId` in place of `postId`/`postOwnerId`. Every method that
 * touches the chain therefore takes the target's kind and resolves the doctype
 * and field names through the topology descriptor. `kind` defaults to `post`,
 * which on v2 is the same surface a reply resolves to — so v2 queries are
 * unchanged whichever kind is passed.
 *
 * On the v9 and v10 topologies likes are **indexOnly** — see `likeIndexOnly`/
 * `unlikeIndexOnly`. The read surfaces are shape-compatible (v9's owner-first
 * liked state lowers onto `byLiker`, v10's target-first one onto `byPost`/
 * `byReply` with `$ownerId` as the terminal, counts onto the countable
 * `byPost`/`byReply`), so the query methods below serve every topology; the
 * author-time reads (unlike tuple, notifications) pin the target too on v10
 * (`IndexOnlyLikeShape.authorTimeKeysTarget`). v11 has no author-time index:
 * an unlike names no `$createdAt` (`unlikeByContentValues`) and notifications
 * diff likers (`getRecentTargetLikeCounts`, `getLikersOf`). v12 keeps the
 * author indexes as counters (`IndexOnlyLikeShape.authorIndexIsCounter`):
 * they count and rank as before but hold no like documents, so every read of
 * who liked something goes through `byPost`/`byReply`.
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
   * @param postOwnerId - Identity ID of the target's author (for efficient notification queries; on v9 the agreement-bound author field)
   * @param kind - Whether the target is a post or a reply
   * @param target - v9 only: agreement-bound values off the target the UI holds (fetched when absent)
   */
  async likePost(postId: string, ownerId: string, postOwnerId?: string, kind: TargetKind = 'post', target?: LikeTargetInfo): Promise<boolean> {
    try {
      // Check if already liked
      const existing = await this.getLike(postId, ownerId, kind);
      if (existing) {
        logger.debug('Post already liked');
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
   * @param target - v9 only: agreement-bound values off the target (fetched when absent)
   */
  async unlikePost(postId: string, ownerId: string, kind: TargetKind = 'post', target?: LikeTargetInfo): Promise<boolean> {
    try {
      const shape = indexOnlyLikeShapeFor(kind);
      if (shape && !shape.deleteNamesCreatedAt) {
        return await this.unlikeByContentValues(postId, ownerId, kind, shape, target);
      }
      if (shape) {
        return await this.unlikeIndexOnly(postId, ownerId, kind, shape, target);
      }

      const like = await this.getLike(postId, ownerId, kind);
      if (!like) {
        logger.debug('Post not liked');
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
   * ("known untagged") becomes an OMITTED property, because `hashtag` is
   * optional and the propertyAgreement is absence-aware (both absent = agree;
   * writing '' against an absent `post.hashtag` is a 40127 mismatch, and ''
   * fails the pattern anyway). Because the unlike path rebuilds its tuple
   * through this same method, the delete reproduces the create's absence
   * exactly.
   */
  private indexOnlyLikeData(
    targetId: string,
    shape: IndexOnlyLikeShape,
    kind: TargetKind,
    info: { author: string; hashtag: string | null }
  ): Record<string, unknown> {
    const { field } = likeIndexFor(kind);
    const tag = info.hashtag ?? '';
    return {
      [field]: identifierStringToDocumentBytes(targetId),
      [shape.authorField]: identifierStringToDocumentBytes(info.author),
      ...(shape.hashtagField !== null && tag !== '' ? { [shape.hashtagField]: tag } : {}),
    };
  }

  /**
   * The `beat` tuple for a like of a tagged post: `{ postId, hashtag }`. The
   * same tuple serves the create AND the delete-by-values, and its `postId`
   * refersTo the post with propertyAgreement on `hashtag`, so consensus
   * rejects a beat whose tag disagrees with the post.
   */
  private beatData(targetId: string, hashtag: string): Record<string, unknown> {
    return {
      postId: identifierStringToDocumentBytes(targetId),
      hashtag,
    };
  }

  /**
   * indexOnly like: create the document.
   *
   * The create carries the target's agreement-bound values and confirms via
   * affected-state (indexOnly never yields ExecutionProved). KNOWN SDK QUIRK:
   * the js create path can fail *after* a successful broadcast without ever
   * returning a usable confirmed Document — so a reported failure is
   * re-checked against the chain (the liked-state readback) before being believed,
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
    const likeData = this.indexOnlyLikeData(targetId, shape, kind, info);

    const result = await stateTransitionService.createDocument(
      this.contractId,
      docType,
      ownerId,
      likeData,
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

    // v9: a like of a TAGGED post is followed by its `beat` companion (today's
    // trending rides beat.byDayHashtagPost). Consensus caps a document batch
    // at ONE transition on this network, so the pair cannot be atomic: the
    // beat is a second transition, written only once the like is known to
    // have landed, and awaited so the UI's "liked" state does not race the
    // trending count. A beat failure is logged, never surfaced — the like is
    // the user's action; the beat is the ranking's bookkeeping, and a missing
    // one only under-counts one tag for the rest of the UTC day.
    const companion = beatCompanionFor(kind, info.hashtag);
    if (companion) {
      const beat = await stateTransitionService.createDocument(
        this.contractId,
        companion.docType,
        ownerId,
        this.beatData(targetId, info.hashtag ?? ''),
        { confirmation: 'affectedState' }
      );
      if (!beat.success) {
        logger.warn('Like landed but its beat companion did not; today\'s trending under-counts this tag:', beat.error);
      }
    }

    // v11: an unlike names no `$createdAt`, so there is no tuple to warm.
    if (!shape.deleteNamesCreatedAt) return true;

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

  /**
   * Poll for liked-state ABSENCE — the delete-side twin of waitForLikeVisible.
   * Only a successful empty read counts: a failed read proves nothing, and a
   * "gone" answer authorises deleting the beat companion.
   */
  private async waitForLikeGone(
    targetId: string,
    ownerId: string,
    kind: TargetKind,
    { attempts = 3, intervalMs = 2_500 }: { attempts?: number; intervalMs?: number } = {}
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (!(await this.queryLike(targetId, ownerId, kind))) return true;
      } catch (error) {
        logger.warn('like readback failed:', error);
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return false;
  }

  /**
   * indexOnly unlike on v11: delete-by-values with the like's CONTENT
   * properties only ({@link indexOnlyLikeData}) and no `$createdAt`. Every v11
   * like index involving `$createdAt` is a trend window marked
   * `outlivesDelete`, so the row no longer commits to the time (the SDK drops
   * a `$createdAt` passed on such a type; none is passed). The unliked like's
   * trend-window entries stay counted until their window expires.
   *
   * The liked-state read runs first, so an unlike of nothing stays a no-op
   * success (and a failed read fails the unlike rather than passing for "not
   * liked"). Consensus does not check an indexOnly delete's document id (the
   * live proof deleted with a random one): the read's synthesized `$id` is
   * reused, a random 32-byte id when it has none.
   */
  private async unlikeByContentValues(
    targetId: string,
    ownerId: string,
    kind: TargetKind,
    shape: IndexOnlyLikeShape,
    target?: LikeTargetInfo
  ): Promise<boolean> {
    const like = await this.queryLike(targetId, ownerId, kind);
    if (!like) {
      logger.debug('Post not liked');
      return true;
    }
    const info = await this.resolveTargetInfo(targetId, kind, shape, target);
    const result = await stateTransitionService.deleteDocumentByValues(
      this.contractId,
      likeIndexFor(kind).docType,
      ownerId,
      {
        documentId: typeof like.$id === 'string' && like.$id ? like.$id : bs58.encode(crypto.getRandomValues(new Uint8Array(32))),
        data: this.indexOnlyLikeData(targetId, shape, kind, info),
      }
    );
    // As on v9/v10: an unconfirmed or failed report is settled by the chain.
    if (result.success) return true;
    if (!(await this.waitForLikeGone(targetId, ownerId, kind))) return false;
    logger.warn('Unlike reported failure but the like is gone from the chain — treating as success');
    return true;
  }

  /**
   * indexOnly unlike (v9, v10): delete-by-values.
   *
   * The delete transition must carry the like's FULL tuple — every content
   * property plus the consensus `$createdAt`, which only Platform knows.
   * Recovery ({@link recoverLikeTuple}): walk the author-time index — the only
   * projection carrying `$createdAt` — newest first, and match the entry whose
   * target id and `$ownerId` are ours. The remaining values (hashtag, author)
   * come from the target document, exactly as the create wrote them.
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
        logger.debug('Post not liked');
        return true;
      }
      logger.error('Unlike failed: like exists but its delete tuple could not be recovered', { targetId, kind });
      return false;
    }

    const deleteLike = (t: LikeTuple) => stateTransitionService.deleteDocumentByValues(
      this.contractId,
      likeIndexFor(kind).docType,
      ownerId,
      {
        documentId: t.documentId,
        createdAtMs: t.createdAt,
        data: this.indexOnlyLikeData(targetId, shape, kind, info),
      }
    );

    // A confirmed delete is believed (from 4.2.0-beta.7 the SDK waits for the
    // affected state). Anything else, such as a timed-out wait or a stale
    // tuple's rejection, is settled by the chain: if the like is gone now, the
    // delete succeeded.
    let result = await deleteLike(tuple);
    let gone = result.success || await this.waitForLikeGone(targetId, ownerId, kind);
    // A stale cached tuple (e.g. re-like from another device changed $createdAt)
    // fails the delete; retry once with a fresh recovery.
    if (!gone && this.likeTupleCache.has(cacheKey)) {
      this.likeTupleCache.delete(cacheKey);
      const fresh = await this.recoverLikeTuple(targetId, ownerId, info.author, kind, shape);
      if (fresh && (fresh.createdAt !== tuple.createdAt || fresh.documentId !== tuple.documentId)) {
        result = await deleteLike(fresh);
        gone = result.success || await this.waitForLikeGone(targetId, ownerId, kind);
      }
    }
    if (!gone) return false;
    this.likeTupleCache.delete(cacheKey);
    if (!result.success) {
      logger.warn('Unlike reported failure but the like is gone from the chain — treating as success');
    }

    // v9: remove the beat companion too, so today's trending stops counting
    // the withdrawn like. Runs on EVERY path that established the like is
    // gone, and is awaited like the create's beat. A beat that stays is
    // logged, never surfaced — the unlike itself landed; a stale beat only
    // over-counts one tag for the rest of the UTC day.
    if (beatCompanionFor(kind, info.hashtag)) {
      const removed = await this.removeBeatCompanion(targetId, ownerId, info.hashtag ?? '').catch((error) => {
        logger.warn('Unlike landed but removing its beat companion failed:', error);
        return false;
      });
      if (!removed) {
        logger.warn('Unlike landed but its beat companion is still on chain; today\'s trending over-counts this tag');
      }
    }
    return true;
  }

  /**
   * v9: delete the `beat` written after a like of a tagged post.
   *
   * The delete-by-values tuple needs the beat's `$id` AND its own
   * `$createdAt` (the beat lands in a later block than the like, so the
   * like's timestamp addresses nothing — probed live). Both come from the
   * `byPostTime` projection: `[postId, $createdAt] → $ownerId`, the plain
   * twin of `like.byAuthorTimePost`, which keys the timestamp. A beat that
   * cannot be addressed is left standing — it only over-counts one tag for
   * the rest of the UTC day. Resolves true once none of the viewer's beats on
   * the post is left on chain.
   */
  private async removeBeatCompanion(targetId: string, ownerId: string, hashtag: string): Promise<boolean> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    const response = await sdk.documents.query({
      dataContractId: this.contractId,
      documentTypeName: 'beat',
      where: [['postId', '==', targetId]],
      orderBy: [['postId', 'asc'], ['$createdAt', 'desc']],
      limit: LIKE_RECOVERY_PAGE_SIZE,
    });
    // No unique (post, owner) index, so a viewer can hold several — a like's
    // own beat plus any an earlier unlike failed to remove. Clear them all:
    // an unliked post carries none of the viewer's beats.
    const mine = normalizeSDKResponse(response).filter((row) => row.$ownerId === ownerId);
    let allGone = true;
    for (const doc of mine) {
      const documentId = typeof doc.$id === 'string' ? doc.$id : null;
      const createdAtMs = doc.$createdAt !== undefined && doc.$createdAt !== null ? Number(doc.$createdAt) : NaN;
      if (!documentId || !Number.isFinite(createdAtMs) || createdAtMs <= 0) {
        logger.warn('beat companion found but its delete tuple is incomplete', { targetId, documentId, createdAtMs });
        allGone = false;
        continue;
      }
      const result = await stateTransitionService.deleteDocumentByValues(this.contractId, 'beat', ownerId, {
        documentId,
        createdAtMs,
        data: this.beatData(targetId, hashtag),
      });
      // Unconfirmed (optimistic timeout) or a reported failure: only the
      // chain can say whether the beat is gone.
      if (!(result.success && result.confirmed) && !(await this.waitForBeatGone(targetId, ownerId, documentId, createdAtMs))) {
        allGone = false;
      }
    }
    return allGone; // vacuously true when there was none (untagged at like time, or already gone)
  }

  /**
   * Poll for a beat's ABSENCE, pinned on its exact `byPostTime` key
   * (`postId`, `$createdAt`) so the answer never depends on how many other
   * beats the post has. A failed read counts as "still there".
   */
  private async waitForBeatGone(
    targetId: string,
    ownerId: string,
    documentId: string,
    createdAtMs: number,
    { attempts = 3, intervalMs = 2_500 }: { attempts?: number; intervalMs?: number } = {}
  ): Promise<boolean> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await sdk.documents.query({
          dataContractId: this.contractId,
          documentTypeName: 'beat',
          where: [['postId', '==', targetId], ['$createdAt', '==', createdAtMs]],
          limit: LIKE_RECOVERY_PAGE_SIZE,
        });
        const standing = normalizeSDKResponse(response).some((row) => row.$ownerId === ownerId && row.$id === documentId);
        if (!standing) return true;
      } catch (error) {
        logger.warn('beat readback failed:', error);
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return false;
  }

  /**
   * Recover an indexOnly like's delete tuple from the author-time index — the
   * only projection that carries the consensus `$createdAt`:
   *
   * - v9 `byAuthorTimePost [postAuthor, $createdAt, postId]` (and the
   *   `byAuthorTimeReply` mirror), pinned on the target's author: every like
   *   of any of their posts, newest first.
   * - v10 `byAuthorPostTime [postAuthor, postId, $createdAt]` (and
   *   `byAuthorReplyTime`), pinned on the author AND the target: only this
   *   target's likes, newest first.
   *
   * Both terminate in `$ownerId`; the viewer's row is the one owned by them.
   * indexOnly rows carry synthesized ids (a one-way hash of the index
   * position), which Drive refuses as startAfter cursors, so later pages are a
   * keyset on the `$createdAt` level with the same orderBy. The bound is
   * inclusive (`<=`) because likes sharing a millisecond or block share a
   * `$createdAt`, and `<` would skip the ones the previous page cut off; the
   * rows that boundary re-serves are dropped by `seen`. A run of more than one
   * page of likes at a single timestamp cannot be walked past — the page then
   * adds nothing new and the walk stops. Bounded, not exhaustive.
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
      const { docType, field } = likeIndexFor(kind);
      const prefix: DocumentWhereClause[] = shape.authorTimeKeysTarget
        ? [[shape.authorField, '==', targetAuthor], [field, '==', targetId]]
        : [[shape.authorField, '==', targetAuthor]];
      const orderBy: DocumentOrderByClause[] = [...prefix.map(([property]) => [property, 'asc'] as DocumentOrderByClause), ['$createdAt', 'desc']];

      const seen = new Set<string>();
      let before: number | null = null;
      for (let page = 0; page < LIKE_RECOVERY_MAX_PAGES; page++) {
        const where: DocumentWhereClause[] = before === null ? prefix : [...prefix, ['$createdAt', '<=', before]];
        const response = await sdk.documents.query({
          dataContractId: this.contractId,
          documentTypeName: docType,
          where,
          orderBy,
          limit: LIKE_RECOVERY_PAGE_SIZE,
        });

        const documents = normalizeSDKResponse(response);
        let added = 0;
        for (const doc of documents) {
          const like = this.transformDocumentFor(doc, kind);
          const key = `${like.$ownerId}|${like.postId}|${like.$createdAt}`;
          if (seen.has(key)) continue;
          seen.add(key);
          added++;
          if (like.postId === targetId && like.$ownerId === ownerId && like.$createdAt) {
            return { documentId: like.$id, createdAt: Number(like.$createdAt) };
          }
        }

        if (documents.length < LIKE_RECOVERY_PAGE_SIZE || added === 0) break;
        const last = Number(this.transformDocumentFor(documents[documents.length - 1], kind).$createdAt);
        if (!Number.isFinite(last) || last <= 0) break;
        before = last;
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
      return await this.queryLike(postId, ownerId, kind);
    } catch (error) {
      logger.error('Error getting like:', error);
      return null;
    }
  }

  /** getLike without the error swallowing: a failed read throws. */
  private async queryLike(postId: string, ownerId: string, kind: TargetKind): Promise<LikeDocument | null> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    const { docType, field, ownerFirst, ownerIsTerminal } = likeIndexFor(kind);

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
      // v10 pins byPost/byReply's value and terminal with equalities alone, the
      // shape proven live; v2/v9 keep the orderBy their stored indexes take.
      ...(ownerIsTerminal ? {} : { orderBy: where.map(([property]) => [property, 'asc'] as DocumentOrderByClause) }),
      limit: 1
    });

    const documents = normalizeSDKResponse(response);
    return documents.length > 0 ? this.transformDocumentFor(documents[0], kind) : null;
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
        return (await this.pageTargetLikes(sdk, postId, kind, Infinity)).likes;
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
   * Every like of one indexOnly target, up to `maxPages` pages; `complete` is
   * false when the cap cut the walk short.
   *
   * indexOnly queries reject id-shaped startAfter cursors (synthesized $ids
   * address nothing), so paginateFetchAll's cursor would error on page two.
   * Keyset-paginate on the terminal instead: prefix equality, then
   * `$ownerId > last` from page two. By default page one is the plain prefix
   * shape (no orderBy; members come back in $ownerId key order) and later
   * pages order on the terminal alone — the shape getPostLikes proved on v10.
   * `targetThenOwner` orders EVERY page `[target asc, $ownerId asc]`, the
   * shape proven on v11 for the timeless notification read.
   */
  private async pageTargetLikes(
    sdk: Awaited<ReturnType<typeof getEvoSdk>>,
    targetId: string,
    kind: TargetKind,
    maxPages: number,
    { targetThenOwner = false }: { targetThenOwner?: boolean } = {}
  ): Promise<{ likes: LikeDocument[]; complete: boolean }> {
    const { docType, field } = likeIndexFor(kind);
    const likes: LikeDocument[] = [];
    let lastOwner: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const where: DocumentWhereClause[] = [[field, '==', targetId]];
      if (lastOwner) where.push(['$ownerId', '>', lastOwner]);
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: docType,
        where,
        ...(targetThenOwner
          ? { orderBy: [[field, 'asc'], ['$ownerId', 'asc']] as DocumentOrderByClause[] }
          : lastOwner ? { orderBy: [['$ownerId', 'asc'] as DocumentOrderByClause] } : {}),
        limit: TARGET_LIKES_PAGE_SIZE
      });
      const rows = normalizeSDKResponse(response);
      likes.push(...rows.map((doc) => this.transformDocumentFor(doc, kind)));
      if (rows.length < TARGET_LIKES_PAGE_SIZE) return { likes, complete: true };
      lastOwner = likes[likes.length - 1].$ownerId;
    }
    return { likes, complete: false };
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
    // v2 `like.postAndOwner` is [postId, $ownerId] → ownerFirst: false; v10
    // `like.byPost [postId]` terminal `$ownerId` → batched target `in`.
    const { docType, field, ownerFirst, ownerIsTerminal } = likeIndexFor(kind);
    return queryOwnedPostIds({
      getSdk: () => import('../services/evo-sdk-service').then(m => m.getEvoSdk()),
      dataContractId: this.contractId,
      documentTypeName: docType,
      userId,
      postIds,
      ownerFirst,
      ownerIsTerminal,
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
   * Uses the doctype's target-owner index — v2's `like.postOwnerLikes
   * [postOwnerId, $createdAt]`, and on v9 `like.byAuthorTimePost [postAuthor,
   * $createdAt, postId]` / `likeReply.byAuthorTimeReply [replyAuthor,
   * $createdAt, replyId]`. The two are separate doctypes there, so a caller
   * wanting both has to ask twice (see `notification-service`); on v2 they are
   * the same query and asking twice would double-count. On v10 the author-time
   * index keys the target first, so this is a fan-out over the user's recent
   * content instead ({@link getLikesOnMyRecentContent}; `preloaded` unused).
   *
   * Rejects when a read fails, so the notification watermark does not move
   * past the likes it missed.
   *
   * @param userId - Identity ID of the content owner
   * @param since - Only return likes created after this timestamp (optional)
   * @param kind - Whether to read likes of posts or likes of replies
   */
  async getLikesOnMyPosts(userId: string, since?: Date, kind: TargetKind = 'post', preloaded?: Record<string, unknown>[]): Promise<LikeDocument[]> {
    const { docType, ownerField } = likeIndexFor(kind);
    if (!ownerField) return [];

    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

    const sinceTimestamp = since?.getTime() || 0;
    const shape = indexOnlyLikeShapeFor(kind);
    // v11: no like index keeps a like's time; timeless notifications diff
    // likers instead (getRecentTargetLikeCounts + getLikersOf).
    if (shape && shape.authorTimeIndex === null) return [];
    if (shape?.authorTimeKeysTarget) {
      return this.getLikesOnMyRecentContent(userId, sinceTimestamp, kind, shape);
    }

    const response = preloaded ?? await sdk.documents.query({
      dataContractId: this.contractId,
      documentTypeName: docType,
      where: [
        [ownerField, '==', userId],
        ['$createdAt', '>', sinceTimestamp]
      ],
      orderBy: [[ownerField, 'asc'], ['$createdAt', 'desc']],
      limit: 100
    });

    const documents = normalizeSDKResponse(response);
    return documents.map((doc) => this.transformDocumentFor(doc, kind));
  }

  /**
   * v10 (like design C): likes of the user's RECENT posts (or replies) since
   * `sinceTimestamp`, newest content first. Likes of older content do not
   * notify — the accepted cost of dropping the author-wide time index.
   *
   * 1. ONE composite: the user's newest {@link LIKE_NOTIFICATION_RECENT_SCAN}
   *    posts on `ownerAndTime [$ownerId, $createdAt]` (the first
   *    {@link LIKE_NOTIFICATION_RECENT_TARGETS} that are not bare reposts are
   *    kept: a repost never gains likes) with a like-count slot
   *    bound page `$id` → `postId` (grouped on the countable `byPost`/`byReply`).
   * 2. ONE plain read over every one of them with a count > 0: `author == me
   *    && target in [liked] && $createdAt > since` ordered `[author, target,
   *    $createdAt desc]` on `byAuthorPostTime`/`byAuthorReplyTime` (the `in`
   *    fans out per target under the author, each branch walking `$createdAt`
   *    newest first). Each row carries the liker (`$ownerId`), the exact
   *    `$createdAt` and its target, read off the row itself.
   *
   * Normally 1 composite + 1 read per kind; a full read falls back to
   * per-target keyset reads. A failed read rejects (no partial answer), and
   * the notification fetch then keeps its watermark, so the next poll reads
   * these likes again.
   */
  private async getLikesOnMyRecentContent(userId: string, sinceTimestamp: number, kind: TargetKind, shape: IndexOnlyLikeShape): Promise<LikeDocument[]> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    const { docType, field } = likeIndexFor(kind);

    const recent = await this.getRecentTargetLikeCounts(userId, kind);
    const liked = [...recent].flatMap(([targetId, { count }]) => (count > 0 ? [targetId] : []));
    if (liked.length === 0) return [];

    const read = (targets: string[], extra: DocumentWhereClause[] = []) => sdk.documents.query({
      dataContractId: this.contractId,
      documentTypeName: docType,
      where: [[shape.authorField, '==', userId], [field, 'in', targets], ['$createdAt', '>', sinceTimestamp], ...extra],
      orderBy: [[shape.authorField, 'asc'], [field, 'asc'], ['$createdAt', 'desc']],
      limit: LIKE_NOTIFICATION_PAGE_SIZE,
    }).then((response) => normalizeSDKResponse(response)
      // Each row names its own target; one whose target did not come back cannot be linked.
      .map((doc) => this.transformDocumentFor(doc, kind))
      .filter((like) => like.postId !== ''));

    const rows = await read(liked);
    if (rows.length < LIKE_NOTIFICATION_PAGE_SIZE) return rows;
    // A full page: the `in` read walks target by target, so it may have cut a
    // target short or left later ones out, and the watermark would then pass
    // them for good. Read every target on its own, keyset-paged on
    // `$createdAt` (`<=` plus a dedupe; an indexOnly type takes no id cursor),
    // until a short page.
    const perTarget = await Promise.all(liked.map(async (targetId) => {
      const seen = new Map<string, LikeDocument>();
      let cursor: number | null = null;
      for (let page = 0; page < LIKE_NOTIFICATION_MAX_PAGES; page++) {
        const likes = await read([targetId], cursor === null ? [] : [['$createdAt', '<=', cursor]]);
        let added = 0;
        for (const like of likes) {
          const key = `${like.$ownerId}|${like.$createdAt}`;
          if (!seen.has(key)) { seen.set(key, like); added++; }
        }
        if (likes.length < LIKE_NOTIFICATION_PAGE_SIZE || added === 0) break;
        cursor = Math.min(...likes.map((like) => Number(like.$createdAt)));
      }
      return [...seen.values()];
    }));
    return perTarget.flat();
  }

  /**
   * The like count and `$createdAt` of each of the user's
   * {@link LIKE_NOTIFICATION_RECENT_TARGETS} newest posts (or replies), newest
   * first, zero counts included: ONE
   * composite reading the user's newest {@link LIKE_NOTIFICATION_RECENT_SCAN}
   * on `ownerAndTime [$ownerId, $createdAt]` (bare reposts never gain likes
   * and tombstones are deleted, so both are skipped) with a like-count slot bound page `$id` → target, grouped
   * on the countable `byPost`/`byReply`. Throws on a failed or incomplete read.
   *
   * The same read serves v12, where the author index is a counter that could
   * answer the counts too (`postAuthor == me && postId in [...]` grouped by
   * `postId` on `byAuthorPost`): the composite needs the recent page anyway,
   * and the target index counts the same entries the counter sums.
   */
  async getRecentTargetLikeCounts(userId: string, kind: TargetKind): Promise<Map<string, RecentTarget>> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    const { docType, field } = likeIndexFor(kind);

    const result = await sdk.documents.composite({
      dataContractId: this.contractId,
      documentType: kind,
      where: [['$ownerId', '==', userId], ['$createdAt', '>', 0]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: LIKE_NOTIFICATION_RECENT_SCAN,
      subQueries: [{ documentType: docType, kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field } }],
    });
    const countsResult = result.subResults?.[0];
    if (!Array.isArray(result.pageDocuments) || result.subResults.length !== 1 || countsResult?.kind !== 'counts' || !(countsResult.counts instanceof Map)) {
      throw new Error('Incomplete like counts of recent content');
    }
    const counts = countsResult.counts;

    return new Map(result.pageDocuments
      .map((doc) => documentToPlainObject(doc))
      .sort((a, b) => Number(b.$createdAt) - Number(a.$createdAt))
      // A v11 tombstone (an author's delete, or an undone repost) is not a
      // target to announce likes of either.
      .filter((doc) => !isRawBareRepost(doc) && doc.deleted !== true)
      .slice(0, LIKE_NOTIFICATION_RECENT_TARGETS)
      .flatMap((doc): [string, RecentTarget][] => (typeof doc.$id === 'string' && Number.isFinite(Number(doc.$createdAt))
        ? [[doc.$id, { count: Number(counts.get(doc.$id) ?? 0), createdAtMs: Number(doc.$createdAt) }]]
        : [])));
  }

  /**
   * Timeless like notifications (v11, v12): who likes each of `targetIds`,
   * the user's own posts or replies (identity ids, in `$ownerId` order).
   *
   * v11: ONE read over all of them on the author index (`byAuthorPost`/
   * `byAuthorReply`, which keep no time): `author == me && target in [...]`
   * ordered `[author asc, target asc]`; each row names its liker and target.
   * (`target in` on `byPost` alone is refused: an `in` on an indexOnly prefix
   * needs an equality on the terminal unless the author is pinned.) A full
   * page may have cut short the last row's target, and left out those that
   * sort after it (the `in` walks targets in key order, so the ones before it
   * are complete). An indexOnly type takes no id cursor, so each of those is
   * then read on its own ({@link readTargetLikers}).
   *
   * v12 ({@link IndexOnlyLikeShape.authorIndexIsCounter}): the author index
   * keeps one counter per target and no like documents, so there is no
   * author-pinned read of likers. Every target is read on its own on
   * `byPost`/`byReply` instead: one request per target (the caller only asks
   * for the targets whose count moved, at most 10 per kind per poll), plus a
   * page per further 100 likers, {@link LIKER_READ_CONCURRENCY} at a time.
   * A target whose read fails is left out of the answer, which the like
   * snapshot takes as "not re-read": it keeps that target's known likers and
   * count, so the next poll reads it again while the others proceed. (A
   * `complete: false` entry would store the new count without likers, and
   * that target's next likers would then be taken silently.) Throws when
   * every read failed, and on v11 on a failed read.
   */
  async getLikersOf(userId: string, targetIds: string[], kind: TargetKind): Promise<Map<string, TargetLikers>> {
    const shape = indexOnlyLikeShapeFor(kind);
    if (!shape) throw new Error('Liker reads need an indexOnly like doctype');
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());
    const { docType, field } = likeIndexFor(kind);

    if (shape.authorIndexIsCounter) {
      const reads = await mapLimit(targetIds, LIKER_READ_CONCURRENCY, (targetId) => this.readTargetLikers(sdk, targetId, kind).then(
        (value): PromiseSettledResult<TargetLikers> => ({ status: 'fulfilled', value }),
        (reason: unknown): PromiseSettledResult<TargetLikers> => ({ status: 'rejected', reason })
      ));
      const likers = new Map<string, TargetLikers>();
      const failed: unknown[] = [];
      reads.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') likers.set(targetIds[index], outcome.value);
        else failed.push(outcome.reason);
      });
      if (failed.length > 0 && failed.length === targetIds.length) {
        throw failed[0] instanceof Error ? failed[0] : new Error(String(failed[0]));
      }
      if (failed.length > 0) logger.warn(`Like notifications: ${failed.length} of ${targetIds.length} ${kind} liker reads failed; they are re-read next poll:`, failed[0]);
      return likers;
    }

    const rows = normalizeSDKResponse(await sdk.documents.query({
      dataContractId: this.contractId,
      documentTypeName: docType,
      where: [[shape.authorField, '==', userId], [field, 'in', targetIds]],
      orderBy: [[shape.authorField, 'asc'], [field, 'asc']],
      limit: TARGET_LIKES_PAGE_SIZE,
    })).map((doc) => this.transformDocumentFor(doc, kind));
    const fromRows = (targetId: string) => ({
      likers: rows.filter((like) => like.postId === targetId).map((like) => like.$ownerId),
      complete: true,
    });
    if (rows.length < TARGET_LIKES_PAGE_SIZE) {
      return new Map(targetIds.map((targetId) => [targetId, fromRows(targetId)]));
    }

    const cutAt = bs58.decode(rows[rows.length - 1].postId);
    return new Map(await Promise.all(targetIds.map(async (targetId) => {
      if (compareBytes(bs58.decode(targetId), cutAt) < 0) return [targetId, fromRows(targetId)] as const;
      return [targetId, await this.readTargetLikers(sdk, targetId, kind)] as const;
    })));
  }

  /**
   * One target's likers on `byPost`/`byReply`: `target == T` ordered
   * `[target asc, $ownerId asc]` and paged on an `$ownerId > last` keyset (an
   * indexOnly type takes no id cursor), capped at {@link LIKER_READ_MAX_PAGES}
   * pages (`complete: false` past it). The read is proved, as every like
   * documents read must be: no like index holds every like property.
   */
  private async readTargetLikers(
    sdk: Awaited<ReturnType<typeof getEvoSdk>>,
    targetId: string,
    kind: TargetKind
  ): Promise<TargetLikers> {
    const { likes, complete } = await this.pageTargetLikes(sdk, targetId, kind, LIKER_READ_MAX_PAGES, { targetThenOwner: true });
    return { likers: likes.map((like) => like.$ownerId), complete };
  }
}

// Singleton instance
export const likeService = new LikeService();
