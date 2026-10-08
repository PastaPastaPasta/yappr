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
 * It is a guard against paid refusals, not the rule: consensus enforces
 * `noBallots` whatever this says. Past {@link MAX_STORED} polls the oldest
 * are dropped from storage (the in-memory copy keeps them for the session).
 */
const STORAGE_KEY = scopedKey(`yappr:pollr-known-ballots:${POLLR_CONTRACT_ID}`);
const MAX_STORED = 5000;

const inMemory = new Set<string>();

function storedIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // No storage (server, private mode) or a corrupt value: memory still holds this session's.
    return [];
  }
}

/** Record that a ballot names the poll. Never undone. */
export function markPollHasBallots(pollId: string): void {
  inMemory.add(pollId);
  try {
    const ids = storedIds();
    if (ids.includes(pollId)) return;
    ids.push(pollId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_STORED)));
  } catch {
    // Storage refused the write; memory still holds it for this session.
  }
}

/** Whether the poll is known to have a ballot (in this tab, or any other, or earlier), so it can never be deleted. */
export function pollHasKnownBallots(pollId: string): boolean {
  if (inMemory.has(pollId)) return true;
  if (!storedIds().includes(pollId)) return false;
  inMemory.add(pollId);
  return true;
}
