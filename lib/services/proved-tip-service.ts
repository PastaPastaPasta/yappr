/**
 * Tips as documents on the social contract (v9 and later).
 *
 * A `tip` / `tipReply` document cites the token-history `transfer` that paid it,
 * and the contract binds the citation with propertyAgreements: the writer must
 * be the transfer's sender, the stored `amount` must equal the transfer's
 * amount, and `recipientId` must be both the transfer's recipient and the
 * tipped document's author (docs/SOCIAL_V9.md). Consensus refuses anything
 * else — 40127 on a mismatched pair, 40120 on a transfer that does not exist,
 * 40105 on a second tip citing one transfer.
 *
 * Two consequences shape this service:
 *
 * 1. **Nothing here reads token history.** Every field rendered is a consensus
 *    fact carried by the tip document itself, so a post's tips cost one indexed
 *    query — where the pre-v9 path scanned the author's newest 100 incoming
 *    transfers and parsed notes out of them.
 * 2. **There is no proved amount TOTAL**, only a proved count. A `summable`
 *    index would have to name a non-U64 property, and the agreement that makes
 *    `amount` trustworthy forces it to be U64 (it must match the token-history
 *    property it is bound to). See docs/PLATFORM_SUMMABLE_AGREEMENT_GAP.md;
 *    until that is relaxed upstream, per-post totals are summed from the tips
 *    themselves — exact whenever the proved count says none were left behind —
 *    and there is no lifetime total.
 */

