/**
 * The Moderation teams page's state machine, pure (unit-tested): where a
 * contract's election stands, where a proposal stands in it, and what the
 * viewer can do next (start, join, apply, change the team), each "can't" with
 * the reason the page says.
 *
 * Every time is chain time as the status read it, carried forward by the
 * page's clock (`nowMs`). The election clock rules are the release CLI's
 * (rules.mjs): applications open at creation + `electionDelay`, a sole
 * applicant is seated when its join window closes, and a second applicant
 * moves the end out by the vote window.
 */
import type { CharterProposal, ElectionStatus, SeatedTeam } from '@/lib/services/moderation-election-service'
import { CHARTER_LIMITS, contestPhase, joinClosesAtMs } from './rules.mjs'

export type ElectionStage =
  /** The election delay has not passed: proposals and join requests only. */
  | { kind: 'not-open'; opensAtMs: number }
  /** Nobody has applied: the first application opens the contest. */
  | { kind: 'open' }
  /** Applications are open until `joinClosesAtMs`. With one applicant it seats then. */
  | { kind: 'joining'; joinClosesAtMs: number; contenders: number; votingEndsAtMs: number }
  /** The join window closed with two or more applicants: masternodes vote. */
  | { kind: 'voting'; votingEndsAtMs: number | null; contenders: number }
  /** The contest is over and the winner is about to be (or was just) seated. */
  | { kind: 'deciding' }
  | { kind: 'seated' }
  /** A read failed, so nothing is claimed. */
  | { kind: 'unknown' }

/**
 * `status` when it is the election of `contractId`, else null: an answer read
 * for another contract (a tab the viewer left) never stands in for this one,
 * so nothing can be filed against the wrong target.
 */
export function statusForContract(status: ElectionStatus | null, contractId: string): ElectionStatus | null {
  return status !== null && contractId !== '' && status.targetContractId === contractId ? status : null
}

/** How far chain time is from this device's clock, from a status just read (0 when it carried no chain time). */
export function chainOffsetMs(status: Pick<ElectionStatus, 'chainTimeMs'> | null, readAtMs = Date.now()): number {
  return status?.chainTimeMs != null ? status.chainTimeMs - readAtMs : 0
}

export function electionStage(status: ElectionStatus, nowMs: number): ElectionStage {
  if (status.seated) return { kind: 'seated' }
  const failed = new Set(status.failures)
  if (failed.has('seatedTeam')) return { kind: 'unknown' }
  const contest = status.contest
  if (contest?.winner) return { kind: 'deciding' }
  const contenders = contest?.contenders.length ?? 0
  if (contest && contenders > 0) {
    const voteMs = status.declaration.voteWindowSeconds * 1000
    const closes = joinClosesAtMs(contest.endsAtMs, contenders, status.declaration.voteWindowSeconds)
    const phase = contestPhase({ seated: false, decided: false, contenders, joinClosesAtMs: closes, chainTimeMs: nowMs })
    if (phase === 'joining' && closes !== null) return { kind: 'joining', joinClosesAtMs: closes, contenders, votingEndsAtMs: closes + voteMs }
    // A sole applicant past join close is seated in the next block: nobody votes.
    if (phase === 'voting') return contenders === 1 ? { kind: 'deciding' } : { kind: 'voting', votingEndsAtMs: contest.endsAtMs, contenders }
    return { kind: 'unknown' }
  }
  if (failed.has('contest')) return { kind: 'unknown' }
  if (status.electionOpensAtMs !== null && nowMs < status.electionOpensAtMs) return { kind: 'not-open', opensAtMs: status.electionOpensAtMs }
  return { kind: 'open' }
}

export type ProposalStanding =
  /** Filed, gathering members; its leader has not applied. */
  | 'gathering'
  /** Its leader has applied: it is in the contest. */
  | 'contending'
  | 'seated'
  /** Another team holds the seat. */
  | 'not-seated'

export function proposalStanding(proposal: CharterProposal, status: ElectionStatus): ProposalStanding {
  if (status.seated) return status.seated.submittedCharterId === proposal.id ? 'seated' : 'not-seated'
  // A leader contends once per contest; its application names the proposal it runs on
  // (when the contender's document could be read).
  return status.contest?.contenders.some((contender) => contender.identityId === proposal.leaderId
    && (contender.submittedCharterId === undefined || contender.submittedCharterId === proposal.id)) ? 'contending' : 'gathering'
}

