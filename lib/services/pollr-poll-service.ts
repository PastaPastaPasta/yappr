import { BaseDocumentService } from './document-service';
import { getEvoSdk } from './evo-sdk-service';
import { documentCount } from './pagination-utils';
import { markPollHasBallots, pollHasKnownBallots } from './pollr-known-ballots';
import { pollrWriteMayStillExecute, settlePendingPollrReplaces } from './pollr-pending-writes';
import { stateTransitionService } from './state-transition-service';
import { POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES, POLLR_TOPOLOGY, pollrHasV5Ballots, pollrPollsDeletable } from '@/lib/constants';
import { isDeleteConstraintError } from '@/lib/error-utils';
import {
  POLL_MAX_OPTIONS,
  pollEndsAtError,
  pollLimits,
  pollOptionsError,
  pollQuestionError,
  trimPollOptions,
} from '@/lib/pollr-rules';

/**
 * A poll on the shared Pollr contract.
 *
 * v5 stores the choices as an `options` string array; v3/v4 as enumerated
 * `option0`..`option9` fields (option0/option1 required). This service reads
 * either into `options`. Poll documents are immutable and contain no
 * byte-array fields. v6 keeps v5's poll, and lets its owner delete it until
 * the first ballot (`deletePoll`).
 */
export interface Poll {
  id: string;
  ownerId: string;
  createdAt: Date;
  question: string;
  options: string[];
  /**
   * How many options the poll declares: v5's stored `optionCount`, which every
   * ballot copies (40127 on a mismatch); `options.length` before v5.
   */
  optionCount: number;
  /** True when voters may select more than one choice. */
  multiChoice: boolean;
  /**
   * Close time in ms since epoch. Required on v5, where consensus refuses a
   * ballot written after it; advisory (and optional) on v3/v4.
   */
  endsAt?: number;
}

export interface CreatePollData {
  question: string;
  options: string[];
  multiChoice?: boolean;
  /** Close time in ms since epoch: required on v5, within 31 days. */
  endsAt?: number;
}

/** Field name for the nth choice on v3/v4, matching the contract's enumerated properties. */
function optionField(index: number): string {
  return `option${index}`;
}

/** Numeric contract field, or undefined when absent or unusable. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A poll's choices from its document: v5's `options` array when present, else
 * the v3/v4 enumerated fields. Choices are contiguous by construction, so the
 * enumerated read stops at the first gap and a malformed document can never
 * produce holes.
 */
export function readPollOptions(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.options)) {
    return data.options.filter((option): option is string => typeof option === 'string').slice(0, POLL_MAX_OPTIONS);
  }
  const options: string[] = [];
  for (let i = 0; i < POLL_MAX_OPTIONS; i++) {
    const value = data[optionField(i)];
    if (typeof value !== 'string' || value.length === 0) break;
    options.push(value);
  }
  return options;
}

class PollrPollService extends BaseDocumentService<Poll> {
  constructor() {
    super(POLLR_DOCUMENT_TYPES.POLL, POLLR_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): Poll {
    // Fields may arrive nested under `data` or flat on the document.
    const data = { ...doc, ...((doc.data as Record<string, unknown> | undefined) ?? {}) };

    const options = readPollOptions(data);
    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date(Number((doc.$createdAt || doc.createdAt) ?? Date.now())),
      question: (data.question || '') as string,
      options,
      optionCount: toFiniteNumber(data.optionCount) ?? options.length,
      multiChoice: Boolean(data.multiChoice ?? false),
      endsAt: toFiniteNumber(data.endsAt),
    };
  }

  /**
   * Validate and normalize poll input, throwing on anything the contract would reject.
   */
  private normalize(data: CreatePollData): { question: string; options: string[] } {
    const limits = pollLimits(POLLR_TOPOLOGY);
    const question = data.question.trim();
    const options = trimPollOptions(data.options);
    const problem =
      pollQuestionError(question, limits) ?? pollOptionsError(options, limits) ?? pollEndsAtError(data.endsAt, limits);
    if (problem) throw new Error(problem);
    return { question, options };
  }

