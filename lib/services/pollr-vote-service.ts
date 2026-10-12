import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import {
  noteReplacedBallots,
  pollrBallotScope,
  pollrWriteMayStillExecute,
  recordBallotReplace,
  settleBallotReplace,
  settlePendingPollrReplaces,
} from './pollr-pending-writes';
import { markPollHasBallots, pollHasKnownBallots } from './pollr-known-ballots';
import { pollrPollService } from './pollr-poll-service';
import {
  POLLR_CONTRACT_ID,
  POLLR_DOCUMENT_TYPES,
  pollrIsV3,
  pollrIsV4,
  pollrHasEditableBallots,
  pollrPollsDeletable,
  pollrVoteDocType,
} from '@/lib/constants';
import {
  NONCE_STORE_ERROR,
  PENDING_WRITE_ERROR,
  extractErrorMessage,
  hasConsensusCode,
  isConsensusRefusal,
  isPropertyAgreementError,
  isReferenceNotFoundError,
  isTimeoutError,
} from '@/lib/error-utils';
import {
  POLL_MAX_OPTIONS,
  applyChoiceDelta,
  decodeChoiceKey,
  isChoiceIndex,
  normalizeChoices,
  planBallotWrite,
  sameChoices,
  sumCounts,
  type Ballot,
  type BallotWrite,
} from '@/lib/pollr-rules';
import {
  identifierStringToDocumentBytes,
  normalizeSDKResponse,
  type DocumentOrderByClause,
  type DocumentWhereClause,
} from './sdk-helpers';
import { documentCount, groupedCountEntries, paginateFetchAll } from './pagination-utils';
// Type-only: the ballot doctype and the close time both come off the poll, and
// taking it whole makes a call site physically unable to pair a poll with
// another poll's mode. Erased at compile time, so no runtime import cycle.
import type { Poll } from './pollr-poll-service';

/** Result of casting a (possibly multi-choice) v3 ballot. */
export interface CastVoteResult {
  /** True when every requested choice is recorded on Platform. */
  success: boolean;
  /** Choices this call wrote. */
  created: number[];
  /** Choices the voter had already cast (unique-index rejection). */
  alreadyVoted: number[];
  /**
   * A single-choice ballot was refused as a duplicate, but which choice it
   * collided with couldn't be read. The voter has voted; their choice is unknown.
   */
  unresolvedDuplicate: boolean;
  /** Choices that hit a real error and are still uncast — safe to retry. */
  failed: number[];
  /** Message from the first hard failure, if any. */
  error?: string;
}

/** Result of setting a v7 voter's selection. */
export interface SetVoteResult {
  /** True when the voter's ballot now selects exactly the wanted choices. */
  success: boolean;
  /**
   * The choices the voter's ballot selects after this call, as best known: the
   * wanted ones when the write went through (or none was needed), a fresh read
   * when it was refused, and null when that read failed too (the ballot state
   * is unknown). Undefined when nothing is known to have changed: the call was
   * refused before writing, or the write's outcome is still unconfirmed.
   */
  choices?: number[] | null;
  /**
   * The write was sent but its outcome is not known yet (the confirmation wait
   * timed out, or it failed without a verdict). The ballot was not re-read: a
   * read this soon would likely show the state before the write.
   */
  unconfirmed?: boolean;
  /**
   * Nothing was sent: an earlier write of this voter's (on this poll, or one
   * the write path must wait on) could still execute, and a plan judged
   * against the ballot on chain now could be undone by it. Retry once
   * {@link PollrVoteService.getBallotState} reports nothing pending.
   */
  heldBack?: boolean;
  /** The poll no longer exists: its owner deleted it after this voter loaded it. */
  gone?: boolean;
  /** Platform refused the write because the poll has closed. */
  closed: boolean;
  /**
   * The write met a ballot that changed elsewhere (another tab or device): a
   * stale revision or a ballot that already exists. Reload before retrying.
   */
  stale: boolean;
  /** Message from the failure, if any. */
  error?: string;
}

/**
 * Whether a ballot write of the viewer's may still land, judging by the
 * card's ballot-state read. An unreadable state fails closed: the read may
 * have seen a pending create before failing, so it holds the poll delete back
 * (it proves no ballot, so nothing is marked for good, and the next load
 * counts again).
 */
export function ownBallotMayBePending(read: PromiseSettledResult<BallotState>): boolean {
  return read.status !== 'fulfilled' || read.value.pending;
}

/** A voter's ballots on one poll, as the single source of truth for the card. */
export interface BallotState {
  /** The choices the voter's ballot selects on chain. */
  choices: number[];
  /**
   * An earlier write to this ballot could still execute, so `choices` may yet
   * change: show them read-only and check again. Always false on v3/v4.
   */
  pending: boolean;
}

export interface PollTally {
  /** Vote count per option index. */
  counts: number[];
  /** Total selections for the poll (a multi-choice voter contributes one per choice). */
  total: number;
  /**
   * A closed v3 poll with too many ballots to bound by its close time: the
   * counts may include late ballots, so they must not be presented as final.
   */
  lateIncluded?: boolean;
  /**
   * A closed v3 poll tallied from only its ballots created by the close time:
   * a ballot missing from these counts is late, not lagging.
   */
  cutoffVerified?: boolean;
  /**
   * When the counts were read off the chain (ms since epoch). Absent on an
   * optimistic tally, which folds in this client's own writes.
   */
  readAt?: number;
}

