/**
 * Identity contract nonces for writes this browser makes (QA D-01).
 *
 * Two writes by one identity to one contract that sign the same nonce while
 * neither has executed are both accepted at broadcast; Platform executes one
 * and drops the other without a result. So every write runs under
 * `withIdentityWriteLock`, and every transition this browser signs is
 * recorded here, because Platform's nonce only moves once a transition
 * executes and a node may answer a block behind:
 *  - `mark`, the highest nonce this browser may have signed, and `seen`, the
 *    highest it knows consumed (a node may answer from behind it); the nonces
 *    it picks itself are allocated past both, so none is handed out twice;
 *  - `pending`, each signed transition that may still execute, with the
 *    nonces it may carry, until it is confirmed or refused, or Platform shows
 *    one of those nonces consumed.
 *
 * `stateTransitionService.createDocument` and the wallet token builder pick
 * their nonce with {@link allocateNonce}. Writes the SDK signs itself
 * (document replace and delete, token and moderation transitions) go through
 * {@link withSdkSignedWrite}.
 */
import { Identifier } from '@dashevo/evo-sdk';
import { logger } from '@/lib/logger';
import { scopedKey } from '@/lib/storage-scope';
import { PENDING_WRITE_ERROR, isConsensusRefusal } from '@/lib/error-utils';
import { allocateIdentityContractNonce, identityContractNonceConsumed, nextIdentityContractNonce } from '@/lib/document-id';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { getEvoSdk } from './evo-sdk-service';

/** The nonces a signed transition may carry: one when this browser picked it, a range when the SDK did. */
export interface SignedNonces {
  from: bigint;
  to: bigint;
}

export interface NonceReservation {
  mark: bigint;
  seen: bigint;
  /** `expiresAt` (ms) is when the transition is no longer waited on. */
  pending: (SignedNonces & { expiresAt: number })[];
}

/**
 * How long a signed transition that was neither confirmed nor refused holds
 * up SDK-signed writes. Tenderdash re-checks its mempool after every block and
 * a valid transition executes in the next one, so one that has not executed
 * within minutes was dropped; a wallet can sign one handed to it until its QR
 * gives way (5 minutes). Past this, an SDK-signed write may be refused or time
 * out, but it is never reported as done without its proof, and the nonces
 * this browser picks itself stay past the mark regardless.
 */
const PENDING_LIFETIME_MS = 15 * 60 * 1000;

/** How long an SDK-signed write waits for pending transitions to settle before it gives up. */
const PENDING_POLLS = 5;
const PENDING_POLL_MS = 2_000;

/** Kept in localStorage so every tab sees it; read and written only under the write lock. */
const RESERVATION_PREFIX = scopedKey('yappr:nonce-reservation:');

/** This tab's copy, for when localStorage is blocked. */
const reservations = new Map<string, NonceReservation>();

function reservationKey(ownerId: string, contractId: string): string {
  return `${RESERVATION_PREFIX}${ownerId}:${contractId}`;
}

export function loadReservation(ownerId: string, contractId: string): NonceReservation | null {
  const key = reservationKey(ownerId, contractId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mark: string; seen: string; pending: { from: string; to: string; expiresAt: number }[] };
    return {
      mark: BigInt(parsed.mark),
      seen: BigInt(parsed.seen),
      pending: parsed.pending.map((p) => ({ from: BigInt(p.from), to: BigInt(p.to), expiresAt: p.expiresAt })),
    };
  } catch {
    // Storage blocked or the value unreadable: fall back to this tab's record.
    return reservations.get(key) ?? null;
  }
}

