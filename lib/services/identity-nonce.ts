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
import { NONCE_STORE_ERROR, PENDING_WRITE_ERROR, isConsensusRefusal, isIdentityNonceConflictError, isNonceSpentRefusal } from '@/lib/error-utils';
import { allocateIdentityContractNonce, identityContractNonceConsumed } from '@/lib/document-id';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { getEvoSdk } from './evo-sdk-service';
import { documentToPlainObject } from './sdk-helpers';

/**
 * A signed transition that may still execute. `nonce` is null when the SDK
 * chose it; only such a one has an `expiresAt` (see {@link PENDING_LIFETIME_MS}).
 */
export interface PendingTransition {
  id: string;
  nonce: bigint | null;
  expiresAt: number | null;
  /** The document replace an SDK-signed transition makes, when its caller named it (see {@link settleSupersededReplaces}). */
  replaces?: DocumentReplace;
  /** With `replaces`: the raw contract nonce Platform reported before it was signed; it carries a later one. */
  signedAfter?: bigint;
  /**
   * What the transition writes, as an opaque key its caller chose (a Pollr
   * ballot names its poll), so a caller can tell which pending transitions can
   * touch what it is about to do. Absent means unknown: it may touch anything.
   */
  scope?: string;
}

/** A document replace: `revision` is the one the transition writes. */
export interface DocumentReplace {
  documentType: string;
  documentId: string;
  revision: number;
}

function isDocumentReplace(value: unknown): value is DocumentReplace {
  const r = value as Partial<DocumentReplace> | null;
  return typeof r === 'object' && r !== null && typeof r.documentType === 'string' && typeof r.documentId === 'string' && Number.isInteger(r.revision);
}

export interface NonceReservation {
  /** The highest nonce this browser chose for the identity on the contract. */
  mark: bigint;
  pending: PendingTransition[];
}

/**
 * How long an SDK-signed transition that was neither confirmed nor refused
 * holds other writes back. Elapsed time does not make a transition unusable
 * (the protocol gives it no deadline), so a transition whose nonce is known
 * (a create, a wallet request) never expires: it stays pending until Platform
 * shows that nonce consumed. The nonce of an SDK-signed one is unknown, so
 * nothing on Platform can show it consumed; without a bound it would stop
 * every later write from this browser for good. Tenderdash re-checks its
 * mempool after every block and a valid transition executes in the next one,
 * so this bound is only reached by a transition that was dropped. Owning that
 * nonce (building these transitions like creates) is what removes the bound.
 */
const PENDING_LIFETIME_MS = 15 * 60 * 1000;

/** The sequence part of an identity contract nonce (the upper 24 bits are its missing-revision set). */
const NONCE_SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1);

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
    const parsed = JSON.parse(raw) as {
      mark: string;
      pending: { id: string; nonce: string | null; expiresAt: number | null; replaces?: unknown; signedAfter?: unknown; scope?: unknown }[];
    };
    return {
      mark: BigInt(parsed.mark),
      pending: parsed.pending
        .filter((p) => !released.has(p.id))
        .map((p) => ({
          id: p.id,
          nonce: p.nonce === null ? null : BigInt(p.nonce),
          expiresAt: p.expiresAt,
          ...(isDocumentReplace(p.replaces) && typeof p.signedAfter === 'string' && /^\d+$/.test(p.signedAfter)
            ? { replaces: p.replaces, signedAfter: BigInt(p.signedAfter) }
            : {}),
          ...(typeof p.scope === 'string' ? { scope: p.scope } : {}),
        })),
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
      ...(p.replaces && p.signedAfter !== undefined ? { replaces: p.replaces, signedAfter: p.signedAfter.toString() } : {}),
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
    }));
    localStorage.setItem(reservationKey(ownerId, contractId), JSON.stringify({ mark: reservation.mark.toString(), pending }));
  } catch (error) {
    logger.warn('Could not store nonce reservations:', error);
    throw new Error(NONCE_STORE_ERROR);
  }
}

/**
 * The pending transitions that may still execute, given the raw value
 * `identities.contractNonce` returned: not one whose own nonce is consumed,
 * and not an SDK-signed one past its lifetime. Consumption is final, so a node that is behind only
 * keeps one pending longer. Nothing about an SDK-signed one is known, so it
 * stays pending until its outcome is known or it expires.
 */