  /**
   * Create a poll on the Pollr contract.
   *
   * Poll documents carry no token cost — only the usual credit fee. On v3/v4
   * optional properties are omitted entirely (never sent as null) so the
   * contract's `additionalProperties: false` schema stays satisfied.
   *
   * v5 writes `options` with its `optionCount` (rule-bound to it), and both
   * `multiChoice` and `endsAt` always: every ballot copies all three, bound by
   * consensus to the poll, so the poll has to carry them explicitly.
   */
  async createPoll(ownerId: string, data: CreatePollData): Promise<Poll> {
    const { question, options } = this.normalize(data);
    const endsAt = data.endsAt === undefined ? undefined : Math.floor(data.endsAt);
    // A landed but unconfirmed ballot replace would otherwise hold this create
    // back until its reservation expires. A no-op when nothing is pending.
    await settlePendingPollrReplaces(ownerId);

    if (pollrHasV5Ballots()) {
      return this.create(ownerId, {
        question,
        options,
        optionCount: options.length,
        multiChoice: Boolean(data.multiChoice),
        endsAt,
      });
    }

    const documentData: Record<string, unknown> = { question };
    options.forEach((option, index) => {
      documentData[optionField(index)] = option;
    });
    if (data.multiChoice) {
      documentData.multiChoice = true;
    }
    if (endsAt !== undefined) {
      documentData.endsAt = endsAt;
    }

    return this.create(ownerId, documentData);
  }

  async getPoll(pollId: string): Promise<Poll | null> {
    return this.get(pollId);
  }

  /**
   * Like {@link getPoll}, but only a poll Platform says does not exist reads as
   * null: a failed read throws. On v6 a missing poll may have been deleted by
   * its owner, which must never be shown for a read that merely failed.
   */
  async fetchPoll(pollId: string): Promise<Poll | null> {
    return this.getOrThrow(pollId);
  }

  /**
   * Every ballot naming the poll, withdrawn ones included, off v6's countable
   * `byPoll` index: what the poll's `noBallots` delete rule counts. Throws when
   * the count cannot be read.
   */
  async countBallots(pollId: string): Promise<number> {
    const sdk = await getEvoSdk();
    const ballots = await documentCount(sdk, {
      dataContractId: POLLR_CONTRACT_ID,
      documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
      where: [['pollId', '==', pollId]],
    });
    if (ballots > 0) markPollHasBallots(pollId);
    return ballots;
  }

  /** Whether the poll is known to have a ballot, so it can never be deleted (see pollr-known-ballots). */
  hasBallots(pollId: string): boolean {
    return pollHasKnownBallots(pollId);
  }

  /**
   * Delete the owner's poll (v6), which consensus allows only until its first
   * ballot. The ballots are counted first so a poll someone has voted on is
   * refused without paying for a rejected delete; a ballot landing between that
   * count and the delete is refused by consensus instead (40147, paid), and
   * reported the same way.
   */
  async deletePoll(poll: Poll, ownerId: string): Promise<DeletePollResult> {
    if (!pollrPollsDeletable() || poll.ownerId !== ownerId) return { status: 'failed' };
    if (this.hasBallots(poll.id)) return { status: 'voted' };
    // A landed but unconfirmed ballot replace would otherwise hold this delete
    // back until its reservation expires (as createPoll does). A no-op when
    // nothing is pending.
    await settlePendingPollrReplaces(ownerId);
    // A ballot write of the owner's that may still land (say an unconfirmed
    // vote from another card) would turn this delete into a paid 40147 if it
    // lands while the delete waits its turn. Hold back until it settles, and
    // fail closed on an unreadable store; it proves no ballot, so nothing is
    // marked for good.
    const ownWritePending = await pollrWriteMayStillExecute(ownerId, poll.id).catch(() => true);
    if (ownWritePending) return { status: 'pending' };
    // Re-checked after the awaits: another card may have seen a ballot meanwhile.
    if ((await this.countBallots(poll.id)) > 0 || this.hasBallots(poll.id)) return { status: 'voted' };

    const result = await stateTransitionService.deleteDocument(this.contractId, this.documentType, poll.id, ownerId);
    // Even a reported failure may have landed (a timed-out wait), so the next
    // read goes to Platform.
    this.cache.delete(poll.id);
    if (result.success) return { status: 'deleted' };
    if (isDeleteConstraintError(result.error)) {
      markPollHasBallots(poll.id);
      return { status: 'voted' };
    }
    return { status: 'failed', error: result.error };
  }
}

/**
 * How a poll delete ended: `voted` = someone has voted, so the poll is
 * permanent; `pending` = nothing sent, an own ballot write may still land.
 */
export type DeletePollResult =
  | { status: 'deleted' }
  | { status: 'voted' }
  | { status: 'pending' }
  | { status: 'failed'; error?: string };

export const pollrPollService = new PollrPollService();
