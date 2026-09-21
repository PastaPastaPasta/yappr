import { logger } from '@/lib/logger';
import { MIN_YAPP_TIP, YAPPR_CONTRACT_ID } from '@/lib/constants'
import { encodeTipNote, type TipTargetKind } from '@/lib/tip-note'
import { isAlreadyExistsError, isNonFatalWaitError, isTimeoutError } from '@/lib/error-utils'
import { tipSurfaceFor, provedTipsAvailable } from '@/lib/contract-topology'
import { tokenService } from './token-service'
import { stateTransitionService } from './state-transition-service'
import { identifierStringToDocumentBytes } from './sdk-helpers'
import { provedTipService } from './proved-tip-service'
import { tipHistoryService, type SentTipMatch } from './tip-history-service'

export interface TipResult {
  success: boolean;
  transactionHash?: string;
  /**
   * The token-history `transfer` document this tip was paid with, once it has
   * been seen on chain. A successful transfer whose document has not surfaced
   * yet leaves this unset: the money moved, but the tip cannot be recorded
   * against the post until the citation would resolve (40120 otherwise), so the
   * caller offers to attach it rather than pretending it failed.
   */
  transferId?: string;
  error?: string;
  errorCode?:
    | 'INSUFFICIENT_BALANCE'
    | 'INSUFFICIENT_CREDITS'
    | 'SELF_TIP'
    | 'NETWORK_ERROR'
    | 'NOT_AUTHORIZED'
    | 'INVALID_AMOUNT'
    | 'INVALID_KEY'
    | 'BELOW_MINIMUM'
    | 'ALREADY_CLAIMED'
    | 'NEEDS_CRITICAL_KEY'
    /**
     * The transfer was broadcast, the confirmation wait failed, and no matching
     * transfer document turned up within the confirmation window. The tip may
     * still land — the UI must offer "check again", never a blind retry, or the
     * user sends their money twice.
     */
    | 'UNCONFIRMED';
}

/** How far behind this clock the chain's block time may sit for a just-sent tip to still match. */
const SENT_TIP_SKEW_MARGIN_MS = 60_000;

// Conversion: 1 DASH = 100,000,000,000 credits on Dash Platform
// (Platform credits are different from core duffs)
export const CREDITS_PER_DASH = 100_000_000_000;

/**
 * What the tip document records, once the transfer it cites is on chain.
 *
 * Every field is checked by consensus against the cited transfer and the
 * tipped document when the tip is written, so a rejected `recordTip` means the
 * claim was false — never that the money did not move.
 */
export interface TipRecord {
  /** The tipper. */
  senderId: string;
  /** What was tipped, and which of the two tip doctypes that puts it in. */
  target: { kind: TipTargetKind; id: string };
  /** The tipped document's author, who received the transfer. */
  recipientId: string;
  amount: bigint;
  /** The token-history transfer document that paid it. */
  transferId: string;
  /** The tipper's own reply carrying the words that went with the tip, if any. */
  messageReplyId?: string;
}

