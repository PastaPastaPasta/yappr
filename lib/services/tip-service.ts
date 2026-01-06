import { getEvoSdk } from './evo-sdk-service';
import { identityService } from './identity-service';
import { wallet } from '@dashevo/evo-sdk';

export interface TipResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  errorCode?: 'INSUFFICIENT_BALANCE' | 'SELF_TIP' | 'NETWORK_ERROR' | 'INVALID_AMOUNT' | 'INVALID_KEY';
}

// Conversion: 1 DASH = 100,000,000,000 credits on Dash Platform
// (Platform credits are different from core duffs)
export const CREDITS_PER_DASH = 100_000_000_000;
export const MIN_TIP_CREDITS = 100_000_000; // 0.001 DASH minimum

class TipService {
  /**
   * Send a tip (credit transfer) to another user
   * @param senderId - The sender's identity ID
   * @param recipientId - The recipient's identity ID
   * @param amountCredits - Amount in credits
   * @param transferKeyWif - The sender's transfer private key in WIF format
   * @param keyId - Optional key ID to use (if identity has multiple keys)
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

      // Fetch sender identity to see available keys
      try {
        const identity = await sdk.identities.fetch(senderId);
        if (identity) {
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
        }
      } catch (e) {
        console.log('Could not fetch identity for debugging:', e);
      }

      // Execute credit transfer
      const transferArgs: {
        senderId: string;
        recipientId: string;
        amount: bigint;
        privateKeyWif: string;
        keyId?: number;
      } = {
        senderId,
        recipientId,
        amount: BigInt(amountCredits),
        privateKeyWif: transferKeyWif.trim()
      };

      // Add keyId - use provided value or default to 3 (transfer key)
      const effectiveKeyId = keyId !== undefined ? keyId : 3;
      transferArgs.keyId = effectiveKeyId;
      console.log(`Using key ID: ${effectiveKeyId}${keyId === undefined ? ' (defaulting to transfer key)' : ''}`);

      // Log the exact args being sent
      console.log('Transfer args:', JSON.stringify({
        senderId: transferArgs.senderId,
        recipientId: transferArgs.recipientId,
        amount: transferArgs.amount.toString(),
        keyId: transferArgs.keyId,
        privateKeyWifLength: transferArgs.privateKeyWif.length
      }, null, 2));

      console.log('Calling sdk.identities.creditTransfer...');
      const result = await sdk.identities.creditTransfer(transferArgs);

      // Clear sender's balance cache so it refreshes
      identityService.clearCache(senderId);

      console.log('Tip transfer result:', result);

      return {
        success: true,
        transactionHash: result?.transitionId || result?.$id || 'confirmed'
      };

    } catch (error) {
      console.error('Tip transfer error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';

      // Handle known DAPI timeout issue (like in state-transition-service)
      if (message.includes('504') || message.includes('timeout') || message.includes('wait_for_state_transition_result')) {
        // Assume success - clear cache and return optimistic result
        identityService.clearCache(senderId);
        return {
          success: true,
          transactionHash: 'pending-confirmation'
        };
      }

      // Check for invalid key errors
      if (message.includes('private') || message.includes('key') || message.includes('signature')) {
        return {
          success: false,
          error: 'Invalid transfer key. Please check your key and try again.',
          errorCode: 'INVALID_KEY'
        };
      }

      return {
        success: false,
        error: message,
        errorCode: 'NETWORK_ERROR'
      };
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
}

export const tipService = new TipService();
