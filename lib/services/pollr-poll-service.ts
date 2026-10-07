import { BaseDocumentService } from './document-service';
import { settlePendingPollrReplaces } from './pollr-pending-writes';
import { POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES, POLLR_TOPOLOGY, pollrIsV5 } from '@/lib/constants';
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
 * byte-array fields.
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

    if (pollrIsV5()) {
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
}

export const pollrPollService = new PollrPollService();