import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { YAPPR_CONTRACT_ID } from '../constants';
import { tipSurfaceFor, provedTipsAvailable, type TargetKind } from '../contract-topology';
import { getEvoSdk } from './evo-sdk-service';
import { chunk, documentCount, groupedDocumentCount, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import {
  identifierToBase58,
  normalizeSDKResponse,
  type DocumentWhereClause,
  type DocumentOrderByClause,
} from './sdk-helpers';

const CACHE_TTL_MS = 60 * 1000;

/**
 * How many tips one tipped document's strip loads. A post with more tips than
 * this still reports its true count off the count tree, and the strip says it is
 * showing the newest ones.
 */
export const TIP_PAGE_SIZE = 100;

/** One tip, every field of which consensus checked when it was written. */
export interface ProvedTip {
  /** The tip document's own id. */
  id: string;
  /** The token-history transfer this tip cites — the payment itself. */
  transferId: string;
  /** Exact YAPP transferred; equal by consensus to the cited transfer's amount. */
  amount: bigint;
  /** The tipper (the tip's `$ownerId`, which consensus pinned to the transfer's sender). */
  from: string;
  /** The payee; equal by consensus to both the transfer's recipient and the tipped author. */
  to: string;
  /** The tipped post or reply. */
  tippedId: string;
  /** The tipper's own reply carrying the words that went with the tip, if any. */
  messageReplyId?: string;
  createdAt: Date;
}

/** Sum of a set of proved tips. Every amount in it is a consensus fact. */
export function totalTipped(tips: ProvedTip[]): bigint {
  return tips.reduce((sum, tip) => sum + tip.amount, BigInt(0));
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return BigInt(0);
}

/** A raw tip document → ProvedTip, or null when it is not readable as one. */
function toProvedTip(doc: Record<string, unknown>, tippedField: string): ProvedTip | null {
  const data = (doc.data ?? doc) as Record<string, unknown>;
  const id = typeof doc.$id === 'string' ? doc.$id : identifierToBase58(doc.$id);
  const from = typeof doc.$ownerId === 'string' ? doc.$ownerId : identifierToBase58(doc.$ownerId);
  const transferId = identifierToBase58(data.transferId);
  const to = identifierToBase58(data.recipientId);
  const tippedId = identifierToBase58(data[tippedField]);
  if (!id || !from || !transferId || !to || !tippedId) return null;

  const messageReplyId = data.messageReplyId ? identifierToBase58(data.messageReplyId) : null;
  const createdAt = new Date(Number(doc.$createdAt ?? 0));

  return {
    id,
    transferId,
    amount: toBigInt(data.amount),
    from,
    to,
    tippedId,
    ...(messageReplyId ? { messageReplyId } : {}),
    createdAt: Number.isFinite(createdAt.getTime()) ? createdAt : new Date(0),
  };
}

class ProvedTipService {
  private readonly tips = new TtlMap<string, ProvedTip[]>(CACHE_TTL_MS);
  private readonly counts = new TtlMap<string, number>(CACHE_TTL_MS);

  /** Drop every cached read (call once a tip is known to have landed). */
  clearCache(): void {
    this.tips.clear();
    this.counts.clear();
  }

  /**
   * The tips on one post or reply, newest first.
   *
   * One query on `tippedAndTime`. Empty on a topology without tip documents,
   * where a tip moves YAPP but nothing on chain ties it to anything.
   */
  async getTipsFor(kind: TargetKind, tippedId: string): Promise<ProvedTip[]> {
    const surface = tipSurfaceFor(kind);
    if (!surface || !tippedId) return [];

    const cacheKey = `${surface.docType}:${tippedId}`;
    const cached = this.tips.get(cacheKey);
    if (cached) return cached;

    try {
      const sdk = await getEvoSdk();
      const response = await sdk.documents.query({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: surface.docType,
        where: [[surface.tippedField, '==', tippedId]] as DocumentWhereClause[],
        orderBy: [[surface.tippedField, 'asc'], ['$createdAt', 'desc']] as DocumentOrderByClause[],
        limit: TIP_PAGE_SIZE,
      });
      const tips = normalizeSDKResponse(response)
        .map((doc) => toProvedTip(doc, surface.tippedField))
        .filter((tip): tip is ProvedTip => tip !== null);
      this.tips.set(cacheKey, tips);
      return tips;
    } catch (error) {
      logger.warn(`provedTips: tips for ${kind} ${tippedId} failed`, error);
      return [];
    }
  }

  /**
   * Tips on a batch of replies, keyed by the reply they are on.
   *
   * This is how a thread finds its tips: it asks about the replies it is
   * already showing, so it can only ever surface a tip on something in front of
   * the reader. There is deliberately no "tips in this thread" index — a tip
   * would have to name its own thread, and nothing could check that claim.
   */
  async getTipsForReplies(replyIds: string[]): Promise<Map<string, ProvedTip[]>> {
    const surface = tipSurfaceFor('reply');
    const byReply = new Map<string, ProvedTip[]>();
    if (!surface || replyIds.length === 0) return byReply;

    try {
      const sdk = await getEvoSdk();
      // Platform caps `in` clauses at 100 values; a thread page is smaller than
      // that, but a fully expanded thread need not be.
      for (const batch of chunk(replyIds, MAX_IN_CLAUSE_VALUES)) {
        const response = await sdk.documents.query({
          dataContractId: YAPPR_CONTRACT_ID,
          documentTypeName: surface.docType,
          where: [[surface.tippedField, 'in', batch]] as DocumentWhereClause[],
          orderBy: [[surface.tippedField, 'asc']] as DocumentOrderByClause[],
          limit: TIP_PAGE_SIZE,
        });
        for (const doc of normalizeSDKResponse(response)) {
          const tip = toProvedTip(doc, surface.tippedField);
          if (!tip) continue;
          const existing = byReply.get(tip.tippedId);
          if (existing) existing.push(tip);
          else byReply.set(tip.tippedId, [tip]);
        }
      }
      return byReply;
    } catch (error) {
      logger.warn('provedTips: tips for replies failed', error);
      return byReply;
    }
  }

  /**
   * How many tips a post or reply has, off its count tree — proved, and O(log n)
   * however many there are. Tells the strip whether it is showing all of them.
   */
  async countTipsFor(kind: TargetKind, tippedId: string): Promise<number> {
    const surface = tipSurfaceFor(kind);
    if (!surface || !tippedId) return 0;

    const cacheKey = `count:${surface.docType}:${tippedId}`;
    const cached = this.counts.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const sdk = await getEvoSdk();
      const count = await documentCount(sdk, {
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: surface.docType,
        where: [[surface.tippedField, '==', tippedId]],
      });
      this.counts.set(cacheKey, count);
      return count;
    } catch (error) {
      logger.warn(`provedTips: tip count for ${kind} ${tippedId} failed`, error);
      return 0;
    }
  }

  /** Tip counts for many posts at once, in one grouped count-tree query. */
  async countTipsForPosts(postIds: string[]): Promise<Map<string, number>> {
    const surface = tipSurfaceFor('post');
    if (!surface || postIds.length === 0) return new Map();
    try {
      const sdk = await getEvoSdk();
      return await groupedDocumentCount(
        sdk,
        { dataContractId: YAPPR_CONTRACT_ID, documentTypeName: surface.docType, groupField: surface.tippedField },
        postIds,
        (postId) => this.countTipsFor('post', postId)
      );
    } catch (error) {
      logger.warn('provedTips: grouped tip counts failed', error);
      return new Map();
    }
  }

  /**
   * How many proved tips an identity has RECEIVED, over both tip doctypes.
   *
   * Two count-tree reads, each O(log n) — this is a lifetime figure, not a
   * figure "over the last N of anything". It counts tips, not YAPP: the amounts
   * cannot be summed on chain today (see the module comment).
   */
  async countTipsReceived(identityId: string): Promise<number> {
    if (!provedTipsAvailable() || !identityId) return 0;

    const cacheKey = `received:${identityId}`;
    const cached = this.counts.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const sdk = await getEvoSdk();
      const counts = await Promise.all(
        (['post', 'reply'] as const).map(async (kind) => {
          const surface = tipSurfaceFor(kind);
          if (!surface) return 0;
          return documentCount(sdk, {
            dataContractId: YAPPR_CONTRACT_ID,
            documentTypeName: surface.docType,
            where: [['recipientId', '==', identityId]],
          });
        })
      );
      const total = counts.reduce((sum, count) => sum + count, 0);
      this.counts.set(cacheKey, total);
      return total;
    } catch (error) {
      logger.warn(`provedTips: received count for ${identityId} failed`, error);
      return 0;
    }
  }
}

export const provedTipService = new ProvedTipService();
