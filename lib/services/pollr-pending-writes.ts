import { logger } from '@/lib/logger';
import { POLLR_CONTRACT_ID } from '@/lib/constants';
import { extractErrorMessage } from '@/lib/error-utils';
import { getEvoSdk } from './evo-sdk-service';
import { loadReservation, settleSupersededReplaces, stillPending } from './identity-nonce';

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

/** The reservation scope of a Pollr ballot write: the poll it votes on. */
export function pollrBallotScope(pollId: string): string {
  return `pollr-vote:${pollId}`;
}

/**
 * Whether a Pollr write this browser signed for `ownerId` could still change
 * the voter's ballots on `pollId` — a ballot create or replace whose outcome
 * never came back. Planning a vote against the ballots on chain, or showing
 * them as settled, is only sound when none can: one that lands afterwards
 * changes the selection that was judged.
 *
 * Ballot writes are reserved with their poll's scope, so a pending write on
 * another poll does not count. An entry with no scope (a poll create, or one
 * stored before scopes were recorded) may touch anything, so it counts for
 * every poll.
 *
 * A create is reserved with its nonce, and a signed transition has no protocol
 * deadline, so it counts until Platform shows that nonce consumed — by the
 * create landing, by another transition taking it, or by it falling out of the
 * window behind the tip — and on no clock. A create that was dropped therefore
 * holds back this one poll's ballots until then (or until the poll closes,
 * which ends voting anyway); nothing else proves it cannot still execute. A
 * replace the SDK signed has no known nonce; it counts until it is settled
 * (see {@link settlePendingPollrReplaces}, which callers run first) or its
 * reservation expires.
 * True when the nonce cannot be read while something relevant is pending,
 * since nothing then proves it cannot execute.
 *
 * Throws NONCE_STORE_ERROR when the reservation store cannot be read: nothing
 * is then known about what may still execute, so the caller must not treat
 * the ballots as settled. This blocks nothing that could otherwise work: no
 * Pollr write can be signed without the store either.
 */
export async function pollrWriteMayStillExecute(ownerId: string, pollId: string): Promise<boolean> {
  const reservation = loadReservation(ownerId, POLLR_CONTRACT_ID);
  const scope = pollrBallotScope(pollId);
  const relevant = (reservation?.pending ?? []).filter((p) => p.scope === undefined || p.scope === scope);
  if (!reservation || relevant.length === 0) return false;
  try {
    const sdk = await getEvoSdk();
    const current = await sdk.identities.contractNonce(ownerId, POLLR_CONTRACT_ID);
    return stillPending(current, { ...reservation, pending: relevant }).length > 0;
  } catch (error) {
    logger.warn('Pollr: could not check for pending writes', { error: extractErrorMessage(error) });
    return true;
  }
}
