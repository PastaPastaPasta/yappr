import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { identityService } from './identity-service';
import { signerService, KeyPurpose } from './signer-service';
import { wallet } from '@dashevo/evo-sdk';
import { TipInfo } from '../../types';
import { findMatchingKeyIndex, type IdentityPublicKeyInfo } from '@/lib/crypto/keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';

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
   * Find the transfer key that matches the provided private key
   *
   * This verifies that the private key corresponds to one of the identity's
   * transfer keys, preventing signer/key mismatches.
   *
   * @param privateKeyWif - The private key in WIF format
   * @param wasmPublicKeys - The identity's WASM public keys
   * @param specificKeyId - Optional specific key ID to use
   * @returns The matching transfer key or null if not found
   */
  private findMatchingTransferKey(
    privateKeyWif: string,
    wasmPublicKeys: WasmIdentityPublicKey[],
    specificKeyId?: number
  ): WasmIdentityPublicKey | null {
    const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet';
    const activeKeys = wasmPublicKeys.filter(k => !k.disabledAt);
    const transferKeys = activeKeys.filter(k => k.purposeNumber === KeyPurpose.TRANSFER);

    if (transferKeys.length === 0) {
      return null;
    }

    // Convert transfer keys to format for matching
    const keyInfos: IdentityPublicKeyInfo[] = transferKeys.map(key => {
      const dataHex = key.data;
      const data = new Uint8Array(dataHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []);
      return {
        id: key.keyId,
        type: key.keyTypeNumber,
        purpose: key.purposeNumber,
        securityLevel: key.securityLevelNumber,
        data
      };
    });

    // Find which transfer key matches the provided private key
    const match = findMatchingKeyIndex(privateKeyWif, keyInfos, network);

    if (!match) {
      logger.error('Transfer private key does not match any transfer key on this identity');
      return null;
    }

    // If a specific key ID was requested, verify it matches
    if (specificKeyId !== undefined && match.keyId !== specificKeyId) {
      logger.error(`Requested key ID ${specificKeyId} but private key matches key ID ${match.keyId}`);
      return null;
    }

    logger.info(`Matched transfer key: id=${match.keyId}`);
    return transferKeys.find(k => k.keyId === match.keyId) || null;
  }

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

      const sdk = await getEvoSdk();

      // Log transfer details for debugging
      logger.info('=== Credit Transfer Debug ===');
      logger.info(`Sender ID: ${senderId}`);
      logger.info(`Recipient ID: ${recipientId}`);
      logger.info(`Amount: ${amountCredits} credits`);
      logger.info(`Key ID: ${keyId !== undefined ? keyId : 'auto-detect'}`);
      logger.info(`Private key length: ${transferKeyWif.trim().length}`);
      logger.info(`Private key starts with: ${transferKeyWif.trim().substring(0, 4)}...`);

      // Fetch sender identity to see available keys
      try {
        const identity = await sdk.identities.fetch(senderId);
        if (identity) {
          const identityJson = identity.toJSON();
          logger.info('Sender identity public keys:', JSON.stringify(identityJson.publicKeys, null, 2));

          // Try to derive public key from the provided private key and compare
          try {
            const keyPair = await wallet.keyPairFromWif(transferKeyWif.trim());
            logger.info('Derived key pair from WIF:', keyPair);

            // Find transfer keys (purpose 3) on the identity
            interface IdentityPublicKey { id: number; purpose: number; data?: string }
            const transferKeys = identityJson.publicKeys.filter((k: IdentityPublicKey) => k.purpose === 3);
            logger.info('Transfer keys on identity:', transferKeys);

            if (keyPair?.publicKey) {
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
              logger.info('Derived public key (hex):', keyPair.publicKey);
              logger.info('Derived public key (base64):', pubKeyBase64);

              // Compare with key 3's public key
              const key3 = identityJson.publicKeys.find((k: IdentityPublicKey) => k.id === 3);
              if (key3) {
                logger.info('Key 3 public key (from identity):', key3.data);
                logger.info('Keys match:', pubKeyBase64 === key3.data);
              }
            }
          } catch (keyError) {
            logger.info('Error deriving key pair:', keyError);
          }
        }
      } catch (e) {
        logger.info('Could not fetch identity for debugging:', e);
      }

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
      logger.info('Transfer args:', JSON.stringify({
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

      logger.info('Calling sdk.identities.creditTransfer...');
      // Cast needed: SDK has duplicate IdentityCreditTransferOptions interfaces that get merged.
      // The high-level facade only needs { identity, recipientId, amount, signer, signingKey? }.
      const result = await sdk.identities.creditTransfer({
        identity,
        recipientId,
        amount: BigInt(amountCredits),
        signer,
        signingKey
      } as Parameters<typeof sdk.identities.creditTransfer>[0]);

      // Clear sender's balance cache so it refreshes
      identityService.clearCache(senderId);

      logger.info('Tip transfer result:', result);

      // Create tip post as a reply to the tipped post (only if postId provided)
      // TODO: Once SDK returns transition ID, pass it for on-chain verification
      if (postId) {
        await this.createTipPost(senderId, postId, recipientId, amountCredits, message);
      }

      return {
        success: true,
        // TODO: Return actual transaction hash once SDK exposes it
        transactionHash: 'confirmed'
      };

    } catch (error) {
      logger.error('Tip transfer error:', error);
      // Handle both standard Error and WasmSdkError (which has .message but isn't instanceof Error)
      const errorMessage = (error instanceof Error ? error.message : null) ||
        ((error as { message?: string })?.message) ||
        (typeof error === 'string' ? error : 'Unknown error');

      // Handle known DAPI timeout issue (like in state-transition-service)
      if (errorMessage.includes('504') || errorMessage.includes('timeout') || errorMessage.includes('wait_for_state_transition_result')) {
        // Assume success - clear cache and return optimistic result
        identityService.clearCache(senderId);

        // Create tip post (amount is known even if confirmation timed out)
        if (postId) {
          await this.createTipPost(senderId, postId, recipientId, amountCredits, message);
        }

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
    postOwnerId: string,
    amountCredits: number,
    tipMessage?: string
  ): Promise<void> {
    try {
      // Format: tip:CREDITS\nmessage (message is optional)
      // Amount is self-reported until SDK provides transition ID for verification
      const content = tipMessage
        ? `tip:${amountCredits}\n${tipMessage}`
        : `tip:${amountCredits}`;

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
    logger.info('getTransitionAmount not yet implemented for:', transitionId);
    return null;
  }
}

export const tipService = new TipService();
