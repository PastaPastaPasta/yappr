/**
 * Token Transfer Builder
 *
 * Builds an UNSIGNED TokenTransferTransition for a YAPP tip, handed to a remote
 * wallet to sign with its CRITICAL key — exactly as token-purchase-builder.ts
 * does for a direct purchase. The batch construction they share lives in
 * token-transition-builder.ts.
 */

import { TokenTransferTransition } from '@dashevo/evo-sdk';
import { yappIsTransferable } from '../contract-topology';
import { buildUnsignedTokenBatch, type WalletTransitionRequest } from './token-transition-builder';

/**
 * Build the unsigned state transition bytes for a YAPP transfer (a tip).
 *
 * @param senderId - Identity ID (Base58) of the tipper the wallet signs for
 * @param recipientId - Identity ID (Base58) receiving the tokens
 * @param amount - Whole YAPP tokens to transfer
 * @param publicNote - The tip note (see lib/tip-note.ts); signed with the transfer
 * @returns Serialized unsigned StateTransition bytes for the dash-st: URI, and
 *   `discard` for a request abandoned before it was shown. Rejects without
 *   building anything where YAPP cannot be transferred (v15): the chain would
 *   refuse the transfer (40726) after the wallet signed it, and the nonce would
 *   be spent for nothing.
 */
export function buildUnsignedYappTipTransition(
  senderId: string,
  recipientId: string,
  amount: bigint,
  publicNote?: string
): Promise<WalletTransitionRequest> {
  if (!yappIsTransferable()) return Promise.reject(new Error('YAPP cannot be transferred on this network'));
  return buildUnsignedTokenBatch('TokenTransferBuilder', senderId, (base) =>
    new TokenTransferTransition({
      base,
      recipientId,
      amount,
      ...(publicNote ? { publicNote } : {}),
    })
  );
}