export type ApplyBlocker =
  | 'signed-out'
  | 'not-leader'
  | 'seated'
  | 'not-open'
  | 'closed'
  | 'already-applied'
  | 'too-many-members'
  | 'unknown-members'
  | 'low-balance'
  | 'unknown'
  | 'requests-unread'
  | 'balance-unknown'
  | 'balance-loading'

/**
 * Why the viewer cannot file the application for `proposal` with `members`
 * now, or null when they can. `requested` holds the identities with a join
 * request for the proposal, null while they are not all read (an unread list
 * is never taken for an empty team); `balance` is the leader's (null while unknown).
 */
export function applyBlocker(input: {
  stage: ElectionStage
  proposal: CharterProposal
  viewerId: string | null
  status: ElectionStatus
  members: readonly string[]
  requested: ReadonlySet<string> | null
  /** Undefined while still being read, null when the read failed. */
  balance: bigint | null | undefined
  minimumBalance: bigint
}): ApplyBlocker | null {
  const { stage, proposal, viewerId, status, members, requested, balance, minimumBalance } = input
  if (!viewerId) return 'signed-out'
  if (viewerId !== proposal.leaderId) return 'not-leader'
  if (stage.kind === 'seated' || stage.kind === 'deciding') return 'seated'
  if (stage.kind === 'unknown') return 'unknown'
  if (stage.kind === 'not-open') return 'not-open'
  if (stage.kind === 'voting') return 'closed'
  // An identity contends once per contest, whichever of its proposals it ran on.
  if (status.contest?.contenders.some((contender) => contender.identityId === viewerId)) return 'already-applied'
  if (members.length > CHARTER_LIMITS.members) return 'too-many-members'
  if (!requested) return 'requests-unread'
  if (members.some((member) => !requested.has(member) || member === proposal.leaderId)) return 'unknown-members'
  if (balance === undefined) return 'balance-loading'
  if (balance === null) return 'balance-unknown'
  if (balance < minimumBalance) return 'low-balance'
  return null
}

export type JoinBlocker = 'signed-out' | 'leader' | 'already-asked' | 'not-seated'

/** Why the viewer cannot ask to join `proposal`, or null when they can. */
export function joinBlocker(input: {
  proposal: CharterProposal
  viewerId: string | null
  alreadyAsked: boolean
  standing: ProposalStanding
}): JoinBlocker | null {
  if (!input.viewerId) return 'signed-out'
  if (input.viewerId === input.proposal.leaderId) return 'leader'
  if (input.alreadyAsked) return 'already-asked'
  // A seated team's leader can still add members from its join requests; a team that lost cannot.
  if (input.standing === 'not-seated') return 'not-seated'
  return null
}

/** The seated team's membership as its leader can change it. */
export interface TeamChanges {
  /** Asked to join, not on the team: the leader can add them (while `canAdd`). */
  addable: string[]
  /** Elected members still on the team: the leader can take them off. */
  removable: string[]
  /** Elected members the leader took off: deleting the removal puts them back. */
  restorable: string[]
  /** Members the leader added: deleting the addition takes them off. */
  added: string[]
  /** Whether another addition fits under the contract's `maxAddedModerators`. */
  canAdd: boolean
}

export function teamChanges(input: {
  seated: SeatedTeam
  /** The elected charter's `members` (removed ones included). */
  electedMembers: readonly string[]
  additions: readonly string[]
  removals: readonly string[]
  requested: readonly string[]
  maxAddedModerators: number
}): TeamChanges {
  const { seated, electedMembers, additions, removals, requested, maxAddedModerators } = input
  const removed = new Set(removals)
  const onTeam = new Set([seated.leaderId, ...electedMembers, ...additions])
  return {
    addable: requested.filter((id) => !onTeam.has(id)),
    removable: electedMembers.filter((id) => !removed.has(id)),
    restorable: electedMembers.filter((id) => removed.has(id)),
    added: [...additions],
    canAdd: additions.length < maxAddedModerators,
  }
}
