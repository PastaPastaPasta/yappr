/**
 * Token Purchase Builder
 *
 * Builds an UNSIGNED TokenDirectPurchaseTransition (wrapped in a
 * BatchTransition) whose serialized bytes get encoded into a dash-st: URI for
 * a remote wallet (e.g. Dash Evo Tool) to sign with a CRITICAL key and
 * broadcast — the same remote-signing channel the key-registration flow uses
 * (see identity-update-builder.ts). The construction mirrors the signed flow
 * in scripts/set-yapp-price.mjs.
 */

import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { tokenService } from './token-service';
import { YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION } from '../constants';
import {
  TokenBaseTransition,
  TokenDirectPurchaseTransition,
  TokenTransition,
  BatchedTransition,
  BatchTransition,
} from '@dashevo/evo-sdk';

// DIP-30 identity-contract nonce: u64 where the lower 40 bits are the sequence
// number and the upper 24 bits a missing-revision bitset. Only the sequence
// part is incremented for the next transition.
const SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1);

/**
 * Build the unsigned state transition bytes for a YAPP direct purchase.
 *
 * The transition carries the buyer's next identity-contract nonce, so it is
 * only valid until the buyer's next write to the social contract (posting,
 * liking, …) consumes that nonce — build it right before showing the QR and
 * rebuild on retry.
 *
 * @param buyerId - Identity ID (Base58) of the buyer the wallet signs for
 * @param amount - Whole YAPP tokens to buy
 * @param totalAgreedPrice - Max credits to spend, as quoted to the user
 * @returns Serialized unsigned StateTransition bytes for the dash-st: URI
 */
export async function buildUnsignedDirectPurchaseTransition(
  buyerId: string,
  amount: bigint,
  totalAgreedPrice: bigint
): Promise<Uint8Array> {
  const sdk = await getEvoSdk();
  const tokenId = await tokenService.getTokenId();

  const rawNonce = (await sdk.wasm.getIdentityContractNonce(buyerId, YAPPR_CONTRACT_ID)) ?? BigInt(0);
  const nonce = (rawNonce & SEQUENCE_MASK) + BigInt(1);
  logger.info(`TokenPurchaseBuilder: nonce raw=${rawNonce} using=${nonce}`);

  const base = new TokenBaseTransition({
    identityContractNonce: nonce,
    tokenContractPosition: YAPP_TOKEN_POSITION,
    dataContractId: YAPPR_CONTRACT_ID,
    tokenId,
  });

  const purchase = new TokenDirectPurchaseTransition({
    base,
    tokenCount: amount,
    totalAgreedPrice,
  });

  const tokenTransition = new TokenTransition(purchase);
  const batched = new BatchedTransition(tokenTransition);
  const batchTransition = BatchTransition.fromBatchedTransitions([batched], buyerId, 0);

  const stateTransition = batchTransition.toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);

  const bytes = stateTransition.toBytes();
  logger.info(`TokenPurchaseBuilder: unsigned purchase transition bytes length: ${bytes.length}`);
  return bytes;
}
