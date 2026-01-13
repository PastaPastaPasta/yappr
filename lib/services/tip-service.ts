import { getEvoSdk } from './evo-sdk-service';
import { identityService } from './identity-service';
import { postService } from './post-service';
import { wallet, IdentitySigner } from '@dashevo/evo-sdk';
import { TipInfo } from '../types';

export interface TipResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  errorCode?: 'INSUFFICIENT_BALANCE' | 'SELF_TIP' | 'NETWORK_ERROR' | 'INVALID_AMOUNT' | 'INVALID_KEY';
}

// Regex to parse tip content: tip:AMOUNT_CREDITS followed by optional message
// Format: tip:CREDITS\nmessage (message is optional)
// Using [\s\S]* instead of .* with 's' flag for cross-line matching
//
// TODO: Once the Dash Platform SDK exposes transition IDs from creditTransfer(),
// update format to: tip:CREDITS@TRANSITION_ID\nmessage
// This will allow on-chain verification of tip amounts.
// See: wasm-sdk/src/state_transitions/identity/mod.rs - identity_credit_transfer
// currently returns { status, senderId, recipientId, amount, message } but no hash.
const TIP_CONTENT_REGEX = /^tip:(\d+)(?:\n([\s\S]*))?$/;

// Conversion: 1 DASH = 100,000,000,000 credits on Dash Platform
// (Platform credits are different from core duffs)
export const CREDITS_PER_DASH = 100_000_000_000;
export const MIN_TIP_CREDITS = 100_000_000; // 0.001 DASH minimum

