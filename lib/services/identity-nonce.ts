/**
 * Identity contract nonces for writes this browser makes (QA D-01).
 *
 * Two transitions by one identity to one contract that carry the same nonce
 * and are both still able to execute are both accepted at broadcast; Platform
 * executes one and drops the other without a result. So every write runs
 * under `withIdentityWriteLock`, and every transition this browser signs is
 * recorded here as pending until it is confirmed or refused, Platform shows
 * its nonce consumed, or it is too old to execute:
 *  - a transition this browser built itself carries a nonce it chose, past
 *    `mark` (the highest it chose), so it never shares one with another it
 *    built, whether that one executed or not;
 *  - a transition the SDK signed carries a nonce the SDK neither takes nor
 *    reports, so nothing is known about it: while one may still execute, no
 *    other write starts. An SDK-signed write likewise starts only once
 *    nothing this browser signed may still execute.
 * No nonce is ever guessed.
 *
 * `stateTransitionService.createDocument` and the wallet token builder choose
 * their nonce with {@link allocateNonce}. Writes the SDK signs itself
 * (document replace and delete, token and moderation transitions) go through
 * {@link withSdkSignedWrite}.
 */
import { Identifier } from '@dashevo/evo-sdk';
import { logger } from '@/lib/logger';
import { scopedKey } from '@/lib/storage-scope';
import { NONCE_STORE_ERROR, PENDING_WRITE_ERROR, isAffectedStateSnapshotError, isConsensusRefusal } from '@/lib/error-utils';
import { allocateIdentityContractNonce, identityContractNonceConsumed } from '@/lib/document-id';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { getEvoSdk } from './evo-sdk-service';

/** A signed transition that may still execute. `nonce` is null when the SDK chose it. */
export interface PendingTransition {
  id: string;
  nonce: bigint | null;
  expiresAt: number;
}

export interface NonceReservation {
  /** The highest nonce this browser chose for the identity on the contract. */
  mark: bigint;
  pending: PendingTransition[];
}

/**
 * How long a signed transition that was neither confirmed nor refused is
 * treated as able to execute. Tenderdash re-checks its mempool after every
 * block and a valid transition executes in the next one, so one that has not
 * executed within minutes of its broadcast was dropped; a wallet can sign one
 * handed to it until its QR gives way (5 minutes).
 */
const PENDING_LIFETIME_MS = 15 * 60 * 1000;

/** How long an SDK-signed write waits for pending transitions to settle before it gives up. */
const PENDING_POLLS = 5;
const PENDING_POLL_MS = 2_000;

/**
 * Kept in localStorage, the one copy every tab reads and writes, only under
 * the write lock. A transition is signed only once its reservation is stored
 * there: one this tab alone knew of would be invisible to the next tab to take
 * the lock.
 */
const RESERVATION_PREFIX = scopedKey('yappr:nonce-reservation:');

/**
 * Entries this tab released (each on a verdict) whose release localStorage may
 * not have stored: never read back as pending, so a failed write cannot bring
 * a settled one back.
 */
const released = new Set<string>();

function reservationKey(ownerId: string, contractId: string): string {
  return `${RESERVATION_PREFIX}${ownerId}:${contractId}`;
}

/**
 * Throws {@link NONCE_STORE_ERROR} when localStorage cannot be read: nothing
 * is then known about what this browser signed, so nothing is sent.
 */
