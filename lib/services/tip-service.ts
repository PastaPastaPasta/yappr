import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { identityService } from './identity-service';
import { signerService } from './signer-service';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose } from '@/lib/crypto/identity-keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { CREDITS_PER_DASH, keyNetwork, MIN_YAPP_TIP } from '@/lib/constants'
import { encodeTipNote, type TipTargetKind } from '@/lib/tip-note'
import { yappIsLocked } from '@/lib/contract-topology'
import { extractErrorMessage, isAlreadyExistsError, isIdentityNonceConflictError, isNonFatalWaitError, isOutcomeUnknownError, sentWriteOutcomeUnknown } from '@/lib/error-utils'
import { tokenService } from './token-service'
import { tipHistoryService, type SentTipMatch } from './tip-history-service'
import { nonceSequence } from '@/lib/document-id'

export interface TipResult {
  success: boolean;
  transactionHash?: string;
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
     * The transfer was broadcast, the confirmation wait failed (a timeout, or
     * a result proof that could not be checked during a quorum rotation), and
     * the chain did not show it within the confirmation window. The tip may
     * still land — the UI must offer "check again", never a blind retry, or the
     * user sends their money twice.
     */
    | 'UNCONFIRMED';
}

/** A credit tip that was sent but not confirmed: only the sender's balance can show it landed. */
const CREDIT_TIP_UNCONFIRMED = "Your tip was sent but we couldn't confirm it landed. Check your balance before sending another — it may still be settling."

/** What a credit tip changes on chain (see TipService.creditTipWitness). */
interface CreditTipWitness {
  nonce: bigint
  sender: bigint
  recipient: bigint
}

/**
 * Proved balance reads, 3 s apart, that look for a sent credit tip. Each read
 * itself rides out a quorum rotation (`lib/services/sdk-read-retry.ts`).
 */
const CREDIT_TIP_CHECKS = 3
const CREDIT_TIP_CHECK_MS = 3_000

/** How far behind this clock the chain's block time may sit for a just-sent tip to still match. */
const SENT_TIP_SKEW_MARGIN_MS = 60_000;

// Conversion: 1 DASH = 100,000,000,000 credits on Dash Platform
// (Platform credits are different from core duffs)
export { CREDITS_PER_DASH };
export const MIN_TIP_CREDITS = 100_000_000; // 0.001 DASH minimum

class TipService {
  /**
   * The enabled transfer key the private key corresponds to, so signer and key
   * can never disagree. `specificKeyId` pins the match to one key.
   */
  private findMatchingTransferKey(
    privateKeyWif: string,
    wasmPublicKeys: WasmIdentityPublicKey[],
    specificKeyId?: number
  ): WasmIdentityPublicKey | null {
    const result = matchIdentityKey(privateKeyWif, wasmPublicKeys, {
      network: keyNetwork(),
      purpose: KeyPurpose.TRANSFER,
      keyId: specificKeyId,
    });
    if (!result.ok) {
      if (result.reason === 'wrong-key-id') {
        logger.error(`Requested key ID ${specificKeyId} but private key matches key ID ${result.match.keyId}`);
      } else {
        logger.error('Transfer private key does not match any transfer key on this identity');
      }
      return null;
    }
    logger.debug(`Matched transfer key: id=${result.match.keyId}`);
    return result.key;
  }

