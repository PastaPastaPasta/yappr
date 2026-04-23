import { logger } from '@/lib/logger';
import { identityService } from './identity-service';
import { creditTransferService } from './credit-transfer-service';
import { TipInfo } from '../../types';

export interface TipResult {
  success: boolean
  transactionHash?: string
  receiptId?: string
  verificationStatus?: 'verified' | 'pending'
  error?: string
  errorCode?: 'INSUFFICIENT_BALANCE' | 'SELF_TIP' | 'NETWORK_ERROR' | 'INVALID_AMOUNT' | 'INVALID_KEY'
}

// Legacy format: tip:CREDITS\nmessage
const LEGACY_TIP_CONTENT_REGEX = /^tip:(\d+)(?:\n([\s\S]*))?$/
// Verified format: tip:CREDITS@RECEIPT_ID\nmessage
const RECEIPT_TIP_CONTENT_REGEX = /^tip:(\d+)@([^\n]+?)(?:\n([\s\S]*))?$/

// Conversion: 1 DASH = 100,000,000,000 credits on Dash Platform
// (Platform credits are different from core duffs)
export const CREDITS_PER_DASH = 100_000_000_000;
export const MIN_TIP_CREDITS = 100_000_000; // 0.001 DASH minimum

class TipService {
  /**
   * Send a tip (credit transfer) to another user and optionally create a tip post
   * @param senderId - The sender's identity ID
   * @param recipientId - The recipient's identity ID (post author or user being tipped)
   * @param postId - The post being tipped (optional - when null, no tip post is created)
   * @param amountCredits - Amount in credits
   * @param transferKeyWif - The sender's transfer private key in WIF format
   * @param message - Optional tip message
   * @param keyId - Optional key ID to use (if identity has multiple keys)
   */
  async sendTip(
    senderId: string,
    recipientId: string,
    postId: string | null,
    amountCredits: number,
    transferKeyWif: string,
    message?: string,
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

    try {
      // Check sender balance
      const balance = await identityService.getBalance(senderId);
      if (balance.confirmed < amountCredits) {
        return {
          success: false,
          error: `Insufficient balance. You have ${this.formatDash(this.creditsToDash(balance.confirmed))}.`,
          errorCode: 'INSUFFICIENT_BALANCE'
        };
      }

      const result = await creditTransferService.send({
        senderId,
        recipientId,
        amountCredits: BigInt(amountCredits),
        transferKeyWif,
        keyId,
        referenceType: postId ? 'tip' : undefined,
        referenceId: postId || undefined,
      })

      if (!result.success) {
        const lowerError = (result.error || '').toLowerCase()
        if (
          lowerError.includes('private') ||
          lowerError.includes('key') ||
          lowerError.includes('signature') ||
          lowerError.includes('wif') ||
          lowerError.includes('mismatch')
        ) {
          return {
            success: false,
            error: 'Invalid transfer key. The key you provided does not match this identity.',
            errorCode: 'INVALID_KEY',
          }
        }

        return {
          success: false,
          error: result.error || 'Transfer failed',
          errorCode: 'NETWORK_ERROR',
        }
      }

      if (postId && result.receiptId) {
        await this.createTipPost(senderId, postId, recipientId, amountCredits, result.receiptId, message)
      }

      return {
        success: true,
        transactionHash: result.transitionHash,
        receiptId: result.receiptId,
        verificationStatus: result.verificationStatus,
      }

    } catch (error) {
      logger.error('Tip transfer error:', error);
      // Handle both standard Error and WasmSdkError (which has .message but isn't instanceof Error)
      const errorMessage = (error instanceof Error ? error.message : null) ||
        ((error as { message?: string })?.message) ||
        (typeof error === 'string' ? error : 'Unknown error');

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
        }
      }

      return {
        success: false,
        error: `Transfer failed: ${errorMessage}`,
        errorCode: 'NETWORK_ERROR'
      }
    }
  }

  /**
   * Create a tip post as a reply to the tipped post
   *
   * TODO: Once SDK exposes transition IDs, include it in content for verification:
   * Format will become: tip:CREDITS@TRANSITION_ID\nmessage
   */
  private async createTipPost(
    senderId: string,
    postId: string,
    postOwnerId: string,
    amountCredits: number,
    receiptId: string,
    tipMessage?: string
  ): Promise<void> {
    try {
      // Format: tip:CREDITS@RECEIPT_ID\nmessage
      const content = tipMessage
        ? `tip:${amountCredits}@${receiptId}\n${tipMessage}`
        : `tip:${amountCredits}@${receiptId}`;

      // Tips are created as replies to the tipped post
      const { replyService } = await import('./reply-service');
      await replyService.createReply(senderId, content, postId, postOwnerId);

      logger.info('Tip reply created successfully');
    } catch (error) {
      // Log but don't fail the tip - the credit transfer already succeeded
      logger.error('Failed to create tip post:', error);
    }
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

  /**
   * Get minimum tip in DASH
   */
  getMinTipDash(): number {
    return this.creditsToDash(MIN_TIP_CREDITS);
  }

  /**
   * Parse tip content from post content
   * Returns TipInfo if the content is a tip post, null otherwise
   *
   * Supported formats:
   * - legacy: tip:CREDITS\nmessage
   * - receipt-backed: tip:CREDITS@RECEIPT_ID\nmessage
   */
  parseTipContent(content: string): TipInfo | null {
    const receiptMatch = content.match(RECEIPT_TIP_CONTENT_REGEX)
    if (receiptMatch) {
      return {
        amount: parseInt(receiptMatch[1], 10),
        receiptId: receiptMatch[2].trim(),
        message: (receiptMatch[3] || '').trim(),
        verificationStatus: 'pending',
      }
    }

    const legacyMatch = content.match(LEGACY_TIP_CONTENT_REGEX)
    if (!legacyMatch) return null

    return {
      amount: parseInt(legacyMatch[1], 10),
      message: (legacyMatch[2] || '').trim(),
      verificationStatus: 'legacy',
    }
  }

  /**
   * Check if post content is a tip
   */
  isTipPost(content: string): boolean {
    return RECEIPT_TIP_CONTENT_REGEX.test(content) || LEGACY_TIP_CONTENT_REGEX.test(content)
  }

  /**
   * Get tip amount from a transition ID
   * TODO: Implement actual lookup via SDK when available
   */
  async getTransitionAmount(transitionId: string): Promise<number | null> {
    // For now, return null - amount display is optional
    // In the future, we could look up the transition to get the actual amount
    logger.info('getTransitionAmount not yet implemented for:', transitionId);
    return null;
  }
}

export const tipService = new TipService();