const TALLY_CACHE_TTL_MS = 30_000;

/**
 * How long after a v7 poll's close a tally must have been read to count as
 * final. The close rule judges block time; this device's clock judges "closed",
 * so a small margin covers the two disagreeing and a node a few blocks behind.
 */
const FINAL_TALLY_GRACE_MS = 30_000;

type Sdk = Awaited<ReturnType<typeof getEvoSdk>>;

/** `[0, 1, ... n-1]` — the choice indices to query, for a count's `in` clause. */
function choiceRange(size: number): number[] {
  return Array.from({ length: size }, (_, index) => index);
}

/** The ballot field a tally groups on: v7's typed array `choices`, v3/v4's scalar `choice`. */
function tallyField(): string {
  return pollrHasEditableBallots() ? 'choices' : 'choice';
}

/**
 * The tally's clause over a poll's real options: v7 matches ballots whose
 * `choices` hold any of them (each element counts under its own group), v3/v4
 * the scalar `choice`.
 */
function choicesClause(size: number): DocumentWhereClause {
  return [tallyField(), pollrHasEditableBallots() ? 'containsAny' : 'in', choiceRange(size)];
}

/** The per-choice fallback's clause: v7 ballots holding `choice`, or v3/v4 ballots of it. */
function choiceClause(choice: number): DocumentWhereClause {
  return [tallyField(), pollrHasEditableBallots() ? 'contains' : '==', choice];
}

/** How many options a poll's tally covers: its real options, 1-10. */
function pollSize(poll: Poll): number {
  return Math.min(Math.max(poll.options.length, 1), POLL_MAX_OPTIONS);
}

/** Per-option counts of the schema-valid choices in `choices`. */
function countChoices(choices: number[]): number[] {
  const counts = zeroCounts();
  for (const choice of choices) {
    if (isChoiceIndex(choice)) counts[choice] += 1;
  }
  return counts;
}

/** A v3 ballot refused before anything was written. */
function refused(error: string, failed: number[] = []): CastVoteResult {
  return { success: false, created: [], alreadyVoted: [], unresolvedDuplicate: false, failed, error };
}

/** A v7 selection refused before anything was written. */
function refusedSet(error: string, closed = false): SetVoteResult {
  return { success: false, closed, stale: false, error };
}

/** How a v7 ballot write went. */
type WriteOutcome =
  | { status: 'ok' }
  | { status: 'unconfirmed'; error: string }
  | { status: 'refused'; error: unknown };

/** A field off a raw document (nested `data` or flat). */
function readField(doc: Record<string, unknown>, field: string): unknown {
  return (doc.data as Record<string, unknown> | undefined)?.[field] ?? doc[field];
}

/** Read the `choice` field off a raw vote document. */
function readChoice(doc: Record<string, unknown>): number {
  return Number(readField(doc, 'choice'));
}

/**
 * A raw v7 `vote` document as a {@link Ballot}. A ballot without `choices` was
 * withdrawn. Throws on one it cannot read: the voter's ballot exists, so
 * planning as if it did not would only meet a duplicate (40105) on create.
 */
function toBallot(doc: Record<string, unknown>): Ballot {
  const id = doc.$id ?? doc.id;
  const revision = Number(doc.$revision ?? doc.revision);
  const raw = readField(doc, 'choices');
  if (typeof id !== 'string' || !Number.isInteger(revision)) throw new Error('Unreadable ballot');
  if (raw === undefined || raw === null) return { id, revision, choices: [] };
  // An integer array may decode as a plain array or as a typed array view.
  if (!Array.isArray(raw) && !ArrayBuffer.isView(raw)) throw new Error('Unreadable ballot');
  const values = Array.from(raw as ArrayLike<unknown>, Number);
  const choices = normalizeChoices(values);
  if (choices.length !== values.length) throw new Error('Unreadable ballot');
  return { id, revision, choices };
}

function zeroCounts(): number[] {
  return new Array<number>(POLL_MAX_OPTIONS).fill(0);
}

/**
 * Thrown when every tally read path failed, so the counts simply aren't known.
 *
 * Distinct from a real all-zero tally: zero-filling an unavailable answer makes
 * a transient read failure look like "nobody has voted", which is a different
 * claim entirely — and a wrong one to cache or to label "Final results".
 */
export class PollTallyUnavailableError extends Error {
  constructor(public readonly pollId: string) {
    super(`Vote tally unavailable for poll ${pollId}`);
    this.name = 'PollTallyUnavailableError';
  }
}

/**
 * Platform rejects a colliding v3 ballot with a duplicate-properties violation
 * from its `unique` index.
 *
 * What the collision *means* depends on the doctype: on `multiVote` it is "you
 * already cast this choice", but on `vote` the index carries no choice, so it
 * is "you already voted" — for a choice that may not be the one just
 * attempted. `castVote` resolves the difference.
 */
export function isDuplicateVoteError(error: unknown): boolean {
  return /duplicate unique properties|\b40105\b/i.test(extractErrorMessage(error));
}

