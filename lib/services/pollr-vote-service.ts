import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import {
  POLLR_CONTRACT_ID,
  POLLR_DOCUMENT_TYPES,
  POLL_MAX_OPTIONS,
} from '@/lib/constants';
import { extractErrorMessage } from '@/lib/error-utils';
import { identifierStringToDocumentBytes, normalizeSDKResponse } from './sdk-helpers';
import { documentCount, paginateFetchAll } from './pagination-utils';

/** Result of casting a (possibly multi-choice) ballot. */
export interface CastVoteResult {
  /** True when every requested choice is recorded on Platform. */
  success: boolean;
  /** Choices this call wrote. */
  created: number[];
  /** Choices the voter had already cast (unique-index rejection). */
  alreadyVoted: number[];
  /** Message from the first hard failure, if any. */
  error?: string;
}

export interface PollTally {
  /** Vote count per option index. */
  counts: number[];
  /** Total vote documents for the poll (a multi-choice ballot contributes one per selection). */
  total: number;
}

/** Grouped count keys are hex of the platform-encoded integer byte: 0x80 + choice. */
const CHOICE_KEY_OFFSET = 0x80;

const TALLY_CACHE_TTL_MS = 30_000;

/**
 * Platform rejects a repeat vote with the `voterChoice` unique index violation.
 * Callers treat this as "already voted" rather than an error.
 */
export function isDuplicateVoteError(error: unknown): boolean {
  return extractErrorMessage(error).toLowerCase().includes('duplicate unique properties');
}

class PollrVoteService {
  private tallyCache = new Map<string, { data: PollTally; timestamp: number }>();

  /**
   * Cast a ballot: one immutable `vote` document per selected choice.
   *
   * Platform rejects state transitions carrying more than one document
   * transition, so multi-choice ballots MUST be written sequentially — one
   * createDocument call per choice, each awaited so nonces stay ordered.
   */
  async castVote(
    pollId: string,
    pollOwnerId: string,
    choices: number[],
    ownerId: string
  ): Promise<CastVoteResult> {
    const selected = Array.from(new Set(choices))
      .filter((choice) => Number.isInteger(choice) && choice >= 0 && choice < POLL_MAX_OPTIONS)
      .sort((a, b) => a - b);

    if (selected.length === 0) {
      return { success: false, created: [], alreadyVoted: [], error: 'No choice selected' };
    }

    const created: number[] = [];
    const alreadyVoted: number[] = [];

    for (const choice of selected) {
      try {
        const result = await stateTransitionService.createDocument(
          POLLR_CONTRACT_ID,
          POLLR_DOCUMENT_TYPES.VOTE,
          ownerId,
          {
            // Identifier-typed contract fields must reach the typed write path as raw bytes.
            pollId: identifierStringToDocumentBytes(pollId),
            pollOwnerId: identifierStringToDocumentBytes(pollOwnerId),
            choice,
          }
        );

        if (result.success) {
          created.push(choice);
          continue;
        }

        if (isDuplicateVoteError(result.error)) {
          alreadyVoted.push(choice);
          continue;
        }

        this.invalidateTally(pollId);
        return { success: false, created, alreadyVoted, error: result.error || 'Failed to cast vote' };
      } catch (error) {
        if (isDuplicateVoteError(error)) {
          alreadyVoted.push(choice);
          continue;
        }
        this.invalidateTally(pollId);
        return { success: false, created, alreadyVoted, error: extractErrorMessage(error) };
      }
    }

    this.invalidateTally(pollId);
    return { success: true, created, alreadyVoted };
  }

  /**
   * Which choices `userId` has already cast on this poll.
   * Uses the `voterChoice` unique index prefix [pollId, $ownerId].
   */
  async getMyVotes(pollId: string, userId: string): Promise<number[]> {
    try {
      const sdk = await getEvoSdk();
      const response = await sdk.documents.query({
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
        where: [
          ['pollId', '==', pollId],
          ['$ownerId', '==', userId],
        ],
        orderBy: [
          ['pollId', 'asc'],
          ['$ownerId', 'asc'],
          ['choice', 'asc'],
        ],
        limit: POLL_MAX_OPTIONS,
      });

      const choices = normalizeSDKResponse(response)
        .map((doc) => Number((doc.data as Record<string, unknown> | undefined)?.choice ?? doc.choice))
        .filter((choice) => Number.isInteger(choice) && choice >= 0 && choice < POLL_MAX_OPTIONS);

      return Array.from(new Set(choices)).sort((a, b) => a - b);
    } catch (error) {
      logger.error('PollrVoteService: failed to load own votes', error);
      return [];
    }
  }