  /**
   * Send a DASH **credit** tip to another identity.
   *
   * A credit transfer leaves no readable document behind — the SDK returns no
   * transition id and nothing on chain says who was tipped for what — so this
   * path is unprovable by construction and is kept only as the plain
   * "send someone DASH" option. Nothing is announced on the user's behalf; a
   * tip that Yappr can display is a YAPP tip (`sendYappTipLocal`).
   *
   * @param senderId - The sender's identity ID
   * @param recipientId - The recipient's identity ID
   * @param amountCredits - Amount in credits
   * @param transferKeyWif - The sender's transfer private key in WIF format
   * @param keyId - Optional key ID to use (if identity has multiple transfer keys)
   */
  async sendTip(
    senderId: string,
    recipientId: string,
    amountCredits: number,
    transferKeyWif: string,
    keyId?: number
  ): Promise<TipResult> {
    // Validation: prevent self-tipping
    if (senderId === recipientId) {
      return { success: false, error: 'Cannot tip yourself', errorCode: 'SELF_TIP' };
    }

    // Validation: minimum amount
    if (amountCredits < MIN_TIP_CREDITS) {
      return {
        success: false,
        error: `Minimum tip is ${this.formatDash(this.creditsToDash(MIN_TIP_CREDITS))}`,
        errorCode: 'INVALID_AMOUNT'
      };
    }

    // Validation: transfer key provided
    if (!transferKeyWif || transferKeyWif.trim().length === 0) {
      return { success: false, error: 'Transfer key is required', errorCode: 'INVALID_KEY' };
    }

    // Set once the transfer is handed to the SDK: an error before that sent nothing.
    let sent = false;
    let confirmedBalance: number | null = null;
    // The chain before the send, to recognise this tip by if its outcome is unknown.
    let before: CreditTipWitness | null = null;
    try {
      // Check sender balance. If the balance fetch itself fails, don't treat
      // that as "0 credits" — skip the pre-check and let the transfer be the
      // authority (the chain rejects underfunded transfers anyway).
      try {
        identityService.clearCache(senderId);
        confirmedBalance = (await identityService.getBalance(senderId)).confirmed;
      } catch (error) {
        logger.warn('Could not fetch balance before tip; proceeding without pre-check:', error);
      }
      if (confirmedBalance !== null && confirmedBalance < amountCredits) {
        return {
          success: false,
          error: `Insufficient balance. You have ${this.formatDash(this.creditsToDash(confirmedBalance))}.`,
          errorCode: 'INSUFFICIENT_BALANCE'
        };
      }

      const sdk = await getEvoSdk();

      // Fetch sender identity WASM object
      const identity = await sdk.identities.fetch(senderId);
      if (!identity) {
        return {
          success: false,
          error: 'Sender identity not found',
          errorCode: 'NETWORK_ERROR'
        };
      }

      // Get WASM public keys and find the transfer key that matches the private key
      const wasmPublicKeys = identity.publicKeys;
      const transferKey = this.findMatchingTransferKey(transferKeyWif.trim(), wasmPublicKeys, keyId);
      if (!transferKey) {
        return {
          success: false,
          error: 'No matching transfer key found. The provided private key does not match any transfer key on this identity.',
          errorCode: 'INVALID_KEY'
        };
      }

      // Log transfer details
      logger.debug('Transfer args:', JSON.stringify({
        senderId,
        recipientId,
        amount: amountCredits.toString(),
        keyId: transferKey.keyId
      }, null, 2));

      // Create signer with the transfer key
      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        transferKeyWif.trim(),
        transferKey
      );

      logger.debug('Calling sdk.identities.creditTransfer...');
      // Cast needed: SDK has duplicate IdentityCreditTransferOptions interfaces that get merged.
      // The high-level facade only needs { identity, recipientId, amount, signer, signingKey? }.
      before = await this.creditTipWitness(senderId, recipientId);

      sent = true;
      const result = await sdk.identities.creditTransfer({
        identity,
        recipientId,
        amount: BigInt(amountCredits),
        signer,
        signingKey
      } as Parameters<typeof sdk.identities.creditTransfer>[0]);

      // Clear sender's balance cache so it refreshes
      identityService.clearCache(senderId);

      logger.debug('Tip transfer result:', result);

      return {
        success: true,
        // TODO: Return actual transaction hash once SDK exposes it
        transactionHash: 'confirmed',
      };

    } catch (error) {
      logger.error('Tip transfer error:', error);
      const errorMessage = extractErrorMessage(error);

      // Sent, and no verdict came back: a DAPI 504 or timeout on the wait, a
      // result proof that could not be checked (a quorum rotation), a transport
      // failure. It may well have landed, and nothing here may invite a second
      // send (or call it a key problem: "quorum key unavailable" mentions a
      // key). Only the sender's balance can show it, so ask it.
      if (sent && sentWriteOutcomeUnknown(error)) {
        identityService.clearCache(senderId);
        // A nonce refusal can mean another device's transfer took this nonce:
        // the sender's state would then show THAT spend, so it proves nothing here.
        if (before && !isIdentityNonceConflictError(error) && await this.creditTipLanded(senderId, recipientId, before, amountCredits)) {
          return { success: true, transactionHash: 'confirmed' };
        }
        return { success: false, error: CREDIT_TIP_UNCONFIRMED, errorCode: 'UNCONFIRMED' };
      }

      // Check for invalid key errors - match various SDK error patterns
      const lowerError = errorMessage.toLowerCase();
      if (
        lowerError.includes('private') ||
        lowerError.includes('key') ||
        lowerError.includes('signature') ||
        lowerError.includes('wif') ||
        lowerError.includes('invalid') ||
        lowerError.includes('mismatch') ||
        lowerError.includes('security') ||
        lowerError.includes('authentication') ||
        lowerError.includes('verify')
      ) {
        return {
          success: false,
          error: 'Invalid transfer key. The key you provided does not match this identity.',
          errorCode: 'INVALID_KEY'
        };
      }

      return {
        success: false,
        error: `Transfer failed: ${errorMessage}`,
        errorCode: 'NETWORK_ERROR'
      };
    }
  }

  /**
   * The proved state a credit tip changes: the sequence of the sender's
   * identity nonce (a credit transfer advances it, document writes do not)
   * and both balances. Null when any read fails: the tip can then never be
   * confirmed, only reported unconfirmed.
   */
  private async creditTipWitness(senderId: string, recipientId: string): Promise<CreditTipWitness | null> {
    try {
      const sdk = await getEvoSdk();
      const [nonce, sender, recipient] = await Promise.all([
        sdk.identities.nonce(senderId),
        sdk.identities.balance(senderId),
        sdk.identities.balance(recipientId),
      ]);
      if (typeof sender !== 'bigint' || typeof recipient !== 'bigint') return null;
      return { nonce: nonceSequence(nonce), sender, recipient };
    } catch (error) {
      logger.warn('Credit tip: could not read the chain state to confirm it by:', extractErrorMessage(error));
      return null;
    }
  }

  /**
   * Whether the chain shows THIS credit tip landed: since `before`, exactly
   * one identity-nonce transition by the sender, the sender's balance fell by
   * at least the amount (the transfer plus its fee) and the recipient's rose
   * by exactly the amount. A credit transfer leaves no document to read back,
   * so these are the witnesses; any other spend or receipt in the window
   * breaks the exact match and leaves it unconfirmed. The one case they
   * cannot tell apart, an identical tip from another device taking the same
   * nonce, means ours can never execute and the recipient was paid exactly
   * once. False (never a verdict that it failed) when they do not all show
   * within a few reads.
   */
  private async creditTipLanded(senderId: string, recipientId: string, before: CreditTipWitness, amountCredits: number): Promise<boolean> {
    const amount = BigInt(amountCredits);
    for (let check = 0; check < CREDIT_TIP_CHECKS; check++) {
      if (check > 0) await new Promise((resolve) => setTimeout(resolve, CREDIT_TIP_CHECK_MS));
      const now = await this.creditTipWitness(senderId, recipientId);
      if (now && now.nonce === before.nonce + BigInt(1) && now.sender <= before.sender - amount && now.recipient === before.recipient + amount) return true;
    }
    return false;
  }

  /**
   * Send a **YAPP** tip, signing locally with a CRITICAL key.
   *
   * This is the provable path: Platform records the transfer in the system
   * token-history contract with the exact amount, the sender and the
   * recipient, plus the `publicNote` this builds — so the badge Yappr renders
   * is read back off chain rather than taken on the tipper's word.
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
      if (result.errorCode === 'UNCONFIRMED' || (result.errorCode === 'NETWORK_ERROR' && this.looksUnconfirmed(result.error))) {
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
    return { success: true, transactionHash: 'confirmed' };
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
    if (landed) return { success: true, transactionHash: 'confirmed' };
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
      isOutcomeUnknownError(error) ||
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

  /**
   * Shared pre-flight for both YAPP tip paths (local signing and wallet
   * signing). Where YAPP is locked (v10) nothing can be transferred, so every
   * YAPP tip is refused here and tips go out as credit transfers.
   */
  validateYappTip(senderId: string, recipientId: string, amount: bigint): TipResult | null {
    if (yappIsLocked()) {
      return { success: false, error: 'YAPP cannot be transferred on this network. Tip in DASH instead.', errorCode: 'NOT_AUTHORIZED' };
    }
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
   * Convert Dash amount to credits
   */
  dashToCredits(dashAmount: number): number {
    return Math.floor(dashAmount * CREDITS_PER_DASH);
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
