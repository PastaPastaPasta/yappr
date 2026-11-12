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
import { Identifier } from '@dashevo/wasm-sdk';
import { logger } from '@/lib/logger';
import { NONCE_STORE_ERROR, PENDING_WRITE_ERROR, isConsensusRefusal, isIdentityNonceConflictError, isNonceSpentRefusal, sentWriteOutcomeUnknown } from '@/lib/error-utils';
import { allocateIdentityContractNonce, identityContractNonceConsumed, nextIdentityContractNonce } from '@/lib/document-id';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { CriticalKeyCancelledError } from '@/lib/auth/critical-key';
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
   * touch what it is about to do. App writes may bypass each other only when
   * both scopes are present and differ. Absent means unknown: it may touch
   * anything. Moderation uses `moderation:<contract>:identity:<identity>` or
   * `moderation:<contract>:document:<type>:<id>` across all actions on a target.
   * Fee claims use `moderation:<contract>:pot:<pot>`.
   * Wallet requests use WALLET_TOKEN_SCOPE and impose no ordering constraint.
   */
  scope?: string;
}

export interface NonceReservation {
  /** The highest nonce this browser signed, or that the SDK may have signed for it, for the identity on the contract. */
  mark: bigint;
  /** The highest nonce this browser knows spent: one it saw at the tip, or one it saw its own transition take. */
  floor: bigint;
  pending: PendingTransition[];
  /** Deployment-scoped unsigned wallet payment records, retained until their outcomes are resolved. */
  walletPayments?: Record<string, string>;
}

/**
 * How long an SDK-signed transition that Platform never shows settled holds
 * other writes back, counted from when the page sending it last worked on it
 * (its answer was lost, or the page closed). It is settled as soon as a nonce
 * it may carry is consumed, so this is only reached by one that never took
 * one: dropped, or refused without an answer. One that expires still counts
 * the nonces it may carry as spent (see `floorAfterSettling`). Tenderdash
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
 * the lock. Not scoped to the deployment (`lib/storage-scope.ts`), like the
 * lock itself: a nonce belongs to the identity and the contract, and two
 * deployments on one origin (`/` and `/staging`) can write to the same
 * contract. The contract id in the key keeps deployments on different
 * contracts apart.
 */
const RESERVATION_PREFIX = 'yappr:nonce-reservation:';

export const WALLET_TOKEN_SCOPE = 'wallet-token';

/**
 * Entries this tab released (each on a verdict) whose release localStorage may
 * not have stored: never read back as pending, so a failed write cannot bring
 * a settled one back.
 */
const released = new Set<string>();

/**
 * Floors this tab raised (per reservation key) that localStorage may not have
 * stored, for the same reason: never read back lower.
 */
const raisedFloors = new Map<string, bigint>();

function reservationKey(ownerId: string, contractId: string): string {
  return `${RESERVATION_PREFIX}${ownerId}:${contractId}`;
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** The sequence part of the raw value `identities.contractNonce` returned: the last nonce Platform executed. */
const tipOf = (current: bigint | undefined | null): bigint => nextIdentityContractNonce(current) - BigInt(1);

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
      walletPayments?: Record<string, string>;
    };
    return {
      mark: BigInt(parsed.mark),
      ...(parsed.walletPayments ? { walletPayments: parsed.walletPayments } : {}),
      floor: max(sequence(parsed.floor) ?? BigInt(0), raisedFloors.get(reservationKey(ownerId, contractId)) ?? BigInt(0)),
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
      JSON.stringify({ mark: reservation.mark.toString(), floor: reservation.floor.toString(), pending, walletPayments: reservation.walletPayments })
    );
  } catch (error) {
    logger.warn('Could not store nonce reservations:', error);
    throw new Error(NONCE_STORE_ERROR);
  }
}

