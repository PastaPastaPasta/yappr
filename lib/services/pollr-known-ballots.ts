import { POLLR_CONTRACT_ID } from '@/lib/constants';
import { scopedKey } from '@/lib/storage-scope';

/**
 * Polls this browser knows have a ballot. Ballots are never deleted, so on v6
 * such a poll can never be deleted again (its `noBallots` rule): the store
 * only grows. It is kept in localStorage, so no reload, card, tab or session
 * resets it, and a later count of 0 from a node that lags behind cannot bring
 * the delete back. Filled wherever the evidence is seen: an own ballot
 * document read (withdrawn ones included), a stored ballot replace, a
 * confirmed ballot write, a create refused as a duplicate, a tallied
 * selection, a positive ballot count, or a 40147.
 *
 * One key per poll, written once and never read-modified-written, so two tabs
 * recording different polls at once cannot overwrite each other.
 *
 * It is a guard against paid refusals, not the rule: consensus enforces
 * `noBallots` whatever this says.
 */
const KEY_PREFIX = scopedKey(`yappr:pollr-known-ballot:${POLLR_CONTRACT_ID}:`);

const inMemory = new Set<string>();

/** Record that a ballot names the poll. Never undone. */
export function markPollHasBallots(pollId: string): void {
  inMemory.add(pollId);
  try {
    localStorage.setItem(`${KEY_PREFIX}${pollId}`, '1');
  } catch {
    // No storage (server, private mode) or it refused the write: memory still holds it for this session.
  }
}

/** Whether the poll is known to have a ballot (in this tab, another, or earlier), so it can never be deleted. */
export function pollHasKnownBallots(pollId: string): boolean {
  if (inMemory.has(pollId)) return true;
  try {
    if (localStorage.getItem(`${KEY_PREFIX}${pollId}`) === null) return false;
  } catch {
    return false;
  }
  inMemory.add(pollId);
  return true;
}
