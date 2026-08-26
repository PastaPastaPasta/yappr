import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { chunk, mapLimit, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import {
  POLLR_CONTRACT_ID,
  POLLR_DOCUMENT_TYPES,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
} from '@/lib/constants';

/**
 * A poll on the shared Pollr contract.
 *
 * The contract models choices as enumerated `option0`..`option9` string fields
 * (option0/option1 required), which this service flattens into `options`.
 * Poll documents are immutable and contain no byte-array fields.
 */
export interface Poll {
  id: string;
  ownerId: string;
  createdAt: Date;
  question: string;
  options: string[];
  /** True when voters may select more than one choice. */
  multiChoice: boolean;
  /** Advisory close time in ms since epoch. Not enforced on-chain. */
  endsAt?: number;
}

export interface CreatePollData {
  question: string;
  options: string[];
  multiChoice?: boolean;
  /** Advisory close time in ms since epoch. */
  endsAt?: number;
}

/** Field name for the nth choice, matching the contract's enumerated properties. */
function optionField(index: number): string {
  return `option${index}`;
}

/** Numeric contract field, or undefined when absent or unusable. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

class PollrPollService extends BaseDocumentService<Poll> {
  constructor() {
    super(POLLR_DOCUMENT_TYPES.POLL, POLLR_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): Poll {
    const data = (doc.data || doc) as Record<string, unknown>;

    const options: string[] = [];
    for (let i = 0; i < POLL_MAX_OPTIONS; i++) {
      const value = data[optionField(i)] ?? doc[optionField(i)];
      // Choices are contiguous by construction; stop at the first gap so a
      // malformed document can never produce holes in the options array.
      if (typeof value !== 'string' || value.length === 0) break;
      options.push(value);
    }

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date(Number((doc.$createdAt || doc.createdAt) ?? Date.now())),
      question: ((data.question ?? doc.question) || '') as string,
      options,
      multiChoice: Boolean(data.multiChoice ?? doc.multiChoice ?? false),
      endsAt: toFiniteNumber(data.endsAt ?? doc.endsAt),
    };
  }

  /**
   * Validate and normalize poll input, throwing on anything the contract would reject.
   */
  private normalize(data: CreatePollData): { question: string; options: string[] } {
    const question = data.question.trim();
    if (!question) {
      throw new Error('Poll question is required');
    }
    if (question.length > POLL_QUESTION_MAX_LENGTH) {
      throw new Error(`Poll question must be ${POLL_QUESTION_MAX_LENGTH} characters or fewer`);
    }

    const options = data.options.map((option) => option.trim()).filter((option) => option.length > 0);
    if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
      throw new Error(`Polls need between ${POLL_MIN_OPTIONS} and ${POLL_MAX_OPTIONS} options`);
    }
    if (options.some((option) => option.length > POLL_OPTION_MAX_LENGTH)) {
      throw new Error(`Each option must be ${POLL_OPTION_MAX_LENGTH} characters or fewer`);
    }

    return { question, options };
  }

  /**
   * Create a poll on the Pollr contract.
   *
   * Poll documents carry no token cost — only the usual credit fee.
   * Optional properties are omitted entirely (never sent as null) so the
   * contract's `additionalProperties: false` schema stays satisfied.
   */
  async createPoll(ownerId: string, data: CreatePollData): Promise<Poll> {
    const { question, options } = this.normalize(data);

    const documentData: Record<string, unknown> = { question };
    options.forEach((option, index) => {
      documentData[optionField(index)] = option;
    });
    if (data.multiChoice) {
      documentData.multiChoice = true;
    }
    if (typeof data.endsAt === 'number' && Number.isFinite(data.endsAt) && data.endsAt > 0) {
      documentData.endsAt = Math.floor(data.endsAt);
    }

    return this.create(ownerId, documentData);
  }

  async getPoll(pollId: string): Promise<Poll | null> {
    return this.get(pollId);
  }

  /**
   * Fetch several polls at once — for batch feed hydration, where issuing one
   * `getPoll` per visible post would be a round-trip each. Batched into
   * `$id in [...]` queries because Platform caps `in` clauses at 100 values;
   * falls back to per-id fetches if a batch query fails so one bad batch can't
   * blank out a whole page of polls.
   */
  async getPolls(pollIds: string[]): Promise<Poll[]> {
    const uniqueIds = Array.from(new Set(pollIds.filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    const batches = await mapLimit(chunk(uniqueIds, MAX_IN_CLAUSE_VALUES), 2, async (batch) => {
      try {
        const result = await this.query({ where: [['$id', 'in', batch]], limit: batch.length });
        return result.documents;
      } catch (error) {
        logger.warn('PollrPollService: batched poll query failed, falling back to per-id fetches', {
          error: error instanceof Error ? error.message : String(error),
        });
        const polls = await mapLimit(batch, 4, (id) => this.get(id));
        return polls.filter((poll): poll is Poll => poll !== null);
      }
    });

    return batches.flat();
  }
}

export const pollrPollService = new PollrPollService();