/**
 * v7: a ballot write refused because the poll had closed when it landed — its
 * `pollId` reference only accepts writes by the poll's `endsAt`
 * (ReferencedDocumentPropertyMismatch, 40127). The ballot's reference has no
 * other `where` condition, so a 40127 is always the close; a mismatch reported
 * only in prose counts when it names `endsAt`, or once the close has passed
 * on this clock.
 */
function isPollClosedError(error: unknown, endsAt?: number): boolean {
  if (hasConsensusCode(error, [40127])) return true;
  if (!isPropertyAgreementError(error)) return false;
  return /\bendsAt\b/.test(extractErrorMessage(error)) || (typeof endsAt === 'number' && Date.now() > endsAt);
}

/** The write path refused before signing anything: nothing can land from it. */
function neverSent(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return message === PENDING_WRITE_ERROR || message === NONCE_STORE_ERROR;
}

/**
 * v7: a write planned against a ballot that has since changed — a stale
 * revision (40106) or a ballot another tab created first (40105). Neither is
 * retried blind; the caller re-reads the ballot.
 */
function isStaleBallotError(error: unknown): boolean {
  return (
    isDuplicateVoteError(error) ||
    /invalid revision|\b40106\b/i.test(extractErrorMessage(error)) ||
    hasConsensusCode(error, [40105, 40106])
  );
}

/**
 * Votes on the shared Pollr contract.
 *
 * **v7** keeps one mutable `vote` per voter per poll, whose `choices` array
 * names the picked options and is dropped to withdraw; nothing deletes one.
 * Every create and replace must land by the poll's close (the `pollId`
 * reference's `where` judges the write's block time against the poll's
 * `endsAt`), so ballots are editable while the poll is open and final after.
 * The tally index counts each element of `choices`, so it counts selections.
 *
 * **v3** (testnet) ballots are immutable, one document per selection, in the
 * doctype the poll's mode calls for: `vote` unique per (poll, voter),
 * `multiVote` unique per (poll, voter, choice).
 *
 * **v4** (indexOnly ballots) is read-only: polls, tallies and the voter's own
 * choices still load, but nothing is written.
 */
class PollrVoteService {
  private tallyCache = new TtlMap<string, PollTally>(TALLY_CACHE_TTL_MS);

  /**
   * v3: cast a ballot, one immutable document per selected choice, in the
   * doctype the poll's mode calls for.
   *
   * Platform rejects state transitions carrying more than one document
   * transition, so multi-choice ballots MUST be written sequentially — one
   * createDocument call per choice, each awaited so nonces stay ordered.
   */
  async castVote(poll: Poll, choices: number[], ownerId: string): Promise<CastVoteResult> {
    const selected = normalizeChoices(choices);

    if (pollrHasEditableBallots()) return refused('v7 ballots are written with setVote', selected);
    if (pollrIsV4()) return refused('Voting is not available on this poll contract', selected);

    if (selected.length === 0) {
      return refused('No choice selected');
    }

    // Not reachable through the UI (the ballot renders radios for this mode), so
    // this is a caller bug rather than user input — refuse instead of silently
    // dropping selections, which would report a ballot the voter didn't cast.
    if (!poll.multiChoice && selected.length > 1) {
      return refused('This poll takes a single choice', selected);
    }

    // v3's close time is advisory — the contract can't enforce it — so clients
    // are the ones that have to refuse a late ballot.
    if (pollIsClosed(poll)) {
      return refused('This poll has closed');
    }

    const docType = pollrVoteDocType(poll.multiChoice);
    const created: number[] = [];
    const alreadyVoted: number[] = [];
    let unresolvedDuplicate = false;
    const failed: number[] = [];
    let firstError: string | undefined;

    const recordRejection = async (choice: number, error: unknown, message: string): Promise<void> => {
      if (isDuplicateVoteError(error)) {
        const collided = await this.resolveDuplicate(poll, choice, ownerId);
        if (collided) alreadyVoted.push(...collided);
        else unresolvedDuplicate = true;
      } else {
        // Keep going: the remaining choices are independent documents, and
        // re-submitting a landed one is idempotent thanks to the unique index.
        failed.push(choice);
        firstError ??= message;
      }
    };

    for (const choice of selected) {
      try {
        const result = await stateTransitionService.createDocument(POLLR_CONTRACT_ID, docType, ownerId, {
          // Identifier-typed contract fields must reach the typed write path as raw bytes.
          pollId: identifierStringToDocumentBytes(poll.id),
          // Unchecked on v3, but the poll's real creator is the honest value.
          pollOwnerId: identifierStringToDocumentBytes(poll.ownerId),
          choice,
        });
        if (result.success) created.push(choice);
        else await recordRejection(choice, result.error, result.error || 'Failed to cast vote');
      } catch (error) {
        await recordRejection(choice, error, extractErrorMessage(error));
      }
    }

    this.invalidateTally(poll.id);
    return {
      success: failed.length === 0,
      created,
      alreadyVoted: normalizeChoices(alreadyVoted),
      unresolvedDuplicate,
      failed,
      error: firstError,
    };
  }

