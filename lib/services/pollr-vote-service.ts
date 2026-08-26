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
  /** Choices that hit a real error and are still uncast — safe to retry. */
  failed: number[];
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

type Sdk = Awaited<ReturnType<typeof getEvoSdk>>;

/** `[0, 1, ... n-1]` — the choice indices to query, for a count's `in` clause. */
function choiceRange(optionCount: number): number[] {
  const size = Math.min(Math.max(Math.trunc(optionCount) || POLL_MAX_OPTIONS, 1), POLL_MAX_OPTIONS);
  return Array.from({ length: size }, (_, index) => index);
}

function isValidChoice(choice: number): boolean {
  return Number.isInteger(choice) && choice >= 0 && choice < POLL_MAX_OPTIONS;
}

/** Dedupe, drop out-of-range values, and order a ballot's choices. */
function normalizeChoices(choices: number[]): number[] {
  return Array.from(new Set(choices)).filter(isValidChoice).sort((a, b) => a - b);
}

/** Read the `choice` field off a raw vote document (nested `data` or flat). */
function readChoice(doc: Record<string, unknown>): number {
  return Number((doc.data as Record<string, unknown> | undefined)?.choice ?? doc.choice);
}

function zeroCounts(): number[] {
  return new Array<number>(POLL_MAX_OPTIONS).fill(0);
}

/**
 * Platform rejects a repeat vote with the `voterChoice` unique index violation.
 * Callers treat this as "already voted" rather than an error.
 */
export function isDuplicateVoteError(error: unknown): boolean {
  return extractErrorMessage(error).toLowerCase().includes('duplicate unique properties');
}