class TipService {
  /**
   * Send a **YAPP** tip, signing locally with a CRITICAL key.
   *
   * This is the provable path: Platform records the transfer in the system
   * token-history contract with the exact amount, the sender and the
   * recipient, and this returns that transfer document's id so
   * {@link recordTip} can cite it. The citation is what ties the payment to a
   * post — consensus checks it — and the `publicNote` written here is only so
   * the transfer reads as a tip in a wallet that knows nothing about Yappr.
   *
   * Every batch carrying a token transition needs a CRITICAL authentication
   * key. Wallet-login users don't have one in the browser: they get
   * NEEDS_CRITICAL_KEY here, and the caller hands
   * `buildUnsignedYappTipTransition` to their wallet instead.
   *
   * @param senderId - The tipper
   * @param recipientId - The tipped author
   * @param amount - Whole YAPP tokens
   * @param target - The tipped post/reply the note should name, if any
   * @param message - Optional text signed with the transfer
   * @param criticalKeyWif - A CRITICAL key the user just entered (never stored)
   */
  async sendYappTipLocal(
    senderId: string,
    recipientId: string,
    amount: bigint,
    target?: { kind: TipTargetKind; id: string },
    message?: string,
    criticalKeyWif?: string
  ): Promise<TipResult> {
    const invalid = this.validateYappTip(senderId, recipientId, amount);
    if (invalid) return invalid;

    // Taken BEFORE the broadcast so the confirmation match can floor on it: an
    // identical earlier tip to the same author must not pass for this one. The
    // margin absorbs skew between this clock and the chain's block time; a tip
    // that lands "before" the floor anyway is still found by the modal's
    // floor-less "check again".
    const sentAt = Date.now() - SENT_TIP_SKEW_MARGIN_MS;
    const result = await tokenService.transfer(
      senderId,
      recipientId,
      amount,
      this.tipNoteFor(target, message),
      criticalKeyWif
    );
    if (!result.success) {
      // A failed CONFIRMATION is not a failed transfer: DAPI 504s on
      // `wait_for_state_transition_result` for transitions that landed, and
      // "already in mempool/chain" means the broadcast went through before. Ask
      // the chain instead of guessing — reporting failure here would put a
      // "Try Again" button in front of a tip that already went out.
      if (result.errorCode === 'NETWORK_ERROR' && this.looksUnconfirmed(result.error)) {
        return this.confirmYappTip(senderId, this.tipMatch(recipientId, amount, target, message, sentAt));
      }
      return {
        success: false,
        error: result.error ?? 'Tip failed',
        errorCode: result.errorCode ?? 'NETWORK_ERROR',
      };
    }

    // The transfer document appears a block or two later; drop the cached
    // pages so the next read can pick it up instead of serving a stale page.
    tipHistoryService.clearCache();

    // Find the transfer document itself. Two things ride on this: it is the id
    // the tip document has to cite, and it is the only evidence the transfer
    // really landed — the SDK returning success is not the same as the
    // transfer being readable, and a tip citing a transfer Drive cannot yet
    // see is a paid 40120.
    const landed = await tipHistoryService.awaitSentTip(
      senderId,
      this.tipMatch(recipientId, amount, target, message, sentAt)
    );
    return { success: true, transactionHash: 'confirmed', transferId: landed?.id };
  }

  /**
   * Record a confirmed transfer as a tip on the post or reply it paid for.
   *
   * The tip document names the transfer, and the contract binds what it says
   * about it: the writer must be the transfer's sender, `amount` must equal the
   * transfer's amount, and `recipientId` must be both the transfer's recipient
   * and the tipped document's author. So there is nothing to verify on read —
   * and nothing here can make a tip look bigger, or aimed at someone else, than
   * it was.
   *
   * Safe to retry: the unique index on `transferId` means a second attempt for
   * a tip that already landed is refused rather than double-counted.
   */
  async recordTip(record: TipRecord): Promise<TipResult> {
    const surface = tipSurfaceFor(record.target.kind);
    if (!surface) {
      return {
        success: false,
        error: 'This deployment\'s contract has no tip documents',
        errorCode: 'NOT_AUTHORIZED',
      };
    }

    try {
      const result = await stateTransitionService.createDocument(
        YAPPR_CONTRACT_ID,
        surface.docType,
        record.senderId,
        {
          transferId: identifierStringToDocumentBytes(record.transferId),
          // A plain number, like every other integer property the client
          // writes. YAPP has no decimals and a supply of 1e6, so the whole
          // token amount is nowhere near the exact-integer limit — and if it
          // ever were, consensus would reject the mismatch against the
          // transfer rather than record a rounded tip.
          amount: Number(record.amount),
          recipientId: identifierStringToDocumentBytes(record.recipientId),
          [surface.tippedField]: identifierStringToDocumentBytes(record.target.id),
          ...(record.messageReplyId
            ? { messageReplyId: identifierStringToDocumentBytes(record.messageReplyId) }
            : {}),
        }
      );
      if (!result.success) {
        return { success: false, error: result.error ?? 'Could not record the tip', errorCode: 'NETWORK_ERROR' };
      }
      provedTipService.clearCache();
      return { success: true, transactionHash: 'confirmed', transferId: record.transferId };
    } catch (error) {
      logger.error('Failed to record a tip document', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Could not record the tip',
        errorCode: 'NETWORK_ERROR',
      };
    }
  }

