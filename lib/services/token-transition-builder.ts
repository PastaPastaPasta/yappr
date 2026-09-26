/**
 * Unsigned token transitions for remote-wallet signing.
 *
 * Every batch carrying a token transition needs a CRITICAL authentication key,
 * which the app does not hold for wallet-login users — so the transition is
 * built here unsigned and its bytes are encoded into a dash-st: URI for a
 * remote wallet (e.g. Dash Evo Tool) to sign and broadcast, the same channel
 * the key-registration flow uses (see identity-update-builder.ts).
 */

import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { tokenService } from './token-service';
import { YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION } from '../constants';
import { TokenBaseTransition, TokenTransition, BatchedTransition, BatchTransition } from '@dashevo/evo-sdk';

// DIP-30 identity-contract nonce: u64 where the lower 40 bits are the sequence
// number and the upper 24 bits a missing-revision bitset. Only the sequence
// part is incremented for the next transition.
const SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1);

/**
 * Serialize an unsigned single-transition batch for `ownerId`.
 *
 * The transition carries the owner's next identity-contract nonce, so it is
 * only valid until their next write to the social contract (posting, liking, …)
 * consumes that nonce — build it right before showing the QR and rebuild on retry.
 *
 * @param label - Prefix for the debug lines, naming the calling flow
 * @param ownerId - Identity ID (Base58) the wallet signs for
 * @param build - Wraps the shared base into the concrete token transition
 * @returns Serialized unsigned StateTransition bytes for the dash-st: URI
 */
export async function buildUnsignedTokenBatch(
  label: string,
  ownerId: string,
  build: (base: TokenBaseTransition) => ConstructorParameters<typeof TokenTransition>[0]
): Promise<Uint8Array> {
  const sdk = await getEvoSdk();
  const tokenId = await tokenService.getTokenId();

  const rawNonce = (await sdk.identities.contractNonce(ownerId, YAPPR_CONTRACT_ID)) ?? BigInt(0);
  const nonce = (rawNonce & SEQUENCE_MASK) + BigInt(1);
  logger.debug(`${label}: nonce raw=${rawNonce} using=${nonce}`);

  const base = new TokenBaseTransition({
    identityContractNonce: nonce,
    tokenContractPosition: YAPP_TOKEN_POSITION,
    dataContractId: YAPPR_CONTRACT_ID,
    tokenId,
  });

  const batched = new BatchedTransition(new TokenTransition(build(base)));
  const stateTransition = BatchTransition.fromBatchedTransitions([batched], ownerId, 0).toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);

  const bytes = stateTransition.toBytes();
  logger.debug(`${label}: unsigned transition bytes length: ${bytes.length}`);
  return bytes;
}
