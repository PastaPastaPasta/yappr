import { logger } from '@/lib/logger';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { YAPPR_CONTRACT_ID } from '@/lib/constants';
import { electedModeration, type ElectedModerationDeclaration } from '@/lib/contract-topology';
import { getEvoSdk } from './evo-sdk-service';
import { documentToPlainObject, identifierToBase58 } from './sdk-helpers';

/**
 * The election of the social contract's moderation team (v9 declares elected
 * moderation; docs/SOCIAL_V9.md). Read-only: filing charters, joining and
 * voting are the election script's and the masternodes' business.
 *
 * Everything lives in the moderation charters system contract
 * (`EG7RGfV8…`, `sdk.moderationCharters`):
 *
 * - `submittedCharter` — a leader's proposal for a target contract: the
 *   `reason` documents its team's actions may cite, its reward split;
 * - `electedCharter` — a proposal put to the vote; its create opens or joins
 *   the contest on the contested unique index `byTargetContract` (keyed by the
 *   target contract id), whose winner is the ONLY `electedCharter` ever
 *   stored for the target: the seated charter;
 * - `reason` — the grounds a seated team must cite (41203 otherwise).
 *
 * The contest itself is a masternode vote poll read with
 * `sdk.voting.contestedResourceVoteState`, whose `indexValues` must be the
 * target id as a base58 STRING (an Identifier object is refused by the node).
 */

/** The moderation charters system contract (SystemDataContract::ModerationCharters). */
export const MODERATION_CHARTERS_CONTRACT_ID = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88';
const ELECTED_CHARTER = 'electedCharter';
const CONTEST_INDEX = 'byTargetContract';

/** A `reason` a seated team may cite: the proposal lists them by document id. */
export interface CharterReason {
  id: string;
  code: string;
  label: string;
  description?: string;
}

/** A proposal (`submittedCharter`) for the contract. */
export interface CharterProposal {
  id: string;
  leaderId: string;
  description: string;
  reasonIds: string[];
  /** Percent of each declared moderators fee the team charges; null = the full amount. */
  moderatorsShare: number | null;
  rewardSplit: { leader: number; equal: number; actions: number } | null;
  createdAt: number | null;
}

/** One contender in the contest for the seat: an `electedCharter` and its tally. */
export interface ElectionContender {
  /** The contender's identity: the charter's leader. */
  identityId: string;
  votes: number | null;
}

/** The contest for the contract's moderation seat, as the vote poll reports it now. */
export interface ElectionContest {
  contenders: ElectionContender[];
  abstainVotes: number | null;
  lockVotes: number | null;
  /** Set once the poll is decided: the winning leader, or a non-identity outcome ("locked", "noWinner"). */
  winner: { kind: string; identityId: string | null; decidedAtMs: number | null } | null;
  /** When voting ends, when the poll is scheduled (end-date index); null when not found. */
  endsAtMs: number | null;
}

/** The team seated on the contract. */
export interface SeatedTeam {
  electedCharterId: string;
  submittedCharterId: string;
  leaderId: string;
  members: string[];
}

export interface ElectionStatus {
  declaration: ElectedModerationDeclaration;
  targetContractId: string;
  proposals: CharterProposal[];
  contest: ElectionContest | null;
  seated: SeatedTeam | null;
  /** The reasons the seated team may cite (empty while no team is seated). */
  seatedReasons: CharterReason[];
}

// ---- pure mappers (unit-tested) ------------------------------------------------

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((id) => identifierToBase58(id)).filter((id): id is string => !!id) : [];

/** A `submittedCharter` document (plain object) as the app models it. */
export function toProposal(doc: Record<string, unknown>): CharterProposal {
  const split = doc.rewardSplit as Record<string, unknown> | undefined;
  const leader = asNumber(split?.leader);
  const equal = asNumber(split?.equal);
  const actions = asNumber(split?.actions);
  return {
    id: identifierToBase58(doc.$id ?? doc.id) ?? '',
    leaderId: identifierToBase58(doc.$ownerId ?? doc.ownerId) ?? '',
    description: typeof doc.description === 'string' ? doc.description : '',
    reasonIds: idList(doc.reasons),
    moderatorsShare: asNumber(doc.moderatorsShare),
    rewardSplit: leader !== null && equal !== null && actions !== null ? { leader, equal, actions } : null,
    createdAt: asNumber(doc.$createdAt ?? doc.createdAt),
  };
}