  /** True when this deployment can show a tip on the post it was for. */
  tipsAreRecordable(): boolean {
    return provedTipsAvailable();
  }

  /**
   * What the tip just sent should look like on chain. Shared by the local
   * path's confirmation and the wallet path's landing check so the two can
   * never disagree about which transfer counts as "this tip".
   */
  tipMatch(
    recipientId: string,
    amount: bigint,
    target?: { kind: TipTargetKind; id: string },
    message?: string,
    since?: number
  ): SentTipMatch {
    return {
      to: recipientId,
      amount,
      postId: target?.id,
      // A profile tip's note is the bare message, which never parses as a tip
      // note, so the proved row carries no message to compare against.
      message: target ? message?.trim() || undefined : undefined,
      since,
    };
  }

  /**
   * Look for the proof of a tip whose broadcast could not be confirmed.
   * Success only when the transfer document is actually found.
   */
  async confirmYappTip(senderId: string, match: SentTipMatch): Promise<TipResult> {
    const landed = await tipHistoryService.awaitSentTip(senderId, match);
    tipHistoryService.clearCache();
    if (landed) return { success: true, transactionHash: 'confirmed', transferId: landed.id };
    return {
      success: false,
      error: "Your tip was sent but we couldn't confirm it landed. Check again before sending another — it may still be settling.",
      errorCode: 'UNCONFIRMED',
    };
  }

  /**
   * Whether a failure is a confirmation-wait problem rather than a rejection.
   * "Already in mempool / already in chain / nonce already present" belong
   * here too: they are what a transfer that DID land looks like on a retry.
   */
  private looksUnconfirmed(error?: string): boolean {
    if (!error) return false;
    return (
      isTimeoutError(error) ||
      isNonFatalWaitError(error) ||
      isAlreadyExistsError(error) ||
      /504|gateway|wait_for_state_transition_result/i.test(error)
    );
  }

  /**
   * The `publicNote` for a tip: the encoded target when one is known, the bare
   * message when the tip is aimed at a profile rather than a post, and nothing
   * at all when there is neither.
   */
  tipNoteFor(target?: { kind: TipTargetKind; id: string }, message?: string): string | undefined {
    if (target) return encodeTipNote(target.kind, target.id, message);
    const trimmed = message?.trim();
    return trimmed ? trimmed : undefined;
  }

  /** Shared pre-flight for both YAPP tip paths (local signing and wallet signing). */
  validateYappTip(senderId: string, recipientId: string, amount: bigint): TipResult | null {
    if (senderId === recipientId) {
      return { success: false, error: 'Cannot tip yourself', errorCode: 'SELF_TIP' };
    }
    if (amount < MIN_YAPP_TIP) {
      return {
        success: false,
        error: `Minimum tip is ${MIN_YAPP_TIP} YAPP`,
        errorCode: 'INVALID_AMOUNT',
      };
    }
    return null;
  }

  /**
   * Convert credits to Dash
   */
  creditsToDash(credits: number): number {
    return credits / CREDITS_PER_DASH;
  }

  /**
   * Format Dash amount for display
   */
  formatDash(dash: number): string {
    if (dash < 0.0001) {
      return `${(dash * CREDITS_PER_DASH).toFixed(0)} credits`;
    }
    return `${dash.toFixed(4)} DASH`;
  }

}

export const tipService = new TipService();
