import { logger } from '@/lib/logger';
import { POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES } from '@/lib/constants';
import { NONCE_STORE_ERROR, extractErrorMessage } from '@/lib/error-utils';
import { scopedKey } from '@/lib/storage-scope';
import { getEvoSdk } from './evo-sdk-service';
import { loadReservation, settleSupersededReplaces, stillPending } from './identity-nonce';
import { markPollHasBallots } from './pollr-known-ballots';
import { documentToPlainObject } from './sdk-helpers';

/**
 * A ballot replace whose outcome is not proven. The nonce store forgets an
 * SDK-signed replace once its reservation lifetime passes (a write-availability
 * policy, not a protocol deadline), but the transition may still execute and
 * change the ballot. So every ballot replace is recorded here before it is
 * sent, and stays recorded until a verdict, the ballot reaching `revision`
 * (the replace builds on `revision - 1`, so it can never execute after that),
 * or the poll's close (`endsAt`: no ballot write lands after it).
 */
interface UncertainReplace {
  pollId: string;
  ballotId: string;
  /** The revision the replace writes. */
  revision: number;
  /** The poll's close, ms since epoch. */
  endsAt: number;
}

/**
 * How long after `endsAt` a record is kept: the close rule judges block time,
 * so this device's clock gets a margin before the poll counts as closed.
 */
const CLOSE_MARGIN_MS = 30_000;

const UNCERTAIN_PREFIX = scopedKey('yappr:pollr-uncertain-replaces:');

function isUncertainReplace(value: unknown): value is UncertainReplace {
  const r = value as Partial<UncertainReplace> | null;
  return typeof r === 'object' && r !== null && typeof r.pollId === 'string' && typeof r.ballotId === 'string'
    && Number.isInteger(r.revision) && typeof r.endsAt === 'number';
}

/** Throws {@link NONCE_STORE_ERROR} when localStorage cannot be read. */
function loadUncertain(ownerId: string): UncertainReplace[] {
  let entries: UncertainReplace[];
  try {
    const raw = localStorage.getItem(`${UNCERTAIN_PREFIX}${ownerId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    entries = Array.isArray(parsed) ? parsed.filter(isUncertainReplace) : [];
  } catch (error) {
    logger.warn('Pollr: could not read uncertain ballot replaces', { error: extractErrorMessage(error) });
    throw new Error(NONCE_STORE_ERROR);
  }
  // A replace targets a ballot read off the chain, and ballots are never
  // deleted: each record proves its poll has one for good (v6 noBallots),
  // whatever a lagging read shows later. Recorded on every load, before any
  // caller prunes a record (settled, past its poll's close, or another poll's).
  for (const entry of entries) markPollHasBallots(entry.pollId);
  return entries;
}

/**
 * Record, as ballot evidence, every poll this voter's stored ballot replaces
 * name (see loadUncertain). For the v6 delete paths, which may not otherwise
 * read the records (a closed poll's ballot state skips them). An unreadable
 * store adds nothing.
 */
export function noteReplacedBallots(ownerId: string): void {
  try {
    loadUncertain(ownerId);
  } catch {
    // Already logged; the delete paths fail closed on the store on their own.
  }
}

/** Throws {@link NONCE_STORE_ERROR} when localStorage refuses the write. */
function saveUncertain(ownerId: string, entries: UncertainReplace[]): void {
  try {
    const key = `${UNCERTAIN_PREFIX}${ownerId}`;
    if (entries.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(entries));
  } catch (error) {
    logger.warn('Pollr: could not store uncertain ballot replaces', { error: extractErrorMessage(error) });
    throw new Error(NONCE_STORE_ERROR);
  }
}

const sameReplace = (a: UncertainReplace, b: UncertainReplace) =>
  a.pollId === b.pollId && a.ballotId === b.ballotId && a.revision === b.revision;

/**
 * Record a ballot replace before it is sent. Throws {@link NONCE_STORE_ERROR}
 * when it cannot be stored, and the replace must then not be sent: nothing
 * would remember that it may still land.
 */
export function recordBallotReplace(ownerId: string, entry: UncertainReplace): void {
  saveUncertain(ownerId, [...loadUncertain(ownerId).filter((e) => !sameReplace(e, entry)), entry]);
}

/** The replace had a verdict (confirmed or refused by consensus): it will not execute later. */
export function settleBallotReplace(ownerId: string, entry: UncertainReplace): void {
  try {
    saveUncertain(ownerId, loadUncertain(ownerId).filter((e) => !sameReplace(e, entry)));
  } catch {
    // Already logged; the record only keeps the poll pending until it is proven or closes.
  }
}

/**
 * Whether a recorded replace on `pollId` could still change the voter's
 * ballots. Drops the ones the chain proves can no longer execute (the ballot
 * is at the written revision or later) and the ones past the poll's close.
 * A ballot that cannot be read proves nothing, so it counts. Throws
 * {@link NONCE_STORE_ERROR} when the record cannot be read.
 */
async function uncertainReplaceMayLand(ownerId: string, pollId: string): Promise<boolean> {
  const entries = loadUncertain(ownerId);
  const now = Date.now();
  const kept: UncertainReplace[] = [];
  let mayLand = false;
  for (const entry of entries) {
    if (now > entry.endsAt + CLOSE_MARGIN_MS) continue;
    if (entry.pollId !== pollId) {
      kept.push(entry);
      continue;
    }
    let revision: number | null = null;
    try {
      const sdk = await getEvoSdk();
      const document = await sdk.documents.get(POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES.VOTE, entry.ballotId);
      revision = document ? Number(documentToPlainObject(document).$revision ?? NaN) : null;
    } catch (error) {
      logger.warn('Pollr: could not read a ballot to settle an uncertain replace', { error: extractErrorMessage(error) });
    }
    if (revision !== null && Number.isFinite(revision) && revision >= entry.revision) continue;
    kept.push(entry);
    mayLand = true;
  }
  if (kept.length !== entries.length) {
    try {
      saveUncertain(ownerId, kept);
    } catch {
      // Already logged; pruning again next time is harmless.
    }
  }
  return mayLand;
}

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
 * replace the SDK signed has no known nonce; its reservation counts until it is
 * settled (see {@link settlePendingPollrReplaces}, which callers run first) or
 * expires, and past that expiry the ballot replace record above keeps it
 * counting until the chain proves it cannot land or the poll closes.
 * True when the nonce cannot be read while something relevant is pending,
 * since nothing then proves it cannot execute.
 *
 * Throws NONCE_STORE_ERROR when the reservation store cannot be read: nothing
 * is then known about what may still execute, so the caller must not treat
 * the ballots as settled. This blocks nothing that could otherwise work: no
 * Pollr write can be signed without the store either.
 */
export async function pollrWriteMayStillExecute(ownerId: string, pollId: string): Promise<boolean> {
  if (await uncertainReplaceMayLand(ownerId, pollId)) return true;
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
