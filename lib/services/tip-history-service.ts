/**
 * Proved tips, read from the SYSTEM token-history contract.
 *
 * YAPP sets `keepsTransferHistory`, so Platform writes a `transfer` document
 * for every YAPP transfer: `$ownerId` is the sender, `toIdentityId` the
 * recipient, `amount` the exact number of tokens, `publicNote` whatever the
 * sender signed. The document exists because the transfer happened and cannot
 * be edited or deleted (`documentsMutable: false`, `canBeDeleted: false`).
 *
 * What that proves and what it does not is spelled out in docs/TIPS_YAPP.md;
 * the short version is that the amount, the sender and the recipient are
 * consensus facts, while the link to a post is only the sender's own claim in
 * `publicNote`.
 *
 * The contract is a system contract: it has no count/sum trees (aggregates are
 * not available), so every read here is a bounded page over an index, newest
 * first, and the UI says so.
 */

import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { parseTipNote, type TipTargetKind } from '@/lib/tip-note';
import { TOKEN_HISTORY_CONTRACT_ID } from '../constants';
import { getEvoSdk } from './evo-sdk-service';
import { tokenService } from './token-service';
import { identifierToBase58, normalizeSDKResponse, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers';

const TRANSFER_DOC_TYPE = 'transfer';
const CACHE_TTL_MS = 60 * 1000;

/** Hard page cap. The history contract has no count trees, so totals are "over the last N". */
export const TIP_PAGE_LIMIT = 100;

/** One proved YAPP transfer. */
export interface ProvedTip {
  /** Token-history document id — the on-chain handle for this proof. */
  id: string;
  /** Exact tokens transferred, as recorded by consensus. */
  amount: bigint;
  /** Sender identity ($ownerId of the transfer document). */
  from: string;
  /** Recipient identity (toIdentityId). */
  to: string;
  createdAt: Date;
  /** Base58 id of the post or reply the SENDER said this was for, when their note says so. */
  postId?: string;
  targetKind?: TipTargetKind;
  /** Free text the sender signed with the transfer. */
  message?: string;
}

/** Sum of a tip page — "N YAPP over these M transfers", never a global total. */
export function totalTipped(tips: ProvedTip[]): bigint {
  return tips.reduce((sum, tip) => sum + tip.amount, BigInt(0));
}

/** What a just-sent tip should look like on chain, for confirming it landed. */
export interface SentTipMatch {
  to: string;
  amount: bigint;
  /** The tipped post/reply, when the tip named one. */
  postId?: string;
  message?: string;
  /** Only count transfers created at or after this epoch-ms. */
  since?: number;
}

/**
 * Whether `tip` is the transfer described by `match`.
 *
 * Every field the tipper chose is compared, not just the amount: two tips of
 * the same size to the same author inside the same window are otherwise
 * indistinguishable, and mistaking an older one for the new one would report a
 * tip as landed that never did.
 */
export function matchesSentTip(tip: ProvedTip, match: SentTipMatch): boolean {
  return (
    tip.to === match.to &&
    tip.amount === match.amount &&
    (tip.postId ?? '') === (match.postId ?? '') &&
    (tip.message ?? '') === (match.message ?? '') &&
    (match.since === undefined || tip.createdAt.getTime() >= match.since)
  );
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return BigInt(0);
}

/** A raw `transfer` document → ProvedTip, or null when it is not readable as one. */
function toProvedTip(doc: Record<string, unknown>): ProvedTip | null {
  const id = typeof doc.$id === 'string' ? doc.$id : identifierToBase58(doc.$id);
  const from = typeof doc.$ownerId === 'string' ? doc.$ownerId : identifierToBase58(doc.$ownerId);
  const to = identifierToBase58(doc.toIdentityId);
  if (!id || !from || !to) return null;

  const note = parseTipNote(doc.publicNote);
  const createdAt = new Date(Number(doc.$createdAt ?? 0));

  return {
    id,
    amount: toBigInt(doc.amount),
    from,
    to,
    createdAt: Number.isFinite(createdAt.getTime()) ? createdAt : new Date(0),
    ...(note ? { postId: note.targetId, targetKind: note.kind } : {}),
    ...(note?.message ? { message: note.message } : {}),
  };
}

class TipHistoryService {
  private readonly cache = new TtlMap<string, ProvedTip[]>(CACHE_TTL_MS);

  /** Drop every cached page (call right after a tip is known to have landed). */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * One page of `transfer` documents off a token-history index, newest first.
   * `extraWhere` narrows within the token (the `from` / `to` index tails).
   */
  private async queryTransfers(
    cacheKey: string,
    extraWhere: DocumentWhereClause[],
    orderFields: string[],
    fresh = false
  ): Promise<ProvedTip[]> {
    const cached = fresh ? undefined : this.cache.get(cacheKey);
    if (cached) return cached;

    const [sdk, tokenId] = await Promise.all([getEvoSdk(), tokenService.getTokenId()]);
    // Every index on `transfer` is prefixed by tokenId, and orderBy has to name
    // the index fields in order — including the equality-constrained ones.
    const orderBy = [
      ...orderFields.map((field): DocumentOrderByClause => [field, 'asc']),
      ['$createdAt', 'desc'] as DocumentOrderByClause,
    ];

    const response = await sdk.documents.query({
      dataContractId: TOKEN_HISTORY_CONTRACT_ID,
      documentTypeName: TRANSFER_DOC_TYPE,
      where: [['tokenId', '==', tokenId] as DocumentWhereClause, ...extraWhere],
      orderBy,
      limit: TIP_PAGE_LIMIT,
    });

    const tips = normalizeSDKResponse(response)
      .map(toProvedTip)
      .filter((tip): tip is ProvedTip => tip !== null);
    this.cache.set(cacheKey, tips);
    return tips;
  }

  /**
   * Proved tips the sender attributed to `postId`.
   *
   * There is no index on `publicNote`, so this reads the recipient's newest
   * `TIP_PAGE_LIMIT` incoming YAPP transfers off the `to` index and keeps the
   * ones whose note names this post. A very heavily tipped author can
   * therefore have older tips fall off the page — the UI labels the figure as
   * "recent", it is never presented as a lifetime total.
   *
   * @param postId - The tipped post or reply
   * @param authorId - Its author; tips are transfers TO them
   */
  async getTipsForPost(postId: string, authorId: string): Promise<ProvedTip[]> {
    if (!postId || !authorId) return [];
    try {
      const received = await this.getTipsReceived(authorId);
      return received.filter((tip) => tip.postId === postId);
    } catch (error) {
      logger.warn(`tipHistory: tips for post ${postId} failed`, error);
      return [];
    }
  }

  /** The identity's newest incoming YAPP transfers (tip-noted or not). */
  async getTipsReceived(identityId: string): Promise<ProvedTip[]> {
    if (!identityId) return [];
    return this.queryTransfers(
      `to:${identityId}`,
      [['toIdentityId', '==', identityId]],
      ['tokenId', 'toIdentityId']
    );
  }

  /**
   * The identity's newest outgoing YAPP transfers.
   *
   * `fresh` bypasses the TTL cache — used while polling for a wallet-signed
   * tip to land, where a 60s-stale page would read as "not sent yet".
   */
  async getTipsSent(identityId: string, { fresh = false } = {}): Promise<ProvedTip[]> {
    if (!identityId) return [];
    return this.queryTransfers(
      `from:${identityId}`,
      [['$ownerId', '==', identityId]],
      ['tokenId', '$ownerId'],
      fresh
    );
  }

  /**
   * Poll the sender's own transfers until `match` shows up, or give up.
   *
   * This is how a tip is confirmed rather than assumed. DAPI's
   * `wait_for_state_transition_result` routinely 504s on transitions that
   * landed (see CLAUDE.md), so "the SDK threw" is not evidence the tip failed
   * — and telling a user it failed invites them to send a second one. Asking
   * the chain for the proof settles it either way.
   */
  async awaitSentTip(
    senderId: string,
    match: SentTipMatch,
    { attempts = 5, delayMs = 3000 } = {}
  ): Promise<ProvedTip | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const sent = await this.getTipsSent(senderId, { fresh: true });
        const found = sent.find((tip) => matchesSentTip(tip, match));
        if (found) return found;
      } catch (error) {
        logger.debug('tipHistory: confirmation poll failed, retrying', error);
      }
    }
    return null;
  }
}

export const tipHistoryService = new TipHistoryService();