  /**
   * v7: make the voter's ballot select exactly `wanted` — create it, change
   * it, or withdraw it (`wanted` empty). At most one write.
   *
   * The plan is made against a FRESH read of the voter's ballot, never a
   * cached one: it decides create-versus-replace and carries the revision the
   * replace builds on, and either being stale is a refused write. When the
   * write was refused, the ballot is re-read so `choices` reports what the
   * chain shows rather than what was planned.
   */
  async setVote(poll: Poll, wanted: number[], ownerId: string): Promise<SetVoteResult> {
    if (!pollrHasEditableBallots()) return refusedSet('setVote is the v7 ballot path');

    const choices = normalizeChoices(wanted, poll.options.length);
    if (choices.length !== wanted.length) return refusedSet('That is not an option of this poll');
    if (!poll.multiChoice && choices.length > 1) return refusedSet('This poll takes a single choice');
    if (typeof poll.endsAt !== 'number') return refusedSet('This poll has no close time');
    if (pollIsClosed(poll)) return refusedSet('This poll has closed', true);

    // Release the reservations of earlier replaces that landed, or this write
    // is held back behind them (see settlePendingPollrReplaces). Then refuse to
    // plan while any earlier write could still execute — even a plan of no
    // writes, which would otherwise report as recorded a selection that a late
    // create could still change.
    await settlePendingPollrReplaces(ownerId);
    let mayStillExecute: boolean;
    try {
      mayStillExecute = await pollrWriteMayStillExecute(ownerId, poll.id);
    } catch (error) {
      // The reservation store is unreadable: nothing proves an earlier write
      // cannot land, so refuse rather than plan (nothing was sent).
      return refusedSet(extractErrorMessage(error));
    }
    if (mayStillExecute) {
      return { success: false, heldBack: true, closed: false, stale: false, error: 'An earlier vote is still being confirmed' };
    }

    let ballot: Ballot | null;
    try {
      ballot = await this.getMyBallot(poll, ownerId);
    } catch (error) {
      return refusedSet(`Couldn't read your ballot: ${extractErrorMessage(error)}`);
    }

    const write = planBallotWrite(ballot, choices);
    if (!write) return { success: true, choices, closed: false, stale: false };

    const outcome = await this.writeBallot(poll, ownerId, write);
    if (outcome.status === 'ok') {
      this.invalidateTally(poll.id);
      return { success: true, choices, closed: false, stale: false };
    }
    if (outcome.status === 'unconfirmed') {
      this.invalidateTally(poll.id);
      return { success: false, unconfirmed: true, closed: false, stale: false, error: outcome.error };
    }

    const { error } = outcome;
    const message = extractErrorMessage(error) || 'Failed to record your vote';
    // Nothing was sent: an earlier transition the write path waits on (another
    // poll's — this poll's were checked above) may still execute.
    if (message === PENDING_WRITE_ERROR) {
      return { success: false, heldBack: true, closed: false, stale: false, error: message };
    }
    this.invalidateTally(poll.id);
    // The poll is gone: its owner deleted it after this voter loaded it.
    if (isReferenceNotFoundError(error)) {
      return { success: false, gone: true, closed: false, stale: false, error: message };
    }
    const closed = isPollClosedError(error, poll.endsAt);
    const stale = !closed && isStaleBallotError(error);

    // A write refused without a verdict (a transport or proof failure) can
    // still execute, and its reservation says so: report the ballot pending
    // rather than settled.
    let pendingAfter: boolean;
    try {
      pendingAfter = await pollrWriteMayStillExecute(ownerId, poll.id);
    } catch {
      pendingAfter = true;
    }
    if (pendingAfter) return { success: false, unconfirmed: true, closed, stale, error: message };

    let recorded: number[] | null = null;
    try {
      recorded = (await this.getMyBallot(poll, ownerId))?.choices ?? [];
    } catch (readError) {
      logger.warn('PollrVoteService: could not re-read the ballot after a failed write', {
        pollId: poll.id,
        error: extractErrorMessage(readError),
      });
    }
    const success = recorded !== null && sameChoices(recorded, choices);
    return { success, choices: recorded, closed, stale, error: success ? undefined : message };
  }

  /**
   * v7: whether `userId` may be offered the delete of `poll` now. Only its
   * owner, and never once the poll is known to have a ballot: ballots are
   * permanent, and a lagging node can still count 0 (see pollr-known-ballots,
   * which the reads here fill). A pending write of the owner's, or an
   * unreadable ballot state that may hide one, holds it back; otherwise every
   * ballot is counted. A vote that was never sent leaves nothing behind, so
   * this offers the delete again. `ownState` reuses a ballot-state read the
   * caller already has. Throws when the ballots cannot be counted.
   */
  async deleteEligible(poll: Poll, userId: string, ownState?: PromiseSettledResult<BallotState>): Promise<boolean> {
    if (!pollrPollsDeletable() || userId !== poll.ownerId) return false;
    noteReplacedBallots(userId);
    if (pollHasKnownBallots(poll.id)) return false;
    const state = ownState ?? (await Promise.allSettled([this.getBallotState(poll, userId)]))[0];
    if (ownBallotMayBePending(state) || pollHasKnownBallots(poll.id)) return false;
    const ballots = await pollrPollService.countBallots(poll.id);
    return ballots === 0 && !pollHasKnownBallots(poll.id);
  }