  /**
   * Per-option counts plus the grand total, served from a short-TTL cache.
   *
   * Primary path uses the contract's countable indices (O(1) count trees):
   * `pollTotal` for the total and `choiceCounts` (grouped) for the breakdown.
   */
  async getTally(pollId: string, optionCount: number = POLL_MAX_OPTIONS): Promise<PollTally> {
    const size = Math.min(Math.max(optionCount, 1), POLL_MAX_OPTIONS);

    const cached = this.tallyCache.get(pollId);
    if (cached && Date.now() - cached.timestamp < TALLY_CACHE_TTL_MS) {
      return { total: cached.data.total, counts: resize(cached.data.counts, size) };
    }

    const sdk = await getEvoSdk();

    let counts = await this.countByChoiceGrouped(sdk, pollId);
    if (!counts) counts = await this.countByChoiceIndividually(sdk, pollId);
    if (!counts) counts = await this.countByChoiceScan(sdk, pollId);
    const resolvedCounts = counts ?? new Array<number>(POLL_MAX_OPTIONS).fill(0);

    // Grand total via the `pollTotal` countable index. Never pass a limit on
    // count queries — Drive rejects them with InvalidLimit. On failure the
    // per-choice numbers already sum to the same thing.
    let total: number;
    try {
      total = await documentCount(sdk, {
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
        where: [['pollId', '==', pollId]],
      });
    } catch (error) {
      logger.warn('PollrVoteService: total count failed, summing per-choice counts', {
        error: extractErrorMessage(error),
      });
      total = resolvedCounts.reduce((sum, count) => sum + count, 0);
    }

    const tally: PollTally = { counts: resolvedCounts, total };
    this.tallyCache.set(pollId, { data: tally, timestamp: Date.now() });

    return { total: tally.total, counts: resize(tally.counts, size) };
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
   * One round-trip against the `choiceCounts` countable index.
   * Returns null (so the caller can fall back) when the response can't be decoded.
   */
  private async countByChoiceGrouped(
    sdk: Awaited<ReturnType<typeof getEvoSdk>>,
    pollId: string
  ): Promise<number[] | null> {
    try {
      const raw = await sdk.documents.count({
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
        where: [
          ['pollId', '==', pollId],
          ['choice', 'in', Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => i)],
        ],
        groupBy: ['choice'],
      });

      const entries = Array.from(raw.entries());
      const counts = new Array<number>(POLL_MAX_OPTIONS).fill(0);
      let matched = 0;

      for (const [key, value] of entries) {
        if (key === '') continue; // aggregate-mode key; shouldn't appear with groupBy set
        const choice = parseInt(key, 16) - CHOICE_KEY_OFFSET;
        if (!Number.isInteger(choice) || choice < 0 || choice >= POLL_MAX_OPTIONS) continue;
        counts[choice] = Number(value);
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

  /** Fallback 1: one equality count per choice against the same countable index. */
  private async countByChoiceIndividually(
    sdk: Awaited<ReturnType<typeof getEvoSdk>>,
    pollId: string
  ): Promise<number[] | null> {
    try {
      const counts = new Array<number>(POLL_MAX_OPTIONS).fill(0);
      for (let choice = 0; choice < POLL_MAX_OPTIONS; choice++) {
        counts[choice] = await documentCount(sdk, {
          dataContractId: POLLR_CONTRACT_ID,
          documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
          where: [
            ['pollId', '==', pollId],
            ['choice', '==', choice],
          ],
        });
      }
      return counts;
    } catch (error) {
      logger.warn('PollrVoteService: per-choice counts failed, falling back to a vote scan', {
        error: extractErrorMessage(error),
      });
      return null;
    }
  }

  /** Fallback 2: paginate the `pollVotesByTime` index and tally client-side. */
  private async countByChoiceScan(
    sdk: Awaited<ReturnType<typeof getEvoSdk>>,
    pollId: string
  ): Promise<number[] | null> {
    try {
      const { documents, reachedLimit } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: POLLR_CONTRACT_ID,
          documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
          where: [
            ['pollId', '==', pollId],
            ['$createdAt', '>', 0],
          ],
          orderBy: [
            ['pollId', 'asc'],
            ['$createdAt', 'asc'],
          ],
        }),
        (doc) => Number((doc.data as Record<string, unknown> | undefined)?.choice ?? doc.choice)
      );

      if (reachedLimit) {
        logger.warn('PollrVoteService: vote scan hit the pagination cap; tally may undercount', { pollId });
      }

      const counts = new Array<number>(POLL_MAX_OPTIONS).fill(0);
      for (const choice of documents) {
        if (Number.isInteger(choice) && choice >= 0 && choice < POLL_MAX_OPTIONS) {
          counts[choice] += 1;
        }
      }
      return counts;
    } catch (error) {
      logger.error('PollrVoteService: unable to tally votes', error);
      return null;
    }
  }
}

/** Trim or pad a counts array to the poll's actual option count. */
function resize(counts: number[], size: number): number[] {
  return Array.from({ length: size }, (_, i) => counts[i] ?? 0);
}

export const pollrVoteService = new PollrVoteService();