class TipService {
  /**
   * Send a tip (credit transfer) to another user and create a tip post
   * @param senderId - The sender's identity ID
   * @param recipientId - The recipient's identity ID (post author)
   * @param postId - The post being tipped
   * @param amountCredits - Amount in credits
   * @param transferKeyWif - The sender's transfer private key in WIF format
   * @param message - Optional tip message
   * @param keyId - Optional key ID to use (if identity has multiple keys)
   */
  async sendTip(
    senderId: string,
    recipientId: string,
    postId: string,
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

      const sdk = await getEvoSdk();

      // Log transfer details for debugging
      console.log('=== Credit Transfer Debug ===');
      console.log(`Sender ID: ${senderId}`);
      console.log(`Recipient ID: ${recipientId}`);
      console.log(`Amount: ${amountCredits} credits`);
      console.log(`Key ID: ${keyId !== undefined ? keyId : 'auto-detect'}`);
      console.log(`Private key length: ${transferKeyWif.trim().length}`);
      console.log(`Private key starts with: ${transferKeyWif.trim().substring(0, 4)}...`);

      // Fetch sender identity (new SDK requires Identity object)
      const identity = await sdk.identities.fetch(senderId);
      if (!identity) {
        return {
          success: false,
          error: 'Sender identity not found',
          errorCode: 'NETWORK_ERROR'
        };
      }

      const identityJson = identity.toJSON();
      console.log('Sender identity public keys:', JSON.stringify(identityJson.publicKeys, null, 2));

      // Try to derive public key from the provided private key and compare
      try {
        const keyPair = await wallet.keyPairFromWif(transferKeyWif.trim());
        console.log('Derived key pair from WIF:', keyPair);

        // Find transfer keys (purpose 3) on the identity
        const transferKeys = identityJson.publicKeys.filter((k: any) => k.purpose === 3);
        console.log('Transfer keys on identity:', transferKeys);

        if (keyPair && keyPair.publicKey) {
          // public_key is a hex string, convert to base64 for comparison
          const hexToBytes = (hex: string) => {
            const bytes = [];
            for (let i = 0; i < hex.length; i += 2) {
              bytes.push(parseInt(hex.substr(i, 2), 16));
            }
            return bytes;
          };
          const pubKeyBytes = hexToBytes(keyPair.publicKey);
          const pubKeyBase64 = btoa(String.fromCharCode.apply(null, pubKeyBytes));
          console.log('Derived public key (hex):', keyPair.publicKey);
          console.log('Derived public key (base64):', pubKeyBase64);

          // Compare with key 3's public key
          const key3 = identityJson.publicKeys.find((k: any) => k.id === 3);
          if (key3) {
            console.log('Key 3 public key (from identity):', key3.data);
            console.log('Keys match:', pubKeyBase64 === key3.data);
          }
        }
      } catch (keyError) {
        console.log('Error deriving key pair:', keyError);
      }

      // Create signer with the transfer key
      const signer = new IdentitySigner();
      signer.addKeyFromWif(transferKeyWif.trim());

      // Get the signing key if a specific key ID is provided
      const effectiveKeyId = keyId !== undefined ? keyId : 3; // Default to transfer key (purpose 3)
      const signingKey = identity.getPublicKeyById(effectiveKeyId);
      console.log(`Using key ID: ${effectiveKeyId}${keyId === undefined ? ' (defaulting to transfer key)' : ''}`);

      // Log the exact args being sent
      console.log('Transfer args:', JSON.stringify({
        senderId,
        recipientId,
        amount: amountCredits.toString(),
        keyId: effectiveKeyId
      }, null, 2));

      console.log('Calling sdk.identities.creditTransfer...');
      const result = await sdk.identities.creditTransfer({
        identity,
        recipientId,
        amount: BigInt(amountCredits),
        signer,
        signingKey: signingKey || undefined
      });

      // Clear sender's balance cache so it refreshes
      identityService.clearCache(senderId);

      console.log('Tip transfer result:', result);

      // Create tip post as a reply to the tipped post
      // TODO: Once SDK returns transition ID, pass it for on-chain verification
      await this.createTipPost(senderId, postId, amountCredits, message);

      return {
        success: true,
        // TODO: Return actual transaction hash once SDK exposes it
        transactionHash: 'confirmed'
      };

    } catch (error: any) {
      console.error('Tip transfer error:', error);
      // Handle both standard Error and WasmSdkError (which has .message but isn't instanceof Error)
      const errorMessage = error?.message || (typeof error === 'string' ? error : 'Unknown error');

      // Handle known DAPI timeout issue (like in state-transition-service)
      if (errorMessage.includes('504') || errorMessage.includes('timeout') || errorMessage.includes('wait_for_state_transition_result')) {
        // Assume success - clear cache and return optimistic result
        identityService.clearCache(senderId);

        // Create tip post (amount is known even if confirmation timed out)
        await this.createTipPost(senderId, postId, amountCredits, message);

        return {
          success: true,
          transactionHash: 'pending-confirmation'
        };
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
   * Create a tip post as a reply to the tipped post
   *
   * TODO: Once SDK exposes transition IDs, include it in content for verification:
   * Format will become: tip:CREDITS@TRANSITION_ID\nmessage
   */
  private async createTipPost(
    senderId: string,
    postId: string,
    amountCredits: number,
    tipMessage?: string
  ): Promise<void> {
    try {
      // Format: tip:CREDITS\nmessage (message is optional)
      // Amount is self-reported until SDK provides transition ID for verification
      const content = tipMessage
        ? `tip:${amountCredits}\n${tipMessage}`
        : `tip:${amountCredits}`;

      await postService.createPost(senderId, content, {
        replyToId: postId
      });

      console.log('Tip post created successfully');
    } catch (error) {
      // Log but don't fail the tip - the credit transfer already succeeded
      console.error('Failed to create tip post:', error);
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
   * Current format: tip:CREDITS\nmessage
   * TODO: Future format with verification: tip:CREDITS@TRANSITION_ID\nmessage
   */
  parseTipContent(content: string): TipInfo | null {
    const match = content.match(TIP_CONTENT_REGEX);
    if (!match) return null;

    return {
      amount: parseInt(match[1], 10),
      message: (match[2] || '').trim()
    };
  }

  /**
   * Check if post content is a tip
   */
  isTipPost(content: string): boolean {
    return TIP_CONTENT_REGEX.test(content);
  }

  /**
   * Get tip amount from a transition ID
   * TODO: Implement actual lookup via SDK when available
   */
  async getTransitionAmount(transitionId: string): Promise<number | null> {
    // For now, return null - amount display is optional
    // In the future, we could look up the transition to get the actual amount
    console.log('getTransitionAmount not yet implemented for:', transitionId);
    return null;
  }
}

export const tipService = new TipService();
