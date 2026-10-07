import { logger } from '@/lib/logger';
import { POLLR_CONTRACT_ID } from '@/lib/constants';
import { extractErrorMessage } from '@/lib/error-utils';
import { settleSupersededReplaces } from './identity-nonce';

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
