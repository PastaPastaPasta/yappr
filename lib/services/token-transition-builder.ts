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
import { tokenService } from './token-service';
import { YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION } from '../constants';
import { TokenBaseTransition, TokenTransition, BatchedTransition, BatchTransition } from '@dashevo/wasm-sdk';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { allocateNonce, awaitNonce, releaseNonce, reserveNonce } from './identity-nonce';

/**
 * An unsigned transition for a wallet, and the way to take it back. The bytes
 * hold a nonce reserved as pending until Platform shows it consumed, since a
 * wallet can sign them at any later time. Call `discard` only while the bytes
 * have never been shown (the build was abandoned before its QR went up); once
 * a wallet may have them, only consumption of the nonce frees it. It takes the
 * write lock, like every other change to the shared reservation.
 */
export interface WalletTransitionRequest {
  bytes: Uint8Array;
  discard: () => Promise<void>;
}

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
 * @returns Serialized unsigned StateTransition bytes for the dash-st: URI, and
 *   `discard` for a request abandoned before it was shown
 */
export async function buildUnsignedTokenBatch(
  label: string,
  ownerId: string,
  build: (base: TokenBaseTransition) => ConstructorParameters<typeof TokenTransition>[0]
): Promise<WalletTransitionRequest> {
  const tokenId = await tokenService.getTokenId();

  // The wallet broadcasts later, so the lock cannot cover that; taking the
  // nonce past every one this browser signed, and reserving it as pending
  // until Platform shows it consumed (the wallet may sign it long after the QR
  // is gone), keeps any later write from signing the same one (QA D-01). It is
  // reserved only once the bytes exist, so a failed build holds nothing.
  return withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => {
    const { current: rawNonce, value: nonce } = await awaitNonce(ownerId, YAPPR_CONTRACT_ID, allocateNonce);
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

    const entry = reserveNonce(ownerId, YAPPR_CONTRACT_ID, nonce, rawNonce);
    // Never shown to a wallet, so never signed: its nonce was not taken.
    const discard = () => withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => releaseNonce(ownerId, YAPPR_CONTRACT_ID, entry));
    return { bytes, discard };
  });
}