/** Caller holds the identity write lock, including while creating the unsigned request. */
export function storeWalletPayments(ownerId: string, contractId: string, scope: string, records: string): void {
  const reservation = loadReservation(ownerId, contractId);
  if (!reservation) throw new Error(NONCE_STORE_ERROR);
  saveReservation(ownerId, contractId, { ...reservation, walletPayments: { ...reservation.walletPayments, [scope]: records } });
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
  const live = stillPending(current, previous);
  const floor = floorAfterSettling(current, previous, live) ?? max(raisedFloors.get(reservationKey(ownerId, contractId)) ?? BigInt(0), tipOf(current));
  // Unique across tabs: releasing one must never release another.
  const id = crypto.randomUUID();
  const entry: PendingTransition = nonce === null
    ? { id, nonce, signedAfter: floor, signedAtMost: max(floor, mark) + BigInt(1), expiresAt: Date.now() + PENDING_LIFETIME_MS }
    : { id, nonce, expiresAt: null };
  if (scope !== undefined) entry.scope = scope;
  saveReservation(ownerId, contractId, {
    ...(previous?.walletPayments ? { walletPayments: previous.walletPayments } : {}),
    mark: max(mark, entry.nonce ?? entry.signedAtMost ?? BigInt(0)),
    floor,
    pending: [...live, entry],
  });
  return entry;
}

/**
 * The floor once `current` was read and the entries not in `live` dropped:
 * at least the tip, and at least the last nonce of an SDK-signed entry that
 * expired. That one never showed landing, but it was never refused either
 * (its page may have closed mid-write), so it may still take any nonce in its
 * range; nothing in that range may then settle a later write. Null without
 * a reservation.
 */
function floorAfterSettling(current: bigint | undefined | null, reservation: NonceReservation | null, live: PendingTransition[]): bigint | null {
  if (!reservation) return null;
  return reservation.pending
    .filter((p) => !live.includes(p) && p.nonce === null && p.signedAtMost !== undefined && !anyConsumed(current, (p.signedAfter ?? BigInt(0)) + BigInt(1), p.signedAtMost))
    .reduce((floor, p) => max(floor, p.signedAtMost ?? floor), max(reservation.floor, tipOf(current)));
}

/**
 * The transition was confirmed or refused: it will not execute later. The
 * mark stays. `spentThrough`, when given, is a nonce Platform has executed
 * (the one the transition took, when it took one) and raises the floor to it.
 * When localStorage refuses the write, other tabs keep the entry pending
 * until it settles on chain, which only holds their writes back.
 */
export function releaseNonce(ownerId: string, contractId: string, entry: PendingTransition, spentThrough?: bigint): void {
  try {
    const reservation = loadReservation(ownerId, contractId);
    if (reservation) {
      const pending = reservation.pending.filter((p) => p.id !== entry.id);
      const floor = spentThrough === undefined ? reservation.floor : max(reservation.floor, spentThrough);
      if (pending.length !== reservation.pending.length || floor !== reservation.floor) {
        saveReservation(ownerId, contractId, { ...reservation, floor, pending });
      }
    }
  } catch {
    // Already logged; this tab no longer reads it as pending, nor the floor lower.
  } finally {
    released.add(entry.id);
    if (spentThrough !== undefined) {
      const key = reservationKey(ownerId, contractId);
      raisedFloors.set(key, max(raisedFloors.get(key) ?? BigInt(0), spentThrough));
    }
  }
}

/**
 * Start an SDK-signed transition's lifetime over: the page is still waiting on
 * the SDK, or has just lost the answer. Best effort: when localStorage
 * refuses, it expires a little sooner.
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

/** How often, and how far apart, Platform is read for the nonce an answered SDK-signed transition took. */
const SPENT_READS = 3;
const SPENT_READ_MS = 1_000;

/**
 * The nonce an answered SDK-signed transition took, to raise the floor to
 * (`executed`: it was confirmed; otherwise refused, which it may have been
 * before or after it executed). Every nonce up to `signedAfter` was spent
 * before it, and nothing else of this browser can take one in its range, so
 * the tip Platform shows once a nonce in the range is consumed is the one it
 * took. A confirmed one whose range holds a single nonce, signed past the tip
 * read before it (`tipBefore`), took that one. A floor too low lets a node
 * that is behind settle a later write early (a nonce of this one in that
 * write's range), and a floor too high makes a later lost answer wait out its
 * lifetime while the SDK signs below it (until a create, which takes a nonce
 * past the mark, brings the tip past the floor). Only the first can lose a
 * write, so one Platform does not show in its range within a few reads,
 * confirmed or refused (a refusal may have been a paid one), counts as having
 * taken the last nonce of its range.
 */
