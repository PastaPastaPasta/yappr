/**
 * Token Transfer Builder
 *
 * Builds an UNSIGNED TokenTransferTransition for a YAPP tip, handed to a remote
 * wallet to sign with its CRITICAL key — exactly as token-purchase-builder.ts
 * does for a direct purchase. The batch construction they share lives in
 * token-transition-builder.ts.
 */

import { TokenTransferTransition } from '@dashevo/evo-sdk';
import { buildUnsignedTokenBatch } from './token-transition-builder';

/**
 * Build the unsigned state transition bytes for a YAPP transfer (a tip).
 *
 * @param senderId - Identity ID (Base58) of the tipper the wallet signs for
 * @param recipientId - Identity ID (Base58) receiving the tokens
 * @param amount - Whole YAPP tokens to transfer
 * @param publicNote - The tip note (see lib/tip-note.ts); signed with the transfer
 * @returns Serialized unsigned StateTransition bytes for the dash-st: URI
 */
export function buildUnsignedYappTipTransition(
  senderId: string,
  recipientId: string,
  amount: bigint,
  publicNote?: string
): Promise<Uint8Array> {
  return buildUnsignedTokenBatch('TokenTransferBuilder', senderId, (base) =>
    new TokenTransferTransition({
      base,
      recipientId,
      amount,
      ...(publicNote ? { publicNote } : {}),
    })
  );
}
