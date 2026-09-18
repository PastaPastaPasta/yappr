/**
 * Token Purchase Builder
 *
 * Builds an UNSIGNED TokenDirectPurchaseTransition, handed to a remote wallet to
 * sign with its CRITICAL key. The construction mirrors the signed flow in
 * scripts/set-yapp-price.mjs; the batch plumbing it shares with the tip builder
 * lives in token-transition-builder.ts.
 */

import { TokenDirectPurchaseTransition } from '@dashevo/evo-sdk';
import { buildUnsignedTokenBatch } from './token-transition-builder';

/**
 * Build the unsigned state transition bytes for a YAPP direct purchase.
 *
 * @param buyerId - Identity ID (Base58) of the buyer the wallet signs for
 * @param amount - Whole YAPP tokens to buy
 * @param totalAgreedPrice - Max credits to spend, as quoted to the user
 * @returns Serialized unsigned StateTransition bytes for the dash-st: URI
 */
export function buildUnsignedDirectPurchaseTransition(
  buyerId: string,
  amount: bigint,
  totalAgreedPrice: bigint
): Promise<Uint8Array> {
  return buildUnsignedTokenBatch('TokenPurchaseBuilder', buyerId, (base) =>
    new TokenDirectPurchaseTransition({
      base,
      tokenCount: amount,
      totalAgreedPrice,
    })
  );
}
