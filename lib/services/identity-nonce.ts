/**
 * Identity contract nonces for writes this browser makes (QA D-01, #644).
 *
 * Two transitions by one identity to one contract that carry the same nonce
 * and are both still able to execute are both accepted at broadcast; Platform
 * executes one and drops the other without a result. So every write runs
 * under `withIdentityWriteLock`, and every transition this browser signs is
 * recorded here as pending until it is confirmed or refused, or Platform shows
 * it can no longer execute:
 *  - a transition this browser built itself carries a nonce it chose, past
 *    `mark`, so it never shares one with another it built, whether that one
 *    executed or not. It is settled once Platform shows that nonce consumed.
 *  - a transition the SDK signed carries a nonce the SDK neither takes nor
 *    reports. It starts only once nothing this browser signed may still
 *    execute. The SDK signs one past the higher of the tip a node gives it and
 *    the last nonce it signed in this tab (`refreshIdentityNonce` makes it
 *    read the tip again, but keeps that last nonce), so what it signs lies
 *    after `signedAfter` (the tip read under the lock, or `floor` when that
 *    read is behind what this browser saw spent) and no later than
 *    `signedAtMost` (one past the higher of that and `mark`, which every nonce
 *    this browser signed or may have signed is at most). The mark goes to
 *    `signedAtMost`, so nothing this browser builds takes any nonce in that
 *    range, and the transition is settled once Platform shows any nonce in it
 *    consumed: nothing but this transition can take one while it is pending.
 * A lost answer therefore holds nothing back once its transition lands: the
 * next write reads the tip, sees it, and goes ahead.
 *
 * One gap stays, the one the write lock has too (`identity-write-lock.ts`):
 * another device can write between the tip read and the SDK's signature.
 * Creates catch such a clash after the fact (`stateTransitionService.createDocument`).
 *
 * `stateTransitionService.createDocument` and the wallet token builder choose
 * their nonce with {@link allocateNonce}, through {@link awaitNonce}. Writes
 * the SDK signs itself (document replace and delete, token and moderation
 * transitions) go through {@link withSdkSignedWrite}.
 */
import { Identifier } from '@dashevo/evo-sdk';
import { logger } from '@/lib/logger';
import { scopedKey } from '@/lib/storage-scope';
import { NONCE_STORE_ERROR, PENDING_WRITE_ERROR, isConsensusRefusal, isIdentityNonceConflictError, isNonceSpentRefusal } from '@/lib/error-utils';
import { allocateIdentityContractNonce, identityContractNonceConsumed, nextIdentityContractNonce } from '@/lib/document-id';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { getEvoSdk } from './evo-sdk-service';

/** A signed transition that may still execute. */
export interface PendingTransition {
  id: string;
  /** The nonce it carries, or null when the SDK chose it. */
  nonce: bigint | null;
  /** With a null nonce: the SDK signed a nonce after this one (see the module comment). */
  signedAfter?: bigint;
  /** With a null nonce: and no later than this one. */
  signedAtMost?: bigint;
  /** With a null nonce: when it stops holding writes back unless settled first (see {@link PENDING_LIFETIME_MS}). */
  expiresAt: number | null;
  /**
   * What the transition writes, as an opaque key its caller chose (a Pollr
   * ballot names its poll), so a caller can tell which pending transitions can
   * touch what it is about to do. Absent means unknown: it may touch anything.
   */
  scope?: string;
}

export interface NonceReservation {
  /** The highest nonce this browser signed, or that the SDK may have signed for it, for the identity on the contract. */
  mark: bigint;
  /** The highest nonce this browser knows spent: one it saw at the tip, or one it saw its own transition take. */
  floor: bigint;
  pending: PendingTransition[];
}

/**
 * How long an SDK-signed transition that Platform never shows settled holds
 * other writes back, counted from when its answer was lost. It is settled as
 * soon as a nonce it may carry is consumed, so this is only reached by one
 * that never took one: dropped, or refused without an answer. Tenderdash
 * re-checks its mempool after every block and a valid transition executes in
 * the next one, so a minute is many blocks past the one it would have
 * executed in. A transition whose nonce is known (a create, a wallet request)
 * never expires: it stays pending until Platform shows that nonce consumed.
 */
const PENDING_LIFETIME_MS = 60 * 1000;

/** How long a write waits for pending transitions to settle before it gives up unsent. */
const PENDING_POLLS = 5;
const PENDING_POLL_MS = 2_000;