  /**
   * The voter's choices on this poll and whether they are settled — the one
   * place the card learns either. On v7 it first releases the replaces
   * Platform shows landed, then asks whether any earlier write to this poll's
   * ballot could still execute; `pending` is true when one could, or when
   * that cannot be determined (an unreadable store or nonce). Throws when the
   * ballot itself cannot be read, as {@link getMyVotes} does.
   */
  async getBallotState(poll: Poll, userId: string): Promise<BallotState> {
    // Past the close (and the margin for this clock against block time) no
    // ballot write can land, whatever is still reserved.
    if (!pollrHasEditableBallots() || pollIsClosed(poll, Date.now() - FINAL_TALLY_GRACE_MS)) {
      return { choices: await this.getMyVotes(poll, userId), pending: false };
    }
    await settlePendingPollrReplaces(userId);
    let pending: boolean;
    try {
      pending = await pollrWriteMayStillExecute(userId, poll.id);
    } catch {
      pending = true;
    }
    return { choices: await this.getMyVotes(poll, userId), pending };
  }

  /** The v7 ballot write. */
  private async writeBallot(poll: Poll, ownerId: string, write: BallotWrite): Promise<WriteOutcome> {
    // A replace rewrites the whole document; leaving `choices` out (an empty
    // array is refused) is what withdraws.
    const data: Record<string, unknown> = { pollId: identifierStringToDocumentBytes(poll.id) };
    if (write.choices.length > 0) data.choices = write.choices;

    // Reserved with the poll's scope, so a write left pending here holds back
    // only this poll's ballots.
    const scope = pollrBallotScope(poll.id);
    // A replace is recorded until its outcome is proven: past its nonce
    // reservation's lifetime it may still land (see recordBallotReplace).
    const replaceRecord = write.kind === 'replace'
      ? { pollId: poll.id, ballotId: write.ballot.id, revision: write.ballot.revision + 1, endsAt: poll.endsAt as number }
      : null;
    if (replaceRecord) {
      try {
        recordBallotReplace(ownerId, replaceRecord);
      } catch (error) {
        return { status: 'refused', error };
      }
    }
    const settleRecord = () => {
      if (replaceRecord) settleBallotReplace(ownerId, replaceRecord);
    };
    // A create refused as a duplicate (40105) collided with this voter's ballot
    // on this poll's unique [pollId, $ownerId] index: proof one exists, even
    // if a lagging node's re-read cannot show it yet.
    const markIfDuplicate = (error: unknown) => {
      if (write.kind === 'create' && isDuplicateVoteError(error)) markPollHasBallots(poll.id);
    };
    const refusal = (error: unknown): WriteOutcome => {
      if (isConsensusRefusal(error) || neverSent(error)) settleRecord();
      markIfDuplicate(error);
      return isTimeoutError(error)
        ? { status: 'unconfirmed', error: extractErrorMessage(error) }
        : { status: 'refused', error };
    };
    try {
      const result =
        write.kind === 'create'
          ? await stateTransitionService.createDocument(POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES.VOTE, ownerId, data, {
              reservationScope: scope,
            })
          : await stateTransitionService.updateDocument(
              POLLR_CONTRACT_ID,
              POLLR_DOCUMENT_TYPES.VOTE,
              write.ballot.id,
              ownerId,
              data,
              write.ballot.revision,
              scope
            );
      if (result.success) {
        // An unconfirmed create was broadcast but never seen on chain.
        if (result.confirmed === false) return { status: 'unconfirmed', error: 'The network has not confirmed your vote yet' };
        settleRecord();
        // A confirmed ballot keeps the poll for good (an unconfirmed one proves nothing).
        markPollHasBallots(poll.id);
        return { status: 'ok' };
      }
      return refusal(result.error ?? 'Failed to record your vote');
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * v3: which choice a rejected-as-duplicate write collided with.
   *
   * On `multiVote` the unique index includes `choice`, so the collision is with
   * the choice just attempted. On `vote` it does not: the voter had already
   * cast a ballot, but not necessarily this one, and reporting the attempted
   * choice would tick "your vote" against an option they never picked. Re-read
   * the ballot to find out which it really is; null when that read fails or
   * finds nothing, since the attempted choice is then only a guess.
   */
  private async resolveDuplicate(poll: Poll, choice: number, ownerId: string): Promise<number[] | null> {
    if (poll.multiChoice) return [choice];

    try {
      const recorded = await this.getMyVotes(poll, ownerId);
      if (recorded.length > 0) return recorded;
    } catch (error) {
      logger.warn('PollrVoteService: could not resolve which choice a single-choice ballot collided with', {
        pollId: poll.id,
        error: extractErrorMessage(error),
      });
    }
    return null;
  }

  /**
   * Fold a voter's own change into the cached tally: +1 per added choice, -1
   * per removed one (a v7 voter can change or withdraw a ballot).
   *
   * Platform's count trees can lag a few seconds behind a confirmed write, so
   * re-reading right after voting can return the pre-vote numbers — and that
   * stale answer would then be cached for the full TTL. Adjusting the
   * caller's current tally instead keeps the UI honest until the next remount
   * refetches for real. The result carries no `readAt`: it is not a chain read,
   * so it can never be labelled final.
   */
  applyOptimisticVotes(pollId: string, baseline: PollTally, added: number[], removed: number[] = []): PollTally {
    const tally: PollTally = applyChoiceDelta(baseline.counts, added, removed);
    this.tallyCache.set(pollId, tally);
    return tally;
  }

  /**
   * v3: re-read the tally after a ballot collided with one already on chain.
   *
   * A duplicate means this tab's tally predates a vote the voter cast
   * elsewhere, so folding in only the new writes leaves that earlier vote
   * uncounted. The fresh read supplies it; merging keeps the votes `created`
   * in this same call, which the count tree may not show yet. Only choices
   * this call established (written or refused as duplicates) floor the
   * counts. Falls back to `optimistic` when the read fails, which is no worse
   * than before the collision.
   */
  async refreshTally(
    poll: Poll,
    optimistic: PollTally | null,
    { created, alreadyVoted }: Pick<CastVoteResult, 'created' | 'alreadyVoted'>
  ): Promise<PollTally | null> {
    this.invalidateTally(poll.id);
    try {
      const tally = reconcileTally(await this.getTally(poll), optimistic, created, [...created, ...alreadyVoted]);
      this.tallyCache.set(poll.id, tally);
      return tally;
    } catch (error) {
      logger.warn('PollrVoteService: could not refresh the tally after a duplicate ballot', {
        pollId: poll.id,
        error: extractErrorMessage(error),
      });
      // On a closed v3 poll the optimistic counts were never bounded by the
      // close time (a selection can land after it), so they aren't final.
      if (optimistic && !optimistic.cutoffVerified && closedCutoff(poll) !== null) {
        return { ...optimistic, lateIncluded: true };
      }
      return optimistic;
    }
  }

  /**
   * v7: the voter's one ballot on this poll, off the unique `byPollVoter`
   * [pollId, $ownerId] index — a withdrawn one included, since a later pick
   * replaces it rather than creating a duplicate. Null when they never voted.
   */
  async getMyBallot(poll: Poll, userId: string): Promise<Ballot | null> {
    const sdk = await getEvoSdk();
    const response = await sdk.documents.query({
      dataContractId: POLLR_CONTRACT_ID,
      documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
      where: [
        ['pollId', '==', poll.id],
        ['$ownerId', '==', userId],
      ],
      orderBy: [['pollId', 'asc'], ['$ownerId', 'asc']],
      limit: 1,
    });
    const docs = normalizeSDKResponse(response);
    // Any own ballot, a withdrawn one included, keeps the poll for good
    // (noBallots), even though it selects nothing.
    if (docs.length > 0) markPollHasBallots(poll.id);
    return docs.length > 0 ? toBallot(docs[0]) : null;
  }

  /**
   * Which choices `userId` currently selects on this poll.
   *
   * v7 reads the voter's ballot and its `choices`. v3 reads
   * the unique index, which leads with [pollId, $ownerId]: one ranged read. v4
   * has no such index — its terminal must be `$ownerId` — so the read walks
   * `byPollChoice`'s choice level with an `in` over every schema-valid choice
   * and pins the terminal, with the orderBy an `in` on an indexOnly prefix
   * property requires.
   *
   * Throws on failure rather than reporting "no votes": an empty answer reopens
   * the ballot, which on a v3 single-choice poll walks the voter into a write
   * Platform will reject outright.
   */
  async getMyVotes(poll: Poll, userId: string): Promise<number[]> {
    try {
      if (pollrHasEditableBallots()) return (await this.getMyBallot(poll, userId))?.choices ?? [];

      // One branch per topology/mode, each spelling its whole query: the three
      // clauses have to agree with one another and with the index being read.
      let query: { where: DocumentWhereClause[]; orderBy: DocumentOrderByClause[]; limit: number };
      if (pollrIsV4()) {
        query = {
          where: [
            ['pollId', '==', poll.id],
            ['choice', 'in', choiceRange(POLL_MAX_OPTIONS)],
            ['$ownerId', '==', userId],
          ],
          orderBy: [['choice', 'asc']],
          limit: POLL_MAX_OPTIONS,
        };
      } else {
        // `vote`'s unique index stops at $ownerId, so it neither orders by choice
        // nor can hold more than the one ballot; `multiVote`'s continues.
        query = {
          where: [
            ['pollId', '==', poll.id],
            ['$ownerId', '==', userId],
          ],
          orderBy: poll.multiChoice
            ? [['pollId', 'asc'], ['$ownerId', 'asc'], ['choice', 'asc']]
            : [['pollId', 'asc'], ['$ownerId', 'asc']],
          limit: poll.multiChoice ? POLL_MAX_OPTIONS : 1,
        };
      }

      const sdk = await getEvoSdk();
      const response = await sdk.documents.query({
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: pollrVoteDocType(poll.multiChoice),
        ...query,
      });
      return normalizeChoices(normalizeSDKResponse(response).map(readChoice));
    } catch (error) {
      logger.error('PollrVoteService: failed to load own votes', error);
      throw error;
    }
  }

  /**
   * Per-option counts plus the grand total, served from a short-TTL cache.
   *
   * Primary path is the ballot doctype's countable choice index (an O(1)
   * count tree), grouped by choice. On v3/v4 that is `[pollId, choice]`, and
   * only the doctype this poll's mode uses is read, so ballots written to the
   * other one can never reach the numbers. On v7 it is `[pollId, choices]`,
   * which holds one entry per element of a ballot's `choices`: a multi-choice
   * ballot counts under each pick, and a withdrawn one under none.
   *
   * Throws {@link PollTallyUnavailableError} when no path produced counts —
   * see that class for why a zero-filled stand-in isn't an acceptable answer.
   */
  async getTally(poll: Poll): Promise<PollTally> {
    const size = pollSize(poll);

    // v3's close time is advisory, so ballots can land after it and the count
    // tree has no time axis to leave them out. v3 ballots carry `$createdAt`
    // under `pollVotesByTime`, so a closed poll is tallied from its on-time
    // ballots in one read, keeping "Final results" final.
    const closedAt = closedCutoff(poll);

    const cached = this.tallyCache.get(poll.id);
    if (cached && cachedTallyUsable(poll, cached)) {
      return { ...cached, counts: resize(cached.counts, size) };
    }

    const sdk = await getEvoSdk();
    const docType = pollrVoteDocType(poll.multiChoice);
    const readAt = Date.now();
    const onTime = closedAt === null ? null : await this.countOnTimeBallots(sdk, poll.id, docType, closedAt);

    // Each step falls through to the next only when it couldn't produce counts.
    const counts =
      onTime ??
      (await this.countByChoiceGrouped(sdk, poll.id, docType, size)) ??
      (await this.countByChoiceIndividually(sdk, poll.id, docType, size)) ??
      // Only v3 ballots carry the time index the scan pages over.
      (pollrIsV3() ? await this.countByChoiceScan(sdk, poll.id, docType) : null);

    // Nothing worked. A grand-total count is deliberately NOT used as a last
    // resort: it can't allocate votes among the options, so pairing it with
    // zeroes would render every choice at 0% under a non-zero total. Fail
    // loudly instead, and cache nothing, so the caller can offer a retry.
    if (!counts) {
      throw new PollTallyUnavailableError(poll.id);
    }

    // The total is the sum of the poll's REAL options. On v3/v4 `choice` is
    // schema-valid for 0-9 whatever the poll's actual option count is, so
    // anyone can write ballots for options that don't exist; summing the real
    // ones ignores those and keeps percentages summing to 100.
    const total = sumCounts(counts.slice(0, size));
    // A selection read off the chain is a ballot, which keeps the poll for good.
    if (total > 0) markPollHasBallots(poll.id);

    const tally: PollTally = { counts, total, readAt };
    if (closedAt !== null && !onTime) tally.lateIncluded = true;
    if (onTime) tally.cutoffVerified = true;
    this.tallyCache.set(poll.id, tally);

    return { ...tally, counts: resize(tally.counts, size) };
  }

  /** Drop the cached tally so the next read reflects a just-cast vote. */
  invalidateTally(pollId?: string): void {
    if (pollId) {
      this.tallyCache.delete(pollId);
    } else {
      this.tallyCache.clear();
    }
  }

  /**
   * One round-trip against the countable choice index, grouped by choice.
   * Returns null (so the caller can fall back) when the response can't be decoded.
   */
  private async countByChoiceGrouped(
    sdk: Sdk,
    pollId: string,
    docType: string,
    optionCount: number
  ): Promise<number[] | null> {
    try {
      const raw: unknown = await sdk.documents.count({
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: docType,
        // Only the poll's real options: a wider clause would pull groups for
        // options that don't exist on this poll.
        where: [['pollId', '==', pollId], choicesClause(optionCount)],
        groupBy: [tallyField()],
      });

      const entries = groupedCountEntries(raw);
      const counts = zeroCounts();
      let matched = 0;

      for (const [key, value] of entries) {
        if (key === '') continue; // aggregate-mode key; shouldn't appear with groupBy set
        const choice = decodeChoiceKey(key);
        if (choice === null) continue;
        counts[choice] = Number(value as bigint | number);
        matched++;
      }

      // An empty map is a genuine "no votes yet" (count trees don't materialize
      // zero branches). Entries that decode to nothing means the key encoding
      // changed, so fall back rather than report every option as 0.
      if (entries.length > 0 && matched === 0) return null;
      return counts;
    } catch (error) {
      logger.warn('PollrVoteService: grouped choice count failed, falling back to per-choice counts', {
        error: extractErrorMessage(error),
      });
      return null;
    }
  }

  /** Fallback 1: one count per choice against the same countable index. */
  private async countByChoiceIndividually(
    sdk: Sdk,
    pollId: string,
    docType: string,
    optionCount: number
  ): Promise<number[] | null> {
    try {
      const counts = zeroCounts();
      // Only the poll's real options — the rest stay 0.
      for (const choice of choiceRange(optionCount)) {
        counts[choice] = await documentCount(sdk, {
          dataContractId: POLLR_CONTRACT_ID,
          documentTypeName: docType,
          where: [['pollId', '==', pollId], choiceClause(choice)],
        });
      }
      return counts;
    } catch (error) {
      logger.warn('PollrVoteService: per-choice counts failed', {
        error: extractErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * v3, closed poll: count the ballots created by `closedAt`, off
   * `pollVotesByTime`. One bounded read, so the counts can't mix chain states
   * the way a count-tree read minus a separate late-ballot read could.
   *
   * Null when there are more than one read can page through; the caller then
   * falls back to the count tree and marks the tally `lateIncluded`, so it is
   * shown but not as final. A failed read throws
   * {@link PollTallyUnavailableError} instead: falling back there would let a
   * transient error flip "Final results" to a count with late ballots in.
   */
  private async countOnTimeBallots(
    sdk: Sdk,
    pollId: string,
    docType: string,
    closedAt: number
  ): Promise<number[] | null> {
    try {
      const { documents: choices, reachedLimit } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: POLLR_CONTRACT_ID,
          documentTypeName: docType,
          where: [
            ['pollId', '==', pollId],
            ['$createdAt', '<=', closedAt],
          ],
          orderBy: [
            ['pollId', 'asc'],
            ['$createdAt', 'asc'],
          ],
        }),
        readChoice
      );
      if (reachedLimit) {
        logger.warn('PollrVoteService: too many ballots to bound by close time; tally includes late ones', { pollId });
        return null;
      }
      return countChoices(choices);
    } catch (error) {
      logger.warn('PollrVoteService: could not read on-time ballots for a closed poll', {
        pollId,
        error: extractErrorMessage(error),
      });
      throw new PollTallyUnavailableError(pollId);
    }
  }

  /** Fallback 2 (v3): page `pollVotesByTime` and tally client-side. */
  private async countByChoiceScan(sdk: Sdk, pollId: string, docType: string): Promise<number[] | null> {
    try {
      const { documents: choices, reachedLimit } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: POLLR_CONTRACT_ID,
          documentTypeName: docType,
          where: [
            ['pollId', '==', pollId],
            ['$createdAt', '>', 0],
          ],
          orderBy: [
            ['pollId', 'asc'],
            ['$createdAt', 'asc'],
          ],
        }),
        readChoice
      );

      if (reachedLimit) {
        logger.warn('PollrVoteService: vote scan hit the pagination cap; tally may undercount', { pollId });
      }

      return countChoices(choices);
    } catch (error) {
      logger.error('PollrVoteService: unable to tally votes', error);
      return null;
    }
  }
}