/** A `reason` document (plain object) as the app models it. */
export function toReason(doc: Record<string, unknown>): CharterReason {
  return {
    id: identifierToBase58(doc.$id ?? doc.id) ?? '',
    code: typeof doc.code === 'string' ? doc.code : '',
    label: typeof doc.label === 'string' ? doc.label : '',
    ...(typeof doc.description === 'string' ? { description: doc.description } : {}),
  };
}

/** The vote poll that holds a contract's seat contest. */
export function contestVotePoll(targetContractId: string) {
  return {
    dataContractId: MODERATION_CHARTERS_CONTRACT_ID,
    documentTypeName: ELECTED_CHARTER,
    indexName: CONTEST_INDEX,
    // A base58 STRING: an Identifier object is refused by the node.
    indexValues: [targetContractId],
  };
}

/**
 * When the contest for `targetContractId` ends, from a `votePollsByEndDate`
 * page: the end time of the entry whose poll is this contract's seat, or null.
 */
export function contestEndFromPolls(
  entries: ReadonlyArray<{ timestampMs: bigint | number; votePolls: ReadonlyArray<unknown> }>,
  targetContractId: string
): number | null {
  for (const entry of entries) {
    for (const poll of entry.votePolls) {
      const p = poll as { contractId?: unknown; documentTypeName?: string; indexName?: string; indexValues?: unknown[] };
      const contract = identifierToBase58(p.contractId);
      const value = p.indexValues?.[0];
      const indexed = typeof value === 'string' ? value : identifierToBase58(value);
      if (contract === MODERATION_CHARTERS_CONTRACT_ID && p.documentTypeName === ELECTED_CHARTER
        && p.indexName === CONTEST_INDEX && indexed === targetContractId) {
        return Number(entry.timestampMs);
      }
    }
  }
  return null;
}

// ---- reads ---------------------------------------------------------------------

type VoteState = Awaited<ReturnType<EvoSDK['voting']['contestedResourceVoteState']>>;

function toContest(state: VoteState, endsAtMs: number | null): ElectionContest {
  try {
    const contenders: ElectionContender[] = (state.contenders ?? []).map((contender: {
      identityId?: unknown; voteTally?: number | undefined; free?: () => void
    }) => {
      const mapped = { identityId: identifierToBase58(contender.identityId) ?? '', votes: contender.voteTally ?? null };
      contender.free?.();
      return mapped;
    });
    const winner = state.winner;
    const decided = winner
      ? { kind: winner.kind, identityId: identifierToBase58(winner.identityId) ?? null, decidedAtMs: winner.block ? Number(winner.block.timeMs) : null }
      : null;
    winner?.free();
    return {
      contenders: contenders.sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0)),
      abstainVotes: state.abstainVoteTally ?? null,
      lockVotes: state.lockVoteTally ?? null,
      winner: decided,
      endsAtMs,
    };
  } finally {
    state.free();
  }
}

class ModerationElectionService {
  /** The seated team, or null when no charter is seated (or the read failed). */
  async getSeatedTeam(targetContractId = YAPPR_CONTRACT_ID): Promise<SeatedTeam | null> {
    const sdk = await getEvoSdk();
    const team = await sdk.moderationCharters.team(targetContractId);
    if (!team) return null;
    try {
      return {
        electedCharterId: team.electedCharterId.toBase58(),
        submittedCharterId: team.submittedCharterId.toBase58(),
        leaderId: team.leaderId.toBase58(),
        members: team.members.map((id) => id.toBase58()),
      };
    } finally {
      team.free();
    }
  }

  /** Every proposal filed for the contract, in filing order (paged, at most `max`). */
  async getProposals(targetContractId = YAPPR_CONTRACT_ID, max = 200): Promise<CharterProposal[]> {
    const sdk = await getEvoSdk();
    const proposals: CharterProposal[] = [];
    let startAfter: string | undefined;
    while (proposals.length < max) {
      const page = await sdk.moderationCharters.submittedCharters({ targetContractId, limit: 100, ...(startAfter ? { startAfter } : {}) });
      const docs = Array.from(page.values()).filter((doc) => !!doc);
      for (const doc of docs) proposals.push(toProposal(documentToPlainObject(doc)));
      if (docs.length < 100) break;
      startAfter = proposals[proposals.length - 1]?.id;
      if (!startAfter) break;
    }
    return proposals;
  }

