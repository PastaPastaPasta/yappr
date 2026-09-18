import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import {
  POLLR_CONTRACT_ID,
  POLL_MAX_OPTIONS,
  pollrIsV4,
  pollrVoteDocType,
} from '@/lib/constants';
import { extractErrorMessage } from '@/lib/error-utils';
import {
  identifierStringToDocumentBytes,
  normalizeSDKResponse,
  type DocumentOrderByClause,
  type DocumentWhereClause,
} from './sdk-helpers';
import { documentCount, paginateFetchAll } from './pagination-utils';
// Type-only: the ballot doctype and the close time both come off the poll, and
// taking it whole makes a call site physically unable to pair a poll with
// another poll's mode. Erased at compile time, so no runtime import cycle.
import type { Poll } from './pollr-poll-service';

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

/** The leading option of a poll, from the v4 ranked index. */
export interface PollWinner {
  choice: number;
  count: number;
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

/** A ballot refused before anything was written. */
function refused(error: string, failed: number[] = []): CastVoteResult {
  return { success: false, created: [], alreadyVoted: [], failed, error };
}

/** Read the `choice` field off a raw vote document (nested `data` or flat). */
function readChoice(doc: Record<string, unknown>): number {
  return Number((doc.data as Record<string, unknown> | undefined)?.choice ?? doc.choice);
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
 * Platform rejects a colliding ballot with a duplicate-properties violation —
 * from v3's `unique` index, or from v4's structural one-entry-per-value-tuple
 * rule, which reports the same way.
 *
 * What the collision *means* depends on the doctype, and the two differ:
 * on `multiVote` it is "you already cast this choice", but on `vote` the index
 * carries no choice, so it is "you already voted" — for a choice that may not be
 * the one just attempted. `castVote` resolves the difference.
 */
export function isDuplicateVoteError(error: unknown): boolean {
  // Both spellings, because everything downstream of this predicate depends on
  // it: a duplicate that reads as a fresh error would be handed to the landed
  // probe, which finds the voter's EARLIER entry and reports the rejected write
  // as cast. The battery asserts the live v4 text matches (case p3b).
  return /duplicate unique properties|\b40105\b/i.test(extractErrorMessage(error));
}

/**
 * Votes on the shared Pollr contract, one immutable document per selection —
 * the shape the `choiceCounts` count tree needs for O(1) per-option tallies.
 *
 * The poll's `multiChoice` flag selects the ballot doctype, and each carries the
 * uniqueness rule its mode needs: `vote` is unique per (poll, voter), so Platform
 * itself rejects a second single-choice selection, and `multiVote` is unique per
 * (poll, voter, choice). DPP has no cross-document validation, so no single
 * doctype could have done this — a uniqueness rule can't be conditional on a
 * field in another document. Splitting it moves the enforcement onto the wire:
 * `poll` is immutable, so the flag can't be flipped after ballots land, and
 * documents written to the doctype a poll doesn't use are never read.
 *
 * On v4 (docs/NON_SOCIAL_CONTRACTS.md) both doctypes are indexOnly and the same two rules
 * become STRUCTURAL rather than declared: `vote.byPoll [pollId]` terminal
 * `$ownerId` admits one entry per (poll, voter), `multiVote.byPollChoice`
 * admits one per (poll, choice, voter). indexOnly types cannot carry `unique`
 * indexes at all, so this is the only spelling available — and the tally shape
 * is unchanged, because both topologies count the same [pollId, choice] tree.
 */
class PollrVoteService {
  private tallyCache = new TtlMap<string, PollTally>(TALLY_CACHE_TTL_MS);

  /**
   * Cast a ballot: one immutable document per selected choice, in the doctype
   * the poll's mode calls for.
   *
   * Platform rejects state transitions carrying more than one document
   * transition, so multi-choice ballots MUST be written sequentially — one
   * createDocument call per choice, each awaited so nonces stay ordered.
   */
  async castVote(poll: Poll, choices: number[], ownerId: string): Promise<CastVoteResult> {
    const selected = normalizeChoices(choices);

    if (selected.length === 0) {
      return refused('No choice selected');
    }

    // Not reachable through the UI (the ballot renders radios for this mode), so
    // this is a caller bug rather than user input — refuse instead of silently
    // dropping selections, which would report a ballot the voter didn't cast.
    if (!poll.multiChoice && selected.length > 1) {
      return refused('This poll takes a single choice', selected);
    }

    // The close time is advisory — the contract can't enforce it — so clients
    // are the ones that have to refuse a late ballot.
    const { endsAt } = poll;
    if (typeof endsAt === 'number' && Number.isFinite(endsAt) && Date.now() > endsAt) {
      return refused('This poll has closed');
    }

    const isV4 = pollrIsV4();
    const docType = pollrVoteDocType(poll.multiChoice);
    const created: number[] = [];
    const alreadyVoted: number[] = [];
    const failed: number[] = [];
    let firstError: string | undefined;

    // What a write Platform refused actually means. The order is load-bearing,
    // and the create path reports a refusal two ways (a failed result or a
    // throw), so both go through here.
    const recordRejection = async (choice: number, error: unknown, message: string): Promise<void> => {
      if (isDuplicateVoteError(error)) {
        // Checked BEFORE the landed probe: on a duplicate the entry is already
        // there from an earlier ballot, so the probe would happily report this
        // rejected write as created.
        alreadyVoted.push(...(await this.resolveDuplicate(poll, choice, ownerId)));
      } else if (await this.ballotLanded(poll, choice, ownerId, { whenUnknown: false })) {
        created.push(choice);
      } else {
        // Keep going: the remaining choices are independent documents, and
        // re-submitting a landed one is idempotent thanks to the unique index.
        failed.push(choice);
        firstError ??= message;
      }
    };

    for (const choice of selected) {
      try {
        const result = await stateTransitionService.createDocument(
          POLLR_CONTRACT_ID,
          docType,
          ownerId,
          {
            // Identifier-typed contract fields must reach the typed write path as raw bytes.
            pollId: identifierStringToDocumentBytes(poll.id),
            // v4 binds this to the poll's `$ownerId` through a system-field
            // propertyAgreement, so the poll's real creator is the only value
            // consensus accepts; on v3 nothing is checked and it is the same
            // value anyway.
            pollOwnerId: identifierStringToDocumentBytes(poll.ownerId),
            choice,
          },
          // v4 ballots are indexOnly: there is no id-addressable row for the
          // strict confirmation probes to find, and the transition proves as an
          // affected-state snapshot rather than ExecutionProved.
          isV4 ? { confirmation: 'affectedState' } : undefined
        );

        if (
          result.success &&
          (result.confirmed !== false || (await this.ballotLanded(poll, choice, ownerId, { whenUnknown: true })))
        ) {
          created.push(choice);
        } else if (result.success) {
          // v4 only: an UNCONFIRMED success that the chain does not show.
          // `createDocument` returns optimistic success when the confirmation
          // wait times out, and its own landed-check (`documents.get` by id)
          // can never resolve for an indexOnly doctype, so that branch always
          // fires on a 504 — including when the transition was then rejected.
          // Reporting it as cast would close a single-choice ballot the voter
          // never actually filed.
          failed.push(choice);
          firstError ??= 'The network did not confirm your vote — try again';
        } else {
          await recordRejection(choice, result.error, result.error || 'Failed to cast vote');
        }
      } catch (error) {
        await recordRejection(choice, error, extractErrorMessage(error));
      }
    }

    this.invalidateTally(poll.id);
    return {
      success: failed.length === 0,
      created,
      alreadyVoted: normalizeChoices(alreadyVoted),
      failed,
      error: firstError,
    };
  }

  /**
   * Is this voter's entry on chain? The chain, not the write path's verdict,
   * decides whether a v4 ballot counts as cast — and it is consulted from both
   * sides, because v4's create path can be wrong in either direction:
   * `affectedState` reports optimistic success when the confirmation wait times
   * out (and its own get-by-id landed-check can never resolve for an indexOnly
   * doctype), while the js create path can fail *after* a successful broadcast
   * without ever returning a usable Document — the same quirk `like-service`
   * handles.
   *
   * `whenUnknown` is the answer when the chain cannot be asked: on v3, where a
   * ballot is a stored document with real confirmation and there is nothing to
   * second-guess, and on a read that failed, since an unreachable DAPI is
   * evidence for neither side. Each caller passes the value that leaves the
   * write path's own verdict standing, and the next remount re-reads the real
   * state either way.
   *
   * The probe is polled rather than read once: an indexOnly write is not
   * query-visible the instant its transition settles, so a single immediate
   * read would call a landed ballot missing (like-service polls the same way).
   */
  private async ballotLanded(
    poll: Poll,
    choice: number,
    ownerId: string,
    { whenUnknown, attempts = 4, intervalMs = 2_500 }: { whenUnknown: boolean; attempts?: number; intervalMs?: number }
  ): Promise<boolean> {
    if (!pollrIsV4()) return whenUnknown;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (await this.ballotExists(poll, choice, ownerId)) return true;
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      return false;
    } catch (error) {
      logger.warn('PollrVoteService: could not check a ballot against the chain', {
        pollId: poll.id,
        choice,
        assumedLanded: whenUnknown,
        error: extractErrorMessage(error),
      });
      return whenUnknown;
    }
  }

  /**
   * v4 entry probe: does this voter's entry for (poll, choice) exist?
   *
   * Equality on the two `byPollChoice` properties plus the terminal `$ownerId`
   * lowers onto that index's member key. This is the only way to confirm an
   * indexOnly write — `documents.get` has no row to find.
   */
  private async ballotExists(poll: Poll, choice: number, ownerId: string): Promise<boolean> {
    const sdk = await getEvoSdk();
    const response = await sdk.documents.query({
      dataContractId: POLLR_CONTRACT_ID,
      documentTypeName: pollrVoteDocType(poll.multiChoice),
      where: [
        ['pollId', '==', poll.id],
        ['choice', '==', choice],
        ['$ownerId', '==', ownerId],
      ],
      limit: 1,
    });
    return normalizeSDKResponse(response).length > 0;
  }

  /**
   * Which choice a rejected-as-duplicate write collided with.
   *
   * On `multiVote` the unique index includes `choice`, so the collision is with
   * the choice just attempted. On `vote` it does not: the voter had already
   * cast a ballot, but not necessarily this one, and reporting the attempted
   * choice would tick "your vote" against an option they never picked. Re-read
   * the ballot to find out which it really is, and fall back to the attempted
   * choice only if that read fails too.
   */
  private async resolveDuplicate(poll: Poll, choice: number, ownerId: string): Promise<number[]> {
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
    return [choice];
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
    this.tallyCache.set(pollId, tally);
    return tally;
  }

  /**
   * Which choices `userId` has already cast on this poll.
   *
   * v3 reads the unique index, which leads with [pollId, $ownerId]: one ranged
   * read. v4 has no such index — its terminal must be `$ownerId` or a refersTo
   * identifier, and `choice` is an integer, so no index can be keyed
   * (poll, voter) → choice. Instead the read walks `byPollChoice`'s choice
   * level with an `in` over every schema-valid choice and pins the terminal:
   * `pollId ==`, `choice in [...]`, `$ownerId ==`. An `in` on an indexOnly
   * prefix property REQUIRES the matching orderBy, or the query is refused.
   *
   * Throws on failure rather than reporting "no votes": an empty answer reopens
   * the ballot, which on a single-choice poll walks the voter into a write
   * Platform will reject outright.
   */
  async getMyVotes(poll: Poll, userId: string): Promise<number[]> {
    // One branch per topology/mode, each spelling its whole query: the three
    // clauses have to agree with one another and with the index being read.
    let query: { where: DocumentWhereClause[]; orderBy: DocumentOrderByClause[]; limit: number };

    if (pollrIsV4()) {
      query = {
        where: [
          ['pollId', '==', poll.id],
          // The FULL 0-9 range, not the poll's option count: `choice` is
          // schema-valid for 0-9 whatever the poll declares, and a ballot
          // this read cannot see reopens a ballot Platform will reject.
          // (getTally narrows on purpose — there the out-of-range groups
          // are noise; here they are the voter's own state.)
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

    try {
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
   * The leading option, straight off v4's ranked secondary on `byPollChoice`:
   * `groupBy choice, aggregate count, where pollId == P, limit 1` is O(log n)
   * and proved, where v3 could only sort a full tally client-side.
   *
   * Returns null on v3 (no ranked index) and when the poll has no ballots.
   */
  async getWinner(poll: Poll): Promise<PollWinner | null> {
    if (!pollrIsV4()) return null;
    try {
      const sdk = await getEvoSdk();
      const page = await sdk.documents.ranked({
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: pollrVoteDocType(poll.multiChoice),
        groupBy: 'choice',
        aggregate: { type: 'count' },
        where: [['pollId', '==', poll.id]],
        limit: 1,
      });
      const top = page?.entries?.[0];
      // Ranked pages hand integer group values back decoded, unlike grouped
      // counts (which key by the hex of 0x80 + choice).
      const choice = Number(top?.groupValue);
      const count = Number(top?.value ?? 0);
      if (!isValidChoice(choice) || count <= 0) return null;
      return { choice, count };
    } catch (error) {
      logger.warn('PollrVoteService: ranked winner query failed', { pollId: poll.id, error: extractErrorMessage(error) });
      return null;
    }
  }

  /**
   * Per-option counts plus the grand total, served from a short-TTL cache.
   *
   * Primary path is the ballot doctype's `choiceCounts` countable index (an
   * O(1) count tree), grouped by choice. Only the doctype this poll's mode uses
   * is read, so ballots written to the other one can never reach the numbers.
   *
   * Throws {@link PollTallyUnavailableError} when no path produced counts —
   * see that class for why a zero-filled stand-in isn't an acceptable answer.
   */
  async getTally(poll: Poll): Promise<PollTally> {
    const size = Math.min(Math.max(poll.options.length, 1), POLL_MAX_OPTIONS);

    const cached = this.tallyCache.get(poll.id);
    if (cached) return { total: cached.total, counts: resize(cached.counts, size) };

    const sdk = await getEvoSdk();
    const docType = pollrVoteDocType(poll.multiChoice);

    // Each step falls through to the next only when it couldn't produce counts.
    const counts =
      (await this.countByChoiceGrouped(sdk, poll.id, docType, size)) ??
      (await this.countByChoiceIndividually(sdk, poll.id, docType, size)) ??
      (pollrIsV4()
        ? await this.countByChoiceKeyset(sdk, poll.id, docType, size)
        : await this.countByChoiceScan(sdk, poll.id, docType));

    // Nothing worked. A grand-total count is deliberately NOT used as a last
    // resort: it can't allocate votes among the options, so pairing it with
    // zeroes would render every choice at 0% under a non-zero total. Fail
    // loudly instead, and cache nothing, so the caller can offer a retry.
    if (!counts) {
      throw new PollTallyUnavailableError(poll.id);
    }

    // The total is the sum of the poll's REAL options. `choice` is schema-valid
    // for 0-9 whatever the poll's actual option count is, so anyone can write
    // ballots for options that don't exist; summing the real ones ignores those
    // and keeps percentages summing to 100. On a single-choice poll the sum is
    // also the voter count, since `vote` is unique per (poll, voter).
    const total = counts.slice(0, size).reduce((sum, count) => sum + count, 0);

    const tally: PollTally = { counts, total };
    this.tallyCache.set(poll.id, tally);

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
    sdk: Sdk,
    pollId: string,
    docType: string,
    optionCount: number
  ): Promise<number[] | null> {
    try {
      const raw: unknown = await sdk.documents.count({
        dataContractId: POLLR_CONTRACT_ID,
        documentTypeName: docType,
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
  private async countByChoiceIndividually(
    sdk: Sdk,
    pollId: string,
    docType: string,
    optionCount: number
  ): Promise<number[] | null> {
    try {
      const counts = zeroCounts();
      // Only the poll's real options — the remaining slots stay 0.
      for (const choice of choiceRange(optionCount)) {
        counts[choice] = await documentCount(sdk, {
          dataContractId: POLLR_CONTRACT_ID,
          documentTypeName: docType,
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

  /**
   * Fallback 2 (v4): keyset-walk each option's entries and count them.
   *
   * This is the only path independent of the count tree, so it is worth having
   * — but it cannot go through `paginateFetchAll`, whose cursor is the last
   * document's `$id`: an indexOnly type's synthesized ids address nothing and
   * the query is rejected on page two (see `like-service.getPostLikes`, which
   * hit this first). Walk the terminal instead — prefix equality, then
   * `$ownerId > last` with the matching orderBy. Page one must omit both, since
   * a terminal orderBy without a terminal clause is refused.
   */
  private async countByChoiceKeyset(
    sdk: Sdk,
    pollId: string,
    docType: string,
    optionCount: number
  ): Promise<number[] | null> {
    const PAGE = 100;
    try {
      const counts = zeroCounts();
      for (const choice of choiceRange(optionCount)) {
        let lastOwner: string | null = null;
        for (;;) {
          const where: DocumentWhereClause[] = [['pollId', '==', pollId], ['choice', '==', choice]];
          if (lastOwner) where.push(['$ownerId', '>', lastOwner]);
          const response = await sdk.documents.query({
            dataContractId: POLLR_CONTRACT_ID,
            documentTypeName: docType,
            where,
            ...(lastOwner ? { orderBy: [['$ownerId', 'asc'] as DocumentOrderByClause] } : {}),
            limit: PAGE,
          });
          const page = normalizeSDKResponse(response);
          counts[choice] += page.length;
          if (page.length < PAGE) break;
          const owner = page[page.length - 1].$ownerId;
          // Without a cursor the next page would repeat this one forever.
          // Reporting a truncated tally as final would render honest-looking
          // percentages over a number we know is wrong, so fail the whole path.
          if (typeof owner !== 'string') {
            logger.error('PollrVoteService: ballot page carries no $ownerId cursor; tally would truncate', { pollId });
            return null;
          }
          lastOwner = owner;
        }
      }
      return counts;
    } catch (error) {
      logger.error('PollrVoteService: unable to tally votes by keyset walk', error);
      return null;
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