/**
 * Merge a freshly read tally with the caller's optimistic one (v3).
 *
 * The fresh counts are trusted: a stale count is no lower bound. Only the
 * options `created` in this call keep their optimistic count, since the count
 * tree may not show those writes yet, and every choice the voter has recorded
 * counts at least once. The total is re-summed so the percentages still add
 * up. A cutoff-verified tally is returned as read: a ballot it leaves out
 * landed after the close, so adding it back would put a late vote into the
 * final results. The fresh tally's flags are kept either way.
 */
export function reconcileTally(
  fresh: PollTally,
  optimistic: PollTally | null,
  created: number[],
  myChoices: number[]
): PollTally {
  if (fresh.cutoffVerified) return fresh;
  const counts = fresh.counts.map((count, index) => {
    const pending = created.includes(index) ? optimistic?.counts[index] ?? 0 : 0;
    const floor = myChoices.includes(index) ? 1 : 0;
    return Math.max(count, pending, floor);
  });
  return { ...fresh, counts, total: sumCounts(counts) };
}

/** Whether the poll's close time has passed on this device's clock. */
export function pollIsClosed(poll: Poll, now: number = Date.now()): boolean {
  return typeof poll.endsAt === 'number' && Number.isFinite(poll.endsAt) && now > poll.endsAt;
}

