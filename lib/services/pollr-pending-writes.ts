import { logger } from '@/lib/logger';
import { POLLR_CONTRACT_ID } from '@/lib/constants';
import { extractErrorMessage } from '@/lib/error-utils';
import { getEvoSdk } from './evo-sdk-service';
import { PENDING_LIFETIME_MS, loadReservation, settleSupersededReplaces, stillPending } from './identity-nonce';

/**
 * Run before any Pollr write (a ballot, a poll). A v5 ballot replace whose
 * confirmation timed out leaves its nonce reservation pending with no known
 * nonce, and that holds back every later write this identity makes on the
 * contract — the next ballot edit, a ballot on another poll, a new poll —
 * until it expires (reloading does not clear it). This releases the ones
 * Platform proves superseded: the ballot at the revision the replace wrote AND
 * the nonce after it consumed. Genuinely uncertain reservations stay, and a
 * failure here only leaves them as they were, so it never blocks the write.
 */
export async function settlePendingPollrReplaces(ownerId: string): Promise<void> {
  try {
    await settleSupersededReplaces(ownerId, POLLR_CONTRACT_ID);
  } catch (error) {
    logger.warn('Pollr: could not settle pending ballot replaces', { error: extractErrorMessage(error) });
  }
}

/**
 * Whether a Pollr write this browser signed for `ownerId` could still execute
 * — a ballot create or replace whose outcome never came back. Planning a vote
 * against the ballots on chain is only sound when none can: one that lands
 * afterwards changes the selection the plan was judged against (an empty plan
 * would even report a selection "recorded" that the late write then changes).
 *
 * A create is reserved with its nonce, so it stops counting once Platform
 * shows that nonce consumed, whether by it or by another transition — or, as
 * the store already assumes for SDK-signed ones, once it is older than
 * PENDING_LIFETIME_MS: a valid transition executes within a block or two, so
 * one that old was dropped (otherwise a dropped create would hold every later
 * vote back for good, its nonce never consumed). A replace
 * the SDK signed has no known nonce; it counts until it is settled (see
 * {@link settlePendingPollrReplaces}, which callers run first) or expires. The
 * reservations do not record which poll they write, so any pending Pollr write
 * counts. True when the nonce cannot be read while something is pending, since
 * nothing then proves it cannot execute.
 *
 * Throws NONCE_STORE_ERROR when the reservation store cannot be read: nothing
 * is then known about what may still execute, so the caller must refuse — even
 * a plan of no writes, which never reaches the write path's own refusal. This
 * blocks nothing that could otherwise work: no Pollr write can be signed
 * without the store either.
 */
export async function pollrWriteMayStillExecute(ownerId: string): Promise<boolean> {
  const reservation = loadReservation(ownerId, POLLR_CONTRACT_ID);
  if (!reservation || reservation.pending.length === 0) return false;
  try {
    const sdk = await getEvoSdk();
    const current = await sdk.identities.contractNonce(ownerId, POLLR_CONTRACT_ID);
    const now = Date.now();
    return stillPending(current, reservation, now)
      .some((p) => p.reservedAt === undefined || now - p.reservedAt < PENDING_LIFETIME_MS);
  } catch (error) {
    logger.warn('Pollr: could not check for pending writes', { error: extractErrorMessage(error) });
    return true;
  }
}