  /** The `reason` documents a proposal lists, in the proposal's order (missing ones skipped). */
  async getReasons(reasonIds: readonly string[]): Promise<CharterReason[]> {
    if (reasonIds.length === 0) return [];
    const sdk = await getEvoSdk();
    const docs = await Promise.all(reasonIds.map((id) =>
      sdk.documents.get(MODERATION_CHARTERS_CONTRACT_ID, 'reason', id).catch((error: unknown) => {
        logger.warn('moderationElection: reason read failed', id, error);
        return undefined;
      })));
    return docs.filter((doc) => !!doc).map((doc) => toReason(documentToPlainObject(doc)));
  }

  /**
   * The reasons the SEATED team's proposal lists: what every ban, suspension,
   * warning and deletion the team signs must cite (41203). Empty when no team
   * is seated (the interim is not bound) or the proposal cannot be read.
   */
  async getSeatedReasons(targetContractId = YAPPR_CONTRACT_ID): Promise<CharterReason[]> {
    const seated = await this.getSeatedTeam(targetContractId);
    if (!seated) return [];
    const sdk = await getEvoSdk();
    const proposal = await sdk.moderationCharters.submittedCharter(seated.submittedCharterId);
    if (!proposal) return [];
    return this.getReasons(toProposal(documentToPlainObject(proposal)).reasonIds);
  }

  /** The contest for the seat now, or null when no charter has entered one yet. */
  async getContest(targetContractId = YAPPR_CONTRACT_ID): Promise<ElectionContest | null> {
    const sdk = await getEvoSdk();
    let state: VoteState;
    try {
      state = await sdk.voting.contestedResourceVoteState({
        ...contestVotePoll(targetContractId),
        resultType: 'documentsAndVoteTally',
        includeLockedAndAbstaining: true,
        limit: 100,
      });
    } catch (error) {
      logger.warn('moderationElection: vote state read failed (no contest yet?)', error);
      return null;
    }
    const endsAtMs = await this.contestEnd(sdk, targetContractId);
    const contest = toContest(state, endsAtMs);
    return contest.contenders.length === 0 && !contest.winner ? null : contest;
  }

  /** The contest's end, from the vote-poll end-date index (the next 100 polls to end). */
  private async contestEnd(sdk: EvoSDK, targetContractId: string): Promise<number | null> {
    try {
      const entries = await sdk.voting.votePollsByEndDate({ startTimeMs: Date.now() - 86_400_000, orderAscending: true, limit: 100 });
      try {
        return contestEndFromPolls(entries.map((entry) => ({ timestampMs: entry.timestampMs, votePolls: entry.votePolls.map((poll: { toJSON?: () => unknown }) => poll.toJSON?.() ?? poll) })), targetContractId);
      } finally {
        for (const entry of entries) entry.free();
      }
    } catch (error) {
      logger.warn('moderationElection: vote poll end-date read failed', error);
      return null;
    }
  }

  /** Everything the election status view shows, or null when the contract is not elected. */
  async getStatus(targetContractId = YAPPR_CONTRACT_ID): Promise<ElectionStatus | null> {
    const declaration = electedModeration();
    if (!declaration) return null;
    const [proposals, contest, seated] = await Promise.all([
      this.getProposals(targetContractId).catch((error: unknown) => { logger.warn('moderationElection: proposals read failed', error); return []; }),
      this.getContest(targetContractId),
      this.getSeatedTeam(targetContractId).catch((error: unknown) => { logger.warn('moderationElection: team read failed', error); return null; }),
    ]);
    const seatedProposal = seated ? proposals.find((p) => p.id === seated.submittedCharterId) : undefined;
    const seatedReasons = seatedProposal ? await this.getReasons(seatedProposal.reasonIds) : seated ? await this.getSeatedReasons(targetContractId) : [];
    return { declaration, targetContractId, proposals, contest, seated, seatedReasons };
  }
}

export const moderationElectionService = new ModerationElectionService();
