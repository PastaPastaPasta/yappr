/**
 * Token Transfer Builder
 *
 * Builds an UNSIGNED TokenTransferTransition (wrapped in a BatchTransition)
 * whose serialized bytes get encoded into a dash-st: URI for a remote wallet
 * (e.g. Dash Evo Tool) to sign with a CRITICAL key and broadcast.
 *
 * Every batch carrying a token transition needs a CRITICAL authentication key,
 * which the app does not hold for wallet-login users — so a YAPP tip is built
 * here and handed to the wallet, exactly as token-purchase-builder.ts does for
 * a direct purchase.
 */

import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { tokenService } from './token-service';
import { YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION } from '../constants';
import {
  TokenBaseTransition,
  TokenTransferTransition,
  TokenTransition,
  BatchedTransition,
  BatchTransition,
} from '@dashevo/evo-sdk';

// DIP-30 identity-contract nonce: u64 where the lower 40 bits are the sequence
// number and the upper 24 bits a missing-revision bitset. Only the sequence
// part is incremented for the next transition.
const SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1);

/**
 * Build the unsigned state transition bytes for a YAPP transfer (a tip).
 *
 * The transition carries the sender's next identity-contract nonce, so it is
 * only valid until the sender's next write to the social contract (posting,
 * liking, …) consumes that nonce — build it right before showing the QR and
 * rebuild on retry.
 *
 * @param senderId - Identity ID (Base58) of the tipper the wallet signs for
 * @param recipientId - Identity ID (Base58) receiving the tokens
 * @param amount - Whole YAPP tokens to transfer
 * @param publicNote - The tip note (see lib/tip-note.ts); signed with the transfer
 * @returns Serialized unsigned StateTransition bytes for the dash-st: URI
 */
export async function buildUnsignedYappTipTransition(
  senderId: string,
  recipientId: string,
  amount: bigint,
  publicNote?: string
): Promise<Uint8Array> {
  const sdk = await getEvoSdk();
  const tokenId = await tokenService.getTokenId();

  const rawNonce = (await sdk.wasm.getIdentityContractNonce(senderId, YAPPR_CONTRACT_ID)) ?? BigInt(0);
  const nonce = (rawNonce & SEQUENCE_MASK) + BigInt(1);
  logger.debug(`TokenTransferBuilder: nonce raw=${rawNonce} using=${nonce}`);

  const base = new TokenBaseTransition({
    identityContractNonce: nonce,
    tokenContractPosition: YAPP_TOKEN_POSITION,
    dataContractId: YAPPR_CONTRACT_ID,
    tokenId,
  });

  const transfer = new TokenTransferTransition({
    base,
    recipientId,
    amount,
    ...(publicNote ? { publicNote } : {}),
  });

  const tokenTransition = new TokenTransition(transfer);
  const batched = new BatchedTransition(tokenTransition);
  const batchTransition = BatchTransition.fromBatchedTransitions([batched], senderId, 0);

  const stateTransition = batchTransition.toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);

  const bytes = stateTransition.toBytes();
  logger.debug(`TokenTransferBuilder: unsigned transfer transition bytes length: ${bytes.length}`);
  return bytes;
}