export function stillPending(current: bigint | undefined | null, reservation: NonceReservation | null, now = Date.now()): PendingTransition[] {
  return (reservation?.pending ?? []).filter((p) => (p.expiresAt === null || p.expiresAt > now) && (p.nonce === null || !identityContractNonceConsumed(current, p.nonce)));
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
export function reserveNonce(
  ownerId: string,
  contractId: string,
  nonce: bigint | null,
  current: bigint | undefined | null,
  replaces?: DocumentReplace,
  scope?: string
): PendingTransition {
  const previous = loadReservation(ownerId, contractId);
  // Unique across tabs: releasing one must never release another.
  const entry: PendingTransition = {
    id: crypto.randomUUID(),
    nonce,
    expiresAt: nonce === null ? Date.now() + PENDING_LIFETIME_MS : null,
    ...(replaces ? { replaces, signedAfter: current ?? BigInt(0) } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
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
 * The SDK signs one past the higher of its own cache and the tip a node of its
 * choosing reports, and does not say which, so nothing here predicts it. The
 * write starts only once nothing this browser signed may still execute, so
 * whatever it signs cannot meet one of those. It is recorded as pending with
 * no nonce: if its outcome stays unknown (a timeout, a transport failure) no
 * later write starts until it expires. A consensus refusal is a verdict, but
 * a nonce refusal only when it shows the nonce spent ("already present", "too
 * far in past"): "too far in future" can come from a node behind one that
 * admitted the same transition. (Before evo-sdk 4.2.0-beta.7 the strict wait's
 * affected-state snapshot error was a verdict too; from beta.7, platform#5136,
 * the SDK writes wrapped here wait for the affected state and no longer raise
 * it.)
 *
 * While a pending transition may still execute this waits briefly, then fails
 * without sending anything.
 *
 * `replaces` names the document replace the write makes, stored with its
 * pending entry, so that {@link settleSupersededReplaces} can later prove it
 * can no longer execute. `scope` is stored with it too (see
 * {@link PendingTransition.scope}). Neither changes anything else.
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
  replaces?: DocumentReplace,
  scope?: string,
  precondition?: () => Promise<boolean>
): Promise<T> {
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
    if (precondition && !(await precondition())) throw new Error(WRITE_PRECONDITION_FAILED);
    try { await sdk.wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
    const entry = reserveNonce(ownerId, contractId, null, current, replaces, scope);
    try {
      const result = await write();
      releaseNonce(ownerId, contractId, entry);
      return result;
    } catch (error) {
      if (isVerdict(error)) releaseNonce(ownerId, contractId, entry);
      throw error;
    }
  });
}

/**
 * Release every SDK-signed transition pending for the identity on the
 * contract that is a document replace Platform shows settled, by two proofs:
 *  - the document is at the revision it writes, or later: a replace changes a
 *    document only from the revision before its own, and revisions never go
 *    back, so it can no longer change it;
 *  - the nonce after the one Platform reported before it was signed is
 *    consumed: a replace refused for a stale revision still executes as a paid
 *    error and takes a nonce, so the revision alone does not show that the
 *    next write cannot meet it. The SDK signed past that reported nonce.
 * No nonce is guessed. A document read as absent, a lower revision, an
 * unconsumed nonce or a failed read proves nothing, and the entry stays
 * pending (an absence may be a node that is behind the document's creation).
 *
 * Runs under the write lock, so no write is in flight while it reads, and
 * resolves to the number of entries it released. Callers that may have such a
 * write outstanding (the mobile engine before its next DM write, Pollr before
 * any ballot or poll write) use it instead of waiting out
 * {@link PENDING_LIFETIME_MS}.
 */
export async function settleSupersededReplaces(ownerId: string, contractId: string): Promise<number> {
  return withIdentityWriteLock(ownerId, contractId, async () => {
    const now = Date.now();
    const candidates = (loadReservation(ownerId, contractId)?.pending ?? [])
      .filter((p) => p.nonce === null && p.replaces && p.signedAfter !== undefined && (p.expiresAt === null || p.expiresAt > now));
    if (candidates.length === 0) return 0;
    const sdk = await getEvoSdk();
    let tip: bigint | undefined;
    try {
      tip = await sdk.identities.contractNonce(ownerId, contractId);
    } catch (error) {
      logger.debug('Could not read the contract nonce to settle pending replaces:', error);
      return 0;
    }
    let settled = 0;
    for (const entry of candidates) {
      const { documentType, documentId, revision } = entry.replaces as DocumentReplace;
      const after = (entry.signedAfter ?? BigInt(0)) & NONCE_SEQUENCE_MASK;
      if (!identityContractNonceConsumed(tip, after + BigInt(1))) continue;
      let current: number | null = null;
      try {
        const document = await sdk.documents.get(contractId, documentType, documentId);
        current = document ? Number(documentToPlainObject(document).$revision ?? NaN) : null;
      } catch (error) {
        logger.debug(`Could not read ${documentType} ${documentId} to settle a pending replace:`, error);
      }
      if (current !== null && Number.isFinite(current) && current >= revision) {
        releaseNonce(ownerId, contractId, entry);
        settled++;
      }
    }
    return settled;
  });
}