/**
 * Votes on the shared Pollr contract: one immutable document per selection,
 * unique per (poll, voter, choice) — the shape the `choiceCounts` count tree
 * needs for O(1) per-option tallies.
 *
 * That uniqueness rule is as far as the contract can go. DPP has no
 * cross-document validation, so a vote cannot be checked against the poll's
 * `multiChoice` flag on write, and no index can be conditional on it. A
 * single-choice poll is single-choice by client convention — this app and Pollr
 * both close the ballot once a vote is recorded — while a hand-rolled write can
 * still add a second choice, which lands as an extra selection in the per-option
 * counts rather than as a corrupted tally.
 */
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
    ownerId: string,
    endsAt?: number
  ): Promise<CastVoteResult> {
    const selected = normalizeChoices(choices);

    if (selected.length === 0) {
      return { success: false, created: [], alreadyVoted: [], failed: [], error: 'No choice selected' };
    }

    // The close time is advisory — the contract can't enforce it — so clients
    // are the ones that have to refuse a late ballot.
    if (typeof endsAt === 'number' && Number.isFinite(endsAt) && Date.now() > endsAt) {
      return { success: false, created: [], alreadyVoted: [], failed: [], error: 'This poll has closed' };
    }

    const created: number[] = [];
    const alreadyVoted: number[] = [];
    const failed: number[] = [];
    let firstError: string | undefined;

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
        } else if (isDuplicateVoteError(result.error)) {
          alreadyVoted.push(choice);
        } else {
          // Keep going: the remaining choices are independent documents, and
          // re-submitting a landed one is idempotent thanks to the unique index.
          failed.push(choice);
          firstError ??= result.error || 'Failed to cast vote';
        }
      } catch (error) {
        if (isDuplicateVoteError(error)) {
          alreadyVoted.push(choice);
        } else {
          failed.push(choice);
          firstError ??= extractErrorMessage(error);
        }
      }
    }

    this.invalidateTally(pollId);
    return { success: failed.length === 0, created, alreadyVoted, failed, error: firstError };
  }

  /**
   * Fold just-cast votes into the cached tally.
   *
   * Platform's count trees can lag a few seconds behind a confirmed write, so
   * re-reading right after voting can return the pre-vote numbers — and that
   * stale answer would then be cached for the full TTL. Incrementing the
   * caller's current tally instead keeps the UI honest until the next remount
   * refetches for real.
   */
  applyOptimisticVotes(pollId: string, baseline: PollTally, createdChoices: number[]): PollTally {
    const counts = [...baseline.counts];
    let added = 0;
    for (const choice of createdChoices) {
      if (choice < 0 || choice >= counts.length) continue;
      counts[choice] += 1;
      added += 1;
    }

    const tally: PollTally = { counts, total: baseline.total + added };
    this.tallyCache.set(pollId, { data: tally, timestamp: Date.now() });
    return tally;
  }

  /**
   * Which choices `userId` has already cast on this poll.
   * Uses the `voterChoice` unique index prefix [pollId, $ownerId].
   *
   * Throws on failure rather than reporting "no votes": an empty answer reopens
   * the ballot, and the contract's uniqueness rule is per (poll, voter, choice),
   * so a single-choice voter could then record a second, different choice.
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

      return normalizeChoices(normalizeSDKResponse(response).map(readChoice));
    } catch (error) {
      logger.error('PollrVoteService: failed to load own votes', error);
      throw error;
    }
  }

  /**
   * Per-option counts plus the grand total, served from a short-TTL cache.
   *
   * Primary path is the contract's `choiceCounts` countable index (an O(1)
   * count tree), grouped by choice; the total is summed from those per-option
   * numbers rather than read from `pollTotal`.
   */
  async getTally(pollId: string, optionCount: number = POLL_MAX_OPTIONS): Promise<PollTally> {
    const size = Math.min(Math.max(optionCount, 1), POLL_MAX_OPTIONS);

    const cached = this.tallyCache.get(pollId);
    if (cached && Date.now() - cached.timestamp < TALLY_CACHE_TTL_MS) {
      return { total: cached.data.total, counts: resize(cached.data.counts, size) };
    }

    const sdk = await getEvoSdk();

    // Each step falls through to the next only when it couldn't produce counts.
    const resolvedCounts =
      (await this.countByChoiceGrouped(sdk, pollId, size)) ??
      (await this.countByChoiceIndividually(sdk, pollId, size)) ??
      (await this.countByChoiceScan(sdk, pollId));

    // The total is the sum of the poll's REAL options, not the `pollTotal`
    // count tree. `choice` is schema-valid for 0-9 whatever the poll's actual
    // option count is, so anyone can write votes for options that don't exist:
    // those inflate pollTotal while the per-option tally rightly ignores them,
    // and percentages stop summing to 100. Summing here also saves a round-trip.
    // pollTotal is only consulted when no per-choice path produced counts.
    let counts = resolvedCounts;
    let total: number;
    if (counts) {
      total = counts.slice(0, size).reduce((sum, count) => sum + count, 0);
    } else {
      counts = zeroCounts();
      try {
        total = await documentCount(sdk, {
          dataContractId: POLLR_CONTRACT_ID,
          documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
          where: [['pollId', '==', pollId]],
        });
      } catch (error) {
        logger.warn('PollrVoteService: total count failed and no per-choice counts available', {
          error: extractErrorMessage(error),
        });
        total = 0;
      }
    }

    const tally: PollTally = { counts, total };
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
  private async countByChoiceGrouped(sdk: Sdk, pollId: string, optionCount: number): Promise<number[] | null> {
    try {
      const raw: unknown = await sdk.documents.count({
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: POLLR_DOCUMENT_TYPES.VOTE,
        where: [
          ['pollId', '==', pollId],
          // Only the poll's real options: `choice` is schema-valid for 0-9
          // regardless, so a wider `in` would pull groups for options that
          // don't exist on this poll.
          ['choice', 'in', choiceRange(optionCount)],
        ],
        groupBy: ['choice'],
      });

      // The SDK returns Map<string, bigint>; tolerate a plain-object shape the
      // same way documentCount/groupedDocumentCount do.
      const entries: [string, unknown][] = raw instanceof Map
        ? Array.from(raw.entries())
        : Object.entries((raw ?? {}) as Record<string, unknown>);
      const counts = zeroCounts();
      let matched = 0;

      for (const [key, value] of entries) {
        if (key === '') continue; // aggregate-mode key; shouldn't appear with groupBy set
        const choice = parseInt(key, 16) - CHOICE_KEY_OFFSET;
        if (!isValidChoice(choice)) continue;
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

  /** Fallback 1: one equality count per choice against the same countable index. */
  private async countByChoiceIndividually(sdk: Sdk, pollId: string, optionCount: number): Promise<number[] | null> {
    try {
      const counts = zeroCounts();
      // Only the poll's real options — the remaining slots stay 0.
      for (const choice of choiceRange(optionCount)) {
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
  private async countByChoiceScan(sdk: Sdk, pollId: string): Promise<number[] | null> {
    try {
      const { documents: choices, reachedLimit } = await paginateFetchAll(
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
        readChoice
      );

      if (reachedLimit) {
        logger.warn('PollrVoteService: vote scan hit the pagination cap; tally may undercount', { pollId });
      }

      const counts = zeroCounts();
      for (const choice of choices) {
        if (isValidChoice(choice)) {
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
