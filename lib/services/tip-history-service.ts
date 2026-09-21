/**
 * The sender's own YAPP transfers, read from the SYSTEM token-history contract.
 *
 * YAPP sets `keepsTransferHistory`, so Platform writes a `transfer` document
 * for every YAPP transfer: `$ownerId` is the sender, `toIdentityId` the
 * recipient, `amount` the exact number of tokens, `publicNote` whatever the
 * sender signed. The document exists because the transfer happened and cannot
 * be edited or deleted (`documentsMutable: false`, `canBeDeleted: false`).
 *
 * What that proves and what it does not is spelled out in docs/NON_SOCIAL_CONTRACTS.md;
 * the short version is that the amount, the sender and the recipient are
 * consensus facts, while the link to a post is only the sender's own claim in
 * `publicNote`.
 *
 * This is NOT how tips are displayed. A tip on a post is a `tip` document on
 * the social contract citing one of these transfers by id, and consensus checks
 * the citation (lib/services/proved-tip-service.ts) — no reader ever has to
 * find a transfer to render a tip.
 *
 * What is left here is the one job that genuinely belongs to transfer history:
 * a sender looking up their OWN just-sent transfer, to learn its document id
 * and to prove to themselves that it landed. That is a bounded page over one
 * identity's own index, not a scan of someone else's incoming payments.
 */

import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { parseTipNote, type TipTargetKind } from '@/lib/tip-note';
import { TOKEN_HISTORY_CONTRACT_ID } from '../constants';
import { getEvoSdk } from './evo-sdk-service';
import { tokenService } from './token-service';
import { documentBigInt, documentCreatedAt, identifierToBase58, normalizeSDKResponse, systemIdentifier, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers';

const TRANSFER_DOC_TYPE = 'transfer';
const CACHE_TTL_MS = 60 * 1000;

/** Hard page cap on the sender's own newest transfers. */
const SENT_PAGE_LIMIT = 100;

/** One YAPP transfer the sender made, as Platform recorded it. */
export interface SentTransfer {
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
export function matchesSentTip(tip: SentTransfer, match: SentTipMatch): boolean {
  return (
    tip.to === match.to &&
    tip.amount === match.amount &&
    (tip.postId ?? '') === (match.postId ?? '') &&
    (tip.message ?? '') === (match.message ?? '') &&
    (match.since === undefined || tip.createdAt.getTime() >= match.since)
  );
}

/** A raw `transfer` document → SentTransfer, or null when it is not readable as one. */
function toSentTransfer(doc: Record<string, unknown>): SentTransfer | null {
  const id = systemIdentifier(doc.$id);
  const from = systemIdentifier(doc.$ownerId);
  const to = identifierToBase58(doc.toIdentityId);
  if (!id || !from || !to) return null;

  const note = parseTipNote(doc.publicNote);

  return {
    id,
    amount: documentBigInt(doc.amount),
    from,
    to,
    createdAt: documentCreatedAt(doc.$createdAt),
    ...(note ? { postId: note.targetId, targetKind: note.kind } : {}),
    ...(note?.message ? { message: note.message } : {}),
  };
}

class TipHistoryService {
  private readonly cache = new TtlMap<string, SentTransfer[]>(CACHE_TTL_MS);

  /** Drop every cached page (call right after a transfer is known to have landed). */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * The identity's newest outgoing YAPP transfers, newest first.
   *
   * Every index on `transfer` is prefixed by `tokenId`, and `orderBy` has to
   * name the index fields in order including the equality-constrained ones, so
   * the two clauses below are one shape and have to stay that way.
   *
   * `fresh` bypasses the TTL cache — used while polling for a wallet-signed tip
   * to land, where a 60s-stale page would read as "not sent yet".
   */
  async getTipsSent(identityId: string, { fresh = false } = {}): Promise<SentTransfer[]> {
    if (!identityId) return [];
    const cacheKey = `$ownerId:${identityId}`;
    const cached = fresh ? undefined : this.cache.get(cacheKey);
    if (cached) return cached;

    const [sdk, tokenId] = await Promise.all([getEvoSdk(), tokenService.getTokenId()]);

    const response = await sdk.documents.query({
      dataContractId: TOKEN_HISTORY_CONTRACT_ID,
      documentTypeName: TRANSFER_DOC_TYPE,
      where: [
        ['tokenId', '==', tokenId],
        ['$ownerId', '==', identityId],
      ] as DocumentWhereClause[],
      orderBy: [
        ['tokenId', 'asc'],
        ['$ownerId', 'asc'],
        ['$createdAt', 'desc'],
      ] as DocumentOrderByClause[],
      limit: SENT_PAGE_LIMIT,
    });

    const transfers = normalizeSDKResponse(response)
      .map(toSentTransfer)
      .filter((transfer): transfer is SentTransfer => transfer !== null);
    this.cache.set(cacheKey, transfers);
    return transfers;
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
  ): Promise<SentTransfer | null> {
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