function saveReservation(ownerId: string, contractId: string, reservation: NonceReservation): void {
  const key = reservationKey(ownerId, contractId);
  reservations.set(key, reservation);
  try {
    const pending = reservation.pending.map((p) => ({ from: p.from.toString(), to: p.to.toString(), expiresAt: p.expiresAt }));
    localStorage.setItem(key, JSON.stringify({ mark: reservation.mark.toString(), seen: reservation.seen.toString(), pending }));
  } catch {
    // Storage blocked: only this tab knows, and the write lock still covers it.
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** The highest nonce known taken: the tip `current` reports, or higher if a node is behind. */
function takenUpTo(current: bigint | undefined | null, reservation: NonceReservation | null): bigint {
  const tip = nextIdentityContractNonce(current) - BigInt(1);
  return reservation ? max(reservation.seen, tip) : tip;
}

/**
 * The pending transitions that may still execute, given the raw value
 * `identities.contractNonce` returned: not expired, and no nonce they may
 * carry consumed yet. Consumption is final, so a node that is behind only
 * keeps one pending longer. None is written off for being far ahead of the
 * tip: the node that answered may be behind.
 */
export function stillPending(current: bigint | undefined | null, reservation: NonceReservation | null, now = Date.now()): NonceReservation['pending'] {
  return (reservation?.pending ?? []).filter((p) => {
    if (p.expiresAt <= now) return false;
    for (let nonce = p.from; nonce <= p.to; nonce++) {
      if (identityContractNonceConsumed(current, nonce)) return false;
    }
    return true;
  });
}

/**
 * The nonce a transition this browser builds itself should carry, or null
 * when none is safe: one past every nonce this browser signed or saw taken.
 * When that is too far ahead of the tip for Drive to accept, the one after
 * the tip, but only if nothing signed may still execute.
 */
export function allocateNonce(current: bigint | undefined | null, reservation: NonceReservation | null, now = Date.now()): bigint | null {
  const past = reservation ? max(reservation.mark, reservation.seen) : null;
  const nonce = allocateIdentityContractNonce(current, past);
  if (past !== null && nonce <= past && stillPending(current, reservation, now).length > 0) return null;
  return nonce;
}

/**
 * Record a signed transition before its broadcast (one that errors may still
 * have gone out), with what `current` shows: the tip, and which pending
 * transitions have settled. `mark` and `seen` only rise.
 */
export function reserveNonce(ownerId: string, contractId: string, signed: SignedNonces, current: bigint | undefined | null): void {
  const previous = loadReservation(ownerId, contractId);
  saveReservation(ownerId, contractId, {
    mark: max(previous?.mark ?? BigInt(0), signed.to),
    seen: takenUpTo(current, previous),
    pending: [...stillPending(current, previous), { ...signed, expiresAt: Date.now() + PENDING_LIFETIME_MS }],
  });
}

/**
 * The transition was refused, or it executed (`executed`): either way it will
 * not execute later. One this browser built executed at its own nonce, now
 * taken; which nonce an SDK-signed one took is unknown. The mark stays, so
 * none of its nonces is handed out again.
 */
export function releaseNonce(ownerId: string, contractId: string, signed: SignedNonces, executed: boolean): void {
  const reservation = loadReservation(ownerId, contractId);
  if (!reservation) return;
  saveReservation(ownerId, contractId, {
    mark: reservation.mark,
    seen: executed && signed.from === signed.to ? max(reservation.seen, signed.from) : reservation.seen,
    pending: reservation.pending.filter((p) => p.from !== signed.from || p.to !== signed.to),
  });
}

/**
 * The nonces an SDK-signed write may carry and still execute, once nothing
 * this browser signed may. The SDK signs one past the higher of its own cache
 * and the tip a node of its choosing reports. Every nonce this identity used
 * was signed here and is at most the mark (another device's are beyond any
 * client's knowledge), so neither can put its pick past one beyond the mark
 * or the highest nonce known taken. A pick at or below that is taken, or
 * fills a gap left by a transition that will never execute.
 */
export function sdkSignedRange(current: bigint | undefined | null, reservation: NonceReservation | null): SignedNonces {
  const taken = takenUpTo(current, reservation);
  return { from: taken + BigInt(1), to: max(reservation?.mark ?? BigInt(0), taken) + BigInt(1) };
}

/**
 * Run a write the SDK signs itself under the identity's write lock, in step
 * with the nonces this browser hands out.
 *
 * The SDK can be neither told which nonce to sign nor asked which it signed,
 * so this does not predict it. It holds the write until nothing this browser
 * signed may still execute, so the SDK cannot take one of those nonces, and
 * records every nonce the SDK can pick ({@link sdkSignedRange}): the nonces
 * this browser picks next go past them, and until the write is confirmed or
 * refused, one of them seen consumed means it executed. A consensus refusal is
 * a verdict (a nonce refusal included: the nonce was taken when the broadcast,
 * or the SDK's retry of it, arrived); a timeout, a transport failure or an
 * unproven snapshot is not, and leaves the write pending.
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
        logger.warn(`A transition up to nonce ${reservation?.mark} may still execute (Platform at ${current}); not sending an SDK-signed write`);
        throw new Error(PENDING_WRITE_ERROR);
      }
      logger.debug(`Waiting on nonces up to ${reservation?.mark} before an SDK-signed write (Platform at ${current})`);
      await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
      current = await sdk.identities.contractNonce(ownerId, contractId);
    }
    const signed = sdkSignedRange(current, reservation);
    try { await sdk.wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
    reserveNonce(ownerId, contractId, signed, current);
    try {
      const result = await write();
      releaseNonce(ownerId, contractId, signed, true);
      return result;
    } catch (error) {
      if (isConsensusRefusal(error)) releaseNonce(ownerId, contractId, signed, false);
      throw error;
    }
  });
}