/** v7: the tally was read off the chain after the close (plus its grace), so no ballot can still change it. */
function readAfterClose(poll: Poll, tally: PollTally): boolean {
  return typeof poll.endsAt === 'number' && tally.readAt !== undefined && tally.readAt > poll.endsAt + FINAL_TALLY_GRACE_MS;
}

/**
 * Whether a closed poll's tally may be shown as final results.
 *
 * - v7: ballots are final once the poll closes, so any tally read off the
 *   chain after the close is; an optimistic one (no `readAt`) never is.
 * - v3: only a tally read by the close time: an optimistic or open-poll one can
 *   hold a ballot written after it.
 * - v4: no time axis to bound by, so only a tally known to include late
 *   ballots is excluded.
 */
export function tallyIsFinal(poll: Poll, tally: PollTally): boolean {
  if (!pollIsClosed(poll)) return false;
  if (pollrHasEditableBallots()) return readAfterClose(poll, tally);
  return pollrIsV4() ? !tally.lateIncluded : Boolean(tally.cutoffVerified);
}

/** A closed v3 poll's close time, the cutoff its ballots are tallied by; else null. */
function closedCutoff(poll: Poll): number | null {
  return pollrIsV3() && pollIsClosed(poll) ? poll.endsAt ?? null : null;
}

/**
 * Whether a cached tally may stand in for a read. A closed v3 poll reuses only
 * one the closed path classified (one cached while it was open, or an
 * optimistic one, was never bounded by the close time); a closed v7 poll only
 * one read after the close. An open poll, or v4, reuses any.
 */
function cachedTallyUsable(poll: Poll, cached: PollTally): boolean {
  if (!pollIsClosed(poll)) return true;
  if (pollrIsV3()) return Boolean(cached.cutoffVerified || cached.lateIncluded);
  if (pollrHasEditableBallots()) return readAfterClose(poll, cached);
  return true;
}

/** Trim or pad a counts array to the poll's actual option count. */
function resize(counts: number[], size: number): number[] {
  return Array.from({ length: size }, (_, i) => counts[i] ?? 0);
}

export const pollrVoteService = new PollrVoteService();