export function loadReservation(ownerId: string, contractId: string): NonceReservation | null {
  try {
    const raw = localStorage.getItem(reservationKey(ownerId, contractId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mark: string; pending: { id: string; nonce: string | null; expiresAt: number }[] };
    return {
      mark: BigInt(parsed.mark),
      pending: parsed.pending
        .filter((p) => !released.has(p.id))
        .map((p) => ({ id: p.id, nonce: p.nonce === null ? null : BigInt(p.nonce), expiresAt: p.expiresAt })),
    };
  } catch (error) {
    logger.warn('Could not read nonce reservations:', error);
    throw new Error(NONCE_STORE_ERROR);
  }
}

/** Throws {@link NONCE_STORE_ERROR} when localStorage refuses the write (blocked or full). */
function saveReservation(ownerId: string, contractId: string, reservation: NonceReservation): void {
  try {
    const pending = reservation.pending.map((p) => ({ id: p.id, nonce: p.nonce === null ? null : p.nonce.toString(), expiresAt: p.expiresAt }));
    localStorage.setItem(reservationKey(ownerId, contractId), JSON.stringify({ mark: reservation.mark.toString(), pending }));
  } catch (error) {
    logger.warn('Could not store nonce reservations:', error);
    throw new Error(NONCE_STORE_ERROR);
  }
}

/**
 * The pending transitions that may still execute, given the raw value
 * `identities.contractNonce` returned: not expired, and not one whose own
 * nonce is consumed. Consumption is final, so a node that is behind only
 * keeps one pending longer. Nothing about an SDK-signed one is known, so it
 * stays pending until its outcome is known or it expires.
 */
export function stillPending(current: bigint | undefined | null, reservation: NonceReservation | null, now = Date.now()): PendingTransition[] {
  return (reservation?.pending ?? []).filter((p) => p.expiresAt > now && (p.nonce === null || !identityContractNonceConsumed(current, p.nonce)));
}

/**
 * The nonce a transition this browser builds itself should carry, or null
 * when none is safe: one past the mark, so it never takes a nonce this browser
 * chose before. None while an SDK-signed transition may still execute (its
 * nonce is unknown), nor when one past the mark is too far ahead of the tip
 * for Drive to accept and a transition may still execute at the one after it.
 */
export function allocateNonce(current: bigint | undefined | null, reservation: NonceReservation | null, now = Date.now()): bigint | null {
  const live = stillPending(current, reservation, now);
  if (live.some((p) => p.nonce === null)) return null;
  const nonce = allocateIdentityContractNonce(current, reservation?.mark ?? null);
  if (reservation && nonce <= reservation.mark && live.length > 0) return null;
  return nonce;
}

/**
 * Record a signed transition as pending before its broadcast (one that errors
 * may still have gone out), dropping what `current` shows settled. `nonce` is
 * null for one the SDK signs. The mark never goes down. Throws
 * {@link NONCE_STORE_ERROR} when localStorage cannot hold it, and the
 * transition must then not be sent.
 */
export function reserveNonce(ownerId: string, contractId: string, nonce: bigint | null, current: bigint | undefined | null): PendingTransition {
  const previous = loadReservation(ownerId, contractId);
  // Unique across tabs: releasing one must never release another.
  const entry = { id: crypto.randomUUID(), nonce, expiresAt: Date.now() + PENDING_LIFETIME_MS };
  const mark = previous?.mark ?? BigInt(0);
  saveReservation(ownerId, contractId, {
    mark: nonce !== null && nonce > mark ? nonce : mark,
    pending: [...stillPending(current, previous), entry],
  });
  return entry;
}

/**
 * The transition was confirmed or refused: it will not execute later. The
 * mark stays. When localStorage refuses the write, other tabs keep the entry
 * pending until it expires, which only holds their writes back.
 */
export function releaseNonce(ownerId: string, contractId: string, entry: PendingTransition): void {
  try {
    const reservation = loadReservation(ownerId, contractId);
    if (reservation?.pending.some((p) => p.id === entry.id)) {
      saveReservation(ownerId, contractId, { mark: reservation.mark, pending: reservation.pending.filter((p) => p.id !== entry.id) });
    }
  } catch {
    // Already logged; this tab no longer reads it as pending.
  } finally {
    released.add(entry.id);
  }
}

/**
 * Run a write the SDK signs itself under the identity's write lock.
 *
 * The SDK signs one past the higher of its own cache and the tip a node of its
 * choosing reports, and does not say which, so nothing here predicts it. The
 * write starts only once nothing this browser signed may still execute, so
 * whatever it signs cannot meet one of those. It is recorded as pending with
 * no nonce: if its outcome stays unknown (a timeout, a transport failure) no
 * later write starts until it expires. A consensus refusal is a verdict (a
 * nonce refusal included: the nonce was taken when the broadcast, or the
 * SDK's retry of it, arrived). So, for its nonce, is the affected-state
 * snapshot a strict wait refuses: DAPI answers with a proof only for a
 * transition that executed (rs-dapi `wait_for_state_transition_result`); what
 * the snapshot leaves unproven is only the write's effect, which the caller
 * reads back.
 *
 * While a pending transition may still execute this waits briefly, then fails
 * without sending anything.
 */
export async function withSdkSignedWrite<T>(ownerId: string, contractId: string, write: () => Promise<T>): Promise<T> {
  return withIdentityWriteLock(ownerId, contractId, async () => {
    const sdk = await getEvoSdk();
    const reservation = loadReservation(ownerId, contractId);
    let current = await sdk.identities.contractNonce(ownerId, contractId);
    for (let attempt = 0; stillPending(current, reservation).length > 0; attempt++) {
      if (attempt === PENDING_POLLS) {
        logger.warn(`An earlier transition may still execute (Platform at ${current}); not sending an SDK-signed write`);
        throw new Error(PENDING_WRITE_ERROR);
      }
      logger.debug(`Waiting on an earlier transition before an SDK-signed write (Platform at ${current})`);
      await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
      current = await sdk.identities.contractNonce(ownerId, contractId);
    }
    try { await sdk.wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
    const entry = reserveNonce(ownerId, contractId, null, current);
    try {
      const result = await write();
      releaseNonce(ownerId, contractId, entry);
      return result;
    } catch (error) {
      if (isConsensusRefusal(error) || isAffectedStateSnapshotError(error)) releaseNonce(ownerId, contractId, entry);
      throw error;
    }
  });
}