async function nonceTakenOnAnswer(
  ownerId: string,
  contractId: string,
  entry: PendingTransition,
  executed: boolean,
  tipBefore: bigint
): Promise<bigint | undefined> {
  if (entry.signedAfter === undefined || entry.signedAtMost === undefined) return undefined;
  const from = entry.signedAfter + BigInt(1);
  if (executed && from === entry.signedAtMost && entry.signedAfter === tipBefore) return from;
  for (let attempt = 0; attempt < SPENT_READS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SPENT_READ_MS));
    try {
      const sdk = await getEvoSdk();
      const current = await sdk.identities.contractNonce(ownerId, contractId);
      if (anyConsumed(current, from, entry.signedAtMost)) return tipOf(current);
    } catch (error) {
      logger.debug('Could not read the contract nonce after an SDK-signed write:', error);
    }
  }
  return entry.signedAtMost;
}

/** Preparation failed before a chosen-nonce transition could be broadcast. */
export class ChosenWriteNotSentError extends Error {
  constructor(readonly reason: unknown) {
    super('This change hasn’t been sent. Please try again.');
    this.name = 'ChosenWriteNotSentError';
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
 * Without a chosen-nonce builder, the write starts only once nothing this
 * browser signed may still execute
 * (waiting a few seconds for that, then failing unsent with
 * {@link PENDING_WRITE_ERROR}). It is recorded as pending with no nonce and
 * the range of nonces it may carry (see the module comment): if its outcome
 * stays unknown (a timeout, a transport failure), the next write goes ahead
 * as soon as Platform shows one of them consumed. A consensus refusal is a
 * verdict, but a nonce refusal only when it shows the nonce spent ("already
 * present", "too far in past"): "too far in future" can come from a node
 * behind one that admitted the same transition. On an answer the floor goes
 * to the nonce it took, read back from Platform ({@link nonceTakenOnAnswer}).
 *
 * `writeWithNonce`, when supplied, builds the same action with a chosen nonce
 * past the mark if known-nonce transitions remain outstanding after the normal
 * wait, but only when both app writes have scopes and those scopes differ.
 * Same-scope writes, or app writes unscoped on either side, keep waiting and
 * fail unsent with PENDING_WRITE_ERROR if they do not settle. Wallet requests
 * never impose ordering and need no ordering wait. Their nonces
 * stay reserved until consumed, including after a QR closes or a page reloads.
 * Unknown SDK nonces still hold writes back.
 *
 * `scope` is stored with its pending entry (see {@link PendingTransition.scope}).
 *
 * `precondition`, when given, is the last word on whether to send: it runs
 * under the lock after waiting for earlier transitions and before a nonce is
 * reserved. With a chosen-nonce builder an earlier unconfirmed transition may
 * still execute later; the check cannot establish ordering against it. When it
 * resolves false the write fails with
 * {@link WRITE_PRECONDITION_FAILED} and nothing is reserved or sent.
 */
export async function withSdkSignedWrite<T>(
  ownerId: string,
  contractId: string,
  write: () => Promise<T>,
  scope?: string,
  precondition?: () => Promise<boolean>,
  writeWithNonce?: (nonce: bigint) => Promise<T>
): Promise<T> {
  return withIdentityWriteLock(ownerId, contractId, async () => {
    let polls = 0;
    const { current, value } = await awaitNonce<{ nonce: bigint | null }>(ownerId, contractId, (tip, reservation) => {
      const pending = stillPending(tip, reservation);
      if (pending.some((entry) => entry.scope !== WALLET_TOKEN_SCOPE) && polls++ < PENDING_POLLS) return null;
      if (pending.some((entry) => entry.scope !== WALLET_TOKEN_SCOPE &&
        (scope === undefined || entry.scope === undefined || entry.scope === scope))) return null;
      if (writeWithNonce && reservation && (pending.length > 0 || reservation.mark > tipOf(tip))) {
        const nonce = allocateNonce(tip, reservation);
        return nonce === null ? null : { nonce };
      }
      return pending.length === 0 ? { nonce: null } : null;
    });
    if (precondition && !(await precondition())) throw new Error(WRITE_PRECONDITION_FAILED);
    if (value.nonce !== null && writeWithNonce) {
      const previousMark = loadReservation(ownerId, contractId)?.mark ?? BigInt(0);
      const entry = reserveNonce(ownerId, contractId, value.nonce, current, scope);
      try {
        const result = await writeWithNonce(value.nonce);
        // An affected-state answer can be a snapshot rather than execution proof.
        // Keep the chosen nonce until a nonce read proves it can no longer execute.
        await settleChosenNonce(ownerId, contractId, entry);
        return result;
      } catch (error) {
        if (error instanceof ChosenWriteNotSentError || error instanceof CriticalKeyCancelledError) {
          releaseNonce(ownerId, contractId, entry);
          // No bytes left this lock, so this allocation never became a signed nonce.
          const reservation = loadReservation(ownerId, contractId);
          if (reservation) saveReservation(ownerId, contractId, { ...reservation, mark: previousMark });
        } else if (isVerdict(error)) releaseNonce(ownerId, contractId, entry);
        throw error instanceof ChosenWriteNotSentError && error.reason instanceof CriticalKeyCancelledError ? error.reason : error;
      }
    }
    const sdk = await getEvoSdk();
    try { await sdk.wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
    const entry = reserveNonce(ownerId, contractId, null, current, scope);
    // While the SDK works, its lifetime keeps starting over: it runs out only
    // a minute after this page stopped (closed, or the answer was lost).
    const alive = setInterval(() => renewPending(ownerId, contractId, entry), PENDING_LIFETIME_MS / 4);
    let result: T;
    try {
      result = await write();
    } catch (error) {
      clearInterval(alive);
      // A step-up key's session ended before it signed (lib/auth/critical-key.ts): nothing was sent, so no nonce was spent.
      if (error instanceof CriticalKeyCancelledError) releaseNonce(ownerId, contractId, entry);
      else if (isVerdict(error)) releaseNonce(ownerId, contractId, entry, await nonceTakenOnAnswer(ownerId, contractId, entry, false, tipOf(current)));
      // SDK argument/serialization failures happen before broadcast, so they spent no nonce.
      else if (!sentWriteOutcomeUnknown(error)) releaseNonce(ownerId, contractId, entry);
      else renewPending(ownerId, contractId, entry);
      throw error;
    }
    clearInterval(alive);
    releaseNonce(ownerId, contractId, entry, await nonceTakenOnAnswer(ownerId, contractId, entry, true, tipOf(current)));
    return result;
  });
}

async function settleChosenNonce(ownerId: string, contractId: string, entry: PendingTransition): Promise<void> {
  try {
    const sdk = await getEvoSdk();
    const current = await sdk.identities.contractNonce(ownerId, contractId);
    if (entry.nonce !== null && identityContractNonceConsumed(current, entry.nonce)) releaseNonce(ownerId, contractId, entry, entry.nonce);
  } catch (error) {
    logger.debug('Could not prove the chosen nonce consumed:', error);
  }
}

/** Re-sign the same wallet payment; even a local refusal cannot retire the wallet's copy. */
export async function withWalletTokenNonce<T>(ownerId: string, contractId: string, entry: PendingTransition, write: (nonce: bigint) => Promise<T>): Promise<T> {
  if (entry.scope !== WALLET_TOKEN_SCOPE || entry.nonce === null) throw new Error('Invalid wallet payment reservation');
  const nonce = entry.nonce;
  return withIdentityWriteLock(ownerId, contractId, async () => {
    try {
      return await write(nonce);
    } catch (error) {
      throw error instanceof ChosenWriteNotSentError && error.reason instanceof CriticalKeyCancelledError ? error.reason : error;
    } finally {
      await settleChosenNonce(ownerId, contractId, entry);
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
    if (settled > 0) saveReservation(ownerId, contractId, { ...reservation, floor: floorAfterSettling(current, reservation, pending) ?? reservation.floor, pending });
    return settled;
  });
}