/** The sequence part of an identity contract nonce (the upper 24 bits are its missing-revision set). */
const NONCE_SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1);

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

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** The sequence part of the raw value `identities.contractNonce` returned: the last nonce Platform executed. */
const tipOf = (current: bigint | undefined | null): bigint => nextIdentityContractNonce(current) - BigInt(1);

/** The lowest nonce `entry` can carry. */
const lowestNonceOf = (entry: PendingTransition): bigint => entry.nonce ?? (entry.signedAfter ?? BigInt(0)) + BigInt(1);

/** Whether Platform shows any nonce from `from` to `to` consumed (none past the tip is; every one far behind it is). */
function anyConsumed(current: bigint | undefined | null, from: bigint, to: bigint): boolean {
  const last = to < tipOf(current) ? to : tipOf(current);
  for (let nonce = from; nonce <= last; nonce++) {
    if (identityContractNonceConsumed(current, nonce)) return true;
  }
  return false;
}

/** A stored sequence number, or undefined. */
function sequence(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) & NONCE_SEQUENCE_MASK : undefined;
}

/**
 * Throws {@link NONCE_STORE_ERROR} when localStorage cannot be read: nothing
 * is then known about what this browser signed, so nothing is sent.
 */
export function loadReservation(ownerId: string, contractId: string): NonceReservation | null {
  try {
    const raw = localStorage.getItem(reservationKey(ownerId, contractId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      mark: string;
      floor?: unknown;
      pending: { id: string; nonce: string | null; signedAfter?: unknown; signedAtMost?: unknown; expiresAt: number | null; scope?: unknown }[];
    };
    return {
      mark: BigInt(parsed.mark),
      floor: sequence(parsed.floor) ?? BigInt(0),
      pending: parsed.pending
        .filter((p) => !released.has(p.id))
        .map((p) => {
          const signedAfter = p.nonce === null ? sequence(p.signedAfter) : undefined;
          const signedAtMost = p.nonce === null ? sequence(p.signedAtMost) : undefined;
          return {
            id: p.id,
            nonce: p.nonce === null ? null : BigInt(p.nonce),
            expiresAt: p.expiresAt,
            // Both, or neither: one without its range only expires.
            ...(signedAfter !== undefined && signedAtMost !== undefined ? { signedAfter, signedAtMost } : {}),
            ...(typeof p.scope === 'string' ? { scope: p.scope } : {}),
          };
        }),
    };
  } catch (error) {
    logger.warn('Could not read nonce reservations:', error);
    throw new Error(NONCE_STORE_ERROR);
  }
}

/** Throws {@link NONCE_STORE_ERROR} when localStorage refuses the write (blocked or full). */
function saveReservation(ownerId: string, contractId: string, reservation: NonceReservation): void {
  try {
    const pending = reservation.pending.map((p) => ({
      id: p.id,
      nonce: p.nonce === null ? null : p.nonce.toString(),
      expiresAt: p.expiresAt,
      ...(p.signedAfter !== undefined && p.signedAtMost !== undefined
        ? { signedAfter: p.signedAfter.toString(), signedAtMost: p.signedAtMost.toString() }
        : {}),
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
    }));
    localStorage.setItem(
      reservationKey(ownerId, contractId),
      JSON.stringify({ mark: reservation.mark.toString(), floor: reservation.floor.toString(), pending })
    );
  } catch (error) {
    logger.warn('Could not store nonce reservations:', error);
    throw new Error(NONCE_STORE_ERROR);
  }
}

/**
 * The pending transitions that may still execute, given the raw value
 * `identities.contractNonce` returned: not one whose nonce (or, SDK-signed,
 * any nonce it may carry) is consumed, and not an SDK-signed one past its
 * lifetime. Consumption is final, so a node that is behind only keeps one
 * pending longer.
 */
export function stillPending(current: bigint | undefined | null, reservation: NonceReservation | null, now = Date.now()): PendingTransition[] {
  return (reservation?.pending ?? []).filter((p) => {
    if (p.nonce !== null) return !identityContractNonceConsumed(current, p.nonce);
    if (p.expiresAt !== null && p.expiresAt <= now) return false;
    if (p.signedAfter === undefined || p.signedAtMost === undefined) return true;
    return !anyConsumed(current, p.signedAfter + BigInt(1), p.signedAtMost);
  });
}

/**
 * The nonce a transition this browser builds itself should carry, or null
 * when none is safe: one past the mark, so it never takes a nonce this browser
 * signed or may have signed before. None while an SDK-signed transition may
 * still execute (its nonce is unknown), nor when one past the mark is too far
 * ahead of the tip for Drive to accept and a transition may still execute at
 * the one after it.
 */
export function allocateNonce(current: bigint | undefined | null, reservation: NonceReservation | null, now = Date.now()): bigint | null {
  const live = stillPending(current, reservation, now);
  if (live.some((p) => p.nonce === null)) return null;
  const nonce = allocateIdentityContractNonce(current, reservation?.mark ?? null);
  if (reservation && nonce <= reservation.mark && live.length > 0) return null;
  return nonce;
}

/**
 * Read the identity's contract nonce until `ready` finds what a write needs
 * in it (a nonce, or nothing pending), re-reading for a few seconds while an
 * earlier transition settles: one whose answer was lost settles as soon as a
 * node shows it landed. Throws {@link PENDING_WRITE_ERROR}, with nothing
 * sent, when that takes longer. Runs under the caller's write lock.
 */
export async function awaitNonce<T>(
  ownerId: string,
  contractId: string,
  ready: (current: bigint | undefined, reservation: NonceReservation | null) => T | null
): Promise<{ current: bigint | undefined; value: T }> {
  const sdk = await getEvoSdk();
  for (let attempt = 0; ; attempt++) {
    const current = await sdk.identities.contractNonce(ownerId, contractId);
    const value = ready(current, loadReservation(ownerId, contractId));
    if (value !== null) return { current, value };
    if (attempt === PENDING_POLLS) {
      logger.warn(`An earlier transition may still execute (Platform at ${current}); not sending`);
      throw new Error(PENDING_WRITE_ERROR);
    }
    logger.debug(`Waiting on an earlier transition before a write (Platform at ${current})`);
    await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
  }
}

/**
 * Record a signed transition as pending before its broadcast (one that errors
 * may still have gone out), dropping what `current` shows settled. `nonce` is
 * null for one the SDK signs. Neither the mark nor the floor ever goes down.
 * Throws {@link NONCE_STORE_ERROR} when localStorage cannot hold it, and the
 * transition must then not be sent.
 */
export function reserveNonce(
  ownerId: string,
  contractId: string,
  nonce: bigint | null,
  current: bigint | undefined | null,
  scope?: string
): PendingTransition {
  const previous = loadReservation(ownerId, contractId);
  const mark = previous?.mark ?? BigInt(0);
  const floor = max(previous?.floor ?? BigInt(0), tipOf(current));
  // Unique across tabs: releasing one must never release another.
  const id = crypto.randomUUID();
  const entry: PendingTransition = nonce === null
    ? { id, nonce, signedAfter: floor, signedAtMost: max(floor, mark) + BigInt(1), expiresAt: Date.now() + PENDING_LIFETIME_MS }
    : { id, nonce, expiresAt: null };
  if (scope !== undefined) entry.scope = scope;
  saveReservation(ownerId, contractId, {
    mark: max(mark, entry.nonce ?? entry.signedAtMost ?? BigInt(0)),
    floor,
    pending: [...stillPending(current, previous), entry],
  });
  return entry;
}

/**
 * The transition was confirmed or refused: it will not execute later. The
 * mark stays. `spent` (the default) says it took its nonce (a confirmed one,
 * or a paid refusal of one this browser built), and raises the floor to the
 * lowest it can carry; pass false when it may not have. When localStorage
 * refuses the write, other tabs keep the entry pending until it settles on
 * chain, which only holds their writes back.
 */
export function releaseNonce(ownerId: string, contractId: string, entry: PendingTransition, spent = true): void {
  try {
    const reservation = loadReservation(ownerId, contractId);
    if (reservation) {
      const pending = reservation.pending.filter((p) => p.id !== entry.id);
      const floor = spent ? max(reservation.floor, lowestNonceOf(entry)) : reservation.floor;
      if (pending.length !== reservation.pending.length || floor !== reservation.floor) {
        saveReservation(ownerId, contractId, { mark: reservation.mark, floor, pending });
      }
    }
  } catch {
    // Already logged; this tab no longer reads it as pending.
  } finally {
    released.add(entry.id);
  }
}

/**
 * An SDK-signed transition's answer was lost: its lifetime starts now, not
 * when it was reserved, since the SDK's own fetches and retries can take most
 * of it. Best effort: when localStorage refuses, it expires a little sooner.
 */
function renewPending(ownerId: string, contractId: string, entry: PendingTransition): void {
  try {
    const reservation = loadReservation(ownerId, contractId);
    if (!reservation?.pending.some((p) => p.id === entry.id)) return;
    const expiresAt = Date.now() + PENDING_LIFETIME_MS;
    saveReservation(ownerId, contractId, { ...reservation, pending: reservation.pending.map((p) => (p.id === entry.id ? { ...p, expiresAt } : p)) });
  } catch {
    // Already logged.
  }
}

/** A write's precondition no longer held under the write lock: nothing was reserved or sent. */
export const WRITE_PRECONDITION_FAILED = 'This was not sent: what it depended on changed.';

/** Whether `error` shows the transition will not execute later (see {@link withSdkSignedWrite}). */
function isVerdict(error: unknown): boolean {
  if (isIdentityNonceConflictError(error)) return isNonceSpentRefusal(error);
  return isConsensusRefusal(error);
}

/**
 * Run a write the SDK signs itself under the identity's write lock.
 *
 * The write starts only once nothing this browser signed may still execute
 * (waiting a few seconds for that, then failing unsent with
 * {@link PENDING_WRITE_ERROR}). It is recorded as pending with no nonce and
 * the range of nonces it may carry (see the module comment): if its outcome
 * stays unknown (a timeout, a transport failure), the next write goes ahead
 * as soon as Platform shows one of them consumed. A consensus refusal is a
 * verdict, but a nonce refusal only when it shows the nonce spent ("already
 * present", "too far in past"): "too far in future" can come from a node
 * behind one that admitted the same transition. A refusal does not show the
 * nonce taken (the SDK does not say whether it was refused before or after
 * execution), so it leaves the floor as it was.
 *
 * `scope` is stored with its pending entry (see {@link PendingTransition.scope}).
 *
 * `precondition`, when given, is the last word on whether to send: it runs
 * under the lock, after every earlier transition has settled and before a
 * nonce is reserved, so nothing this browser signs can land between the check
 * and the write. When it resolves false the write fails with
 * {@link WRITE_PRECONDITION_FAILED} and nothing is reserved or sent.
 */
export async function withSdkSignedWrite<T>(
  ownerId: string,
  contractId: string,
  write: () => Promise<T>,
  scope?: string,
  precondition?: () => Promise<boolean>
): Promise<T> {
  return withIdentityWriteLock(ownerId, contractId, async () => {
    const { current } = await awaitNonce(ownerId, contractId, (tip, reservation) => (stillPending(tip, reservation).length === 0 ? true : null));
    if (precondition && !(await precondition())) throw new Error(WRITE_PRECONDITION_FAILED);
    const sdk = await getEvoSdk();
    try { await sdk.wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
    const entry = reserveNonce(ownerId, contractId, null, current, scope);
    try {
      const result = await write();
      releaseNonce(ownerId, contractId, entry);
      return result;
    } catch (error) {
      if (isVerdict(error)) releaseNonce(ownerId, contractId, entry, false);
      else renewPending(ownerId, contractId, entry);
      throw error;
    }
  });
}

/**
 * Drop every pending transition of the identity on the contract that Platform
 * shows can no longer execute (see {@link stillPending}), and resolve to how
 * many it dropped. Every write does this itself when it starts; a caller that
 * wants to know whether a write whose answer was lost has since settled (a
 * delivery kit read back at its new revision) runs it directly. A failed read
 * proves nothing and drops nothing. Runs under the write lock, so no write is
 * in flight while it reads.
 */
export async function settlePendingWrites(ownerId: string, contractId: string): Promise<number> {
  return withIdentityWriteLock(ownerId, contractId, async () => {
    const reservation = loadReservation(ownerId, contractId);
    if (!reservation || reservation.pending.length === 0) return 0;
    let current: bigint | undefined;
    try {
      const sdk = await getEvoSdk();
      current = await sdk.identities.contractNonce(ownerId, contractId);
    } catch (error) {
      logger.debug('Could not read the contract nonce to settle pending writes:', error);
      return 0;
    }
    const pending = stillPending(current, reservation);
    const settled = reservation.pending.length - pending.length;
    if (settled > 0) saveReservation(ownerId, contractId, { mark: reservation.mark, floor: max(reservation.floor, tipOf(current)), pending });
    return settled;
  });
}
