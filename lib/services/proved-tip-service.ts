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
import { chunk, documentCount } from './pagination-utils';
import {
  documentBigInt,
  documentCreatedAt,
  identifierToBase58,
  normalizeSDKResponse,
  systemIdentifier,
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

/**
 * Replies asked about per query. Small on purpose: the page limit counts tips,
 * so a batch this size cannot be exhausted by one reply unless that reply alone
 * carries five pages' worth.
 */
const REPLY_TIP_BATCH = 20;

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

/** A raw tip document → ProvedTip, or null when it is not readable as one. */
function toProvedTip(doc: Record<string, unknown>, tippedField: string): ProvedTip | null {
  const data = (doc.data ?? doc) as Record<string, unknown>;
  const id = systemIdentifier(doc.$id);
  const from = systemIdentifier(doc.$ownerId);
  const transferId = identifierToBase58(data.transferId);
  const to = identifierToBase58(data.recipientId);
  const tippedId = identifierToBase58(data[tippedField]);
  if (!id || !from || !transferId || !to || !tippedId) return null;

  const messageReplyId = data.messageReplyId ? identifierToBase58(data.messageReplyId) : null;

  return {
    id,
    transferId,
    amount: documentBigInt(data.amount),
    from,
    to,
    tippedId,
    ...(messageReplyId ? { messageReplyId } : {}),
    createdAt: documentCreatedAt(doc.$createdAt),
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
   *
   * Asked in small batches, and each answer cached per reply. The `limit` caps
   * DOCUMENTS, not replies, so a batch is kept well under the page: one heavily
   * tipped reply can then only ever crowd out the handful it shares a query
   * with, and the next thread page re-reads none of what this one resolved.
   */
  async getTipsForReplies(replyIds: string[]): Promise<Map<string, ProvedTip[]>> {
    const surface = tipSurfaceFor('reply');
    const byReply = new Map<string, ProvedTip[]>();
    if (!surface || replyIds.length === 0) return byReply;

    const missing: string[] = [];
    for (const replyId of new Set(replyIds)) {
      const cached = this.tips.get(`${surface.docType}:${replyId}`);
      if (cached) {
        if (cached.length > 0) byReply.set(replyId, cached);
      } else {
        missing.push(replyId);
      }
    }
    if (missing.length === 0) return byReply;

    try {
      const sdk = await getEvoSdk();
      for (const batch of chunk(missing, REPLY_TIP_BATCH)) {
        const response = await sdk.documents.query({
          dataContractId: YAPPR_CONTRACT_ID,
          documentTypeName: surface.docType,
          where: [[surface.tippedField, 'in', batch]] as DocumentWhereClause[],
          orderBy: [[surface.tippedField, 'asc']] as DocumentOrderByClause[],
          limit: TIP_PAGE_SIZE,
        });
        const found = new Map<string, ProvedTip[]>();
        for (const doc of normalizeSDKResponse(response)) {
          const tip = toProvedTip(doc, surface.tippedField);
          if (!tip) continue;
          const existing = found.get(tip.tippedId);
          if (existing) existing.push(tip);
          else found.set(tip.tippedId, [tip]);
        }
        // Cache the empties too — "this reply has no tips" is the common answer
        // and worth not asking again on every scroll.
        for (const replyId of batch) {
          const tips = found.get(replyId) ?? [];
          this.tips.set(`${surface.docType}:${replyId}`, tips);
          if (tips.length > 0) byReply.set(replyId, tips);
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
