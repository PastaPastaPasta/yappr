import { describe, expect, it } from 'vitest'
import type { CharterProposal, ElectionContest, ElectionStatus, SeatedTeam } from '@/lib/services/moderation-election-service'
import { LEADER_MINIMUM_CREDITS } from './rules.mjs'
import { applyBlocker, chainOffsetMs, electionStage, statusForContract, joinBlocker, proposalStanding, teamChanges } from './team-flow'

const HOUR = 3_600_000
const T0 = 1_800_000_000_000
const LEADER = 'leader1', OTHER = 'leader2', MEMBER = 'member1'

const proposal = (id = 'p1', leaderId = LEADER): CharterProposal => ({
  id, leaderId, targetContractId: 'target', description: 'We hide spam.', reasonIds: ['r1'], moderatorsShare: 60,
  rewardSplit: { leader: 40, equal: 30, actions: 30 }, createdAt: T0,
})

function status(overrides: Partial<ElectionStatus> = {}): ElectionStatus {
  return {
    declaration: {
      joinWindowSeconds: 3600, voteWindowSeconds: 7200, seatContestable: true, challengeCoolDownSeconds: null, electionDelaySeconds: 3600,
      maxAddedModerators: 2, moderatedDocumentTypes: {}, interim: 'notYetUsable', ownerProtected: false,
    },
    targetContractId: 'target', proposals: [proposal()], contest: null, seated: null, seatedReasons: [], failures: [],
    electionOpensAtMs: T0 + HOUR, chainTimeMs: T0, ...overrides,
  }
}
const contest = (contenders: ElectionContest['contenders'], endsAtMs: number | null, winner: ElectionContest['winner'] = null): ElectionContest =>
  ({ contenders, endsAtMs, winner, abstainVotes: 0, lockVotes: 0 })
const seated: SeatedTeam = { electedCharterId: 'e1', submittedCharterId: 'p1', leaderId: LEADER, members: [MEMBER], electedMembers: [MEMBER] }

describe('election stage', () => {
  it('is not open until creation plus the election delay', () => {
    expect(electionStage(status(), T0)).toEqual({ kind: 'not-open', opensAtMs: T0 + HOUR })
    expect(electionStage(status(), T0 + HOUR)).toEqual({ kind: 'open' })
    expect(electionStage(status({ electionOpensAtMs: null }), T0)).toEqual({ kind: 'open' })
  })

  it('counts down the join window of a sole applicant, who is seated when it closes', () => {
    const one = status({ contest: contest([{ identityId: LEADER, votes: 0, submittedCharterId: 'p1' }], T0 + 2 * HOUR) })
    expect(electionStage(one, T0 + HOUR)).toEqual({ kind: 'joining', joinClosesAtMs: T0 + 2 * HOUR, contenders: 1, votingEndsAtMs: T0 + 4 * HOUR })
    // Past join close a sole applicant is awarded in the next block: nobody votes.
    expect(electionStage(one, T0 + 2 * HOUR)).toEqual({ kind: 'deciding' })
  })

  it('moves to voting once a second applicant entered and the join window closed', () => {
    const two = status({ contest: contest([{ identityId: LEADER, votes: 3 }, { identityId: OTHER, votes: 1 }], T0 + 4 * HOUR) })
    expect(electionStage(two, T0 + HOUR)).toMatchObject({ kind: 'joining', joinClosesAtMs: T0 + 2 * HOUR, contenders: 2 })
    expect(electionStage(two, T0 + 3 * HOUR)).toEqual({ kind: 'voting', votingEndsAtMs: T0 + 4 * HOUR, contenders: 2 })
  })

  it('is deciding once the poll has a winner, seated once the team is read, unknown when a read failed', () => {
    expect(electionStage(status({ contest: contest([{ identityId: LEADER, votes: 0 }], T0, { kind: 'WonByIdentity', identityId: LEADER, decidedAtMs: T0 }) }), T0)).toEqual({ kind: 'deciding' })
    expect(electionStage(status({ seated }), T0)).toEqual({ kind: 'seated' })
    expect(electionStage(status({ failures: ['seatedTeam'] }), T0 + 2 * HOUR)).toEqual({ kind: 'unknown' })
    expect(electionStage(status({ failures: ['contest'] }), T0 + 2 * HOUR)).toEqual({ kind: 'unknown' })
    expect(electionStage(status({ contest: contest([{ identityId: LEADER, votes: 0 }], null) }), T0 + 2 * HOUR)).toEqual({ kind: 'unknown' })
  })
})

describe('the contract a status belongs to', () => {
  it("never lets a late answer for the tab the viewer left stand in for the current contract's", () => {
    const social = status({ targetContractId: 'social-id' })
    expect(statusForContract(social, 'social-id')).toBe(social)
    // Social was still loading when the viewer switched to Blogs; its answer arrives last.
    expect(statusForContract(social, 'blog-id')).toBeNull()
    expect(statusForContract(null, 'blog-id')).toBeNull()
    expect(statusForContract(status({ targetContractId: '' }), '')).toBeNull()
  })
})

describe('chain time', () => {
  it('measures the device clock against the chain time a status was read at', () => {
    expect(chainOffsetMs({ chainTimeMs: T0 }, T0 + 90_000)).toBe(-90_000)
    expect(chainOffsetMs({ chainTimeMs: T0 + 5_000 }, T0)).toBe(5_000)
    expect(chainOffsetMs({ chainTimeMs: null }, T0)).toBe(0)
    expect(chainOffsetMs(null, T0)).toBe(0)
  })
})

describe('proposal standing', () => {
  it('follows the proposal from gathering to contending to seated or not', () => {
    expect(proposalStanding(proposal(), status())).toBe('gathering')
    expect(proposalStanding(proposal(), status({ contest: contest([{ identityId: LEADER, votes: 0, submittedCharterId: 'p1' }], T0) }))).toBe('contending')
    // The same leader's other proposal is not the one in the contest.
    expect(proposalStanding(proposal('p2'), status({ contest: contest([{ identityId: LEADER, votes: 0, submittedCharterId: 'p1' }], T0) }))).toBe('gathering')
    expect(proposalStanding(proposal(), status({ seated }))).toBe('seated')
    expect(proposalStanding(proposal('p3', OTHER), status({ seated }))).toBe('not-seated')
  })
})

describe('apply', () => {
  const base = (overrides: Partial<Parameters<typeof applyBlocker>[0]> = {}) => {
    const s = overrides.status ?? status()
    return applyBlocker({
      stage: electionStage(s, T0 + HOUR), proposal: proposal(), viewerId: LEADER, status: s,
      members: [MEMBER], requested: new Set([MEMBER]), balance: LEADER_MINIMUM_CREDITS, minimumBalance: LEADER_MINIMUM_CREDITS, ...overrides,
    })
  }

  it('lets the leader apply once open, with members who asked and the 0.51 DASH reserve', () => {
    expect(base()).toBeNull()
    expect(base({ members: [] })).toBeNull()
  })

  it('says why not', () => {
    expect(base({ viewerId: null })).toBe('signed-out')
    expect(base({ viewerId: MEMBER })).toBe('not-leader')
    expect(base({ stage: { kind: 'not-open', opensAtMs: T0 + HOUR } })).toBe('not-open')
    expect(base({ stage: { kind: 'voting', votingEndsAtMs: null, contenders: 2 } })).toBe('closed')
    expect(base({ stage: { kind: 'seated' } })).toBe('seated')
    expect(base({ stage: { kind: 'unknown' } })).toBe('unknown')
    expect(base({ members: Array.from({ length: 16 }, (_, i) => `m${i}`), requested: new Set(Array.from({ length: 16 }, (_, i) => `m${i}`)) })).toBe('too-many-members')
    expect(base({ members: ['stranger'] })).toBe('unknown-members')
    expect(base({ members: [LEADER], requested: new Set([LEADER]) })).toBe('unknown-members')
    expect(base({ balance: LEADER_MINIMUM_CREDITS - 1n })).toBe('low-balance')
  })

  it('never takes an unread join-request list for an empty team, even for a solo application', () => {
    expect(base({ requested: null })).toBe('requests-unread')
    expect(base({ requested: null, members: [] })).toBe('requests-unread')
  })

  it('refuses a second application by the same leader, whichever proposal it ran on', () => {
    const s = status({ contest: contest([{ identityId: LEADER, votes: 0, submittedCharterId: 'p9' }], T0 + 2 * HOUR) })
    expect(base({ status: s, stage: electionStage(s, T0 + HOUR) })).toBe('already-applied')
  })
})

describe('join', () => {
  it('lets anyone but the leader ask once, unless another team holds the seat', () => {
    const input = { proposal: proposal(), viewerId: MEMBER, alreadyAsked: false, standing: 'gathering' as const }
    expect(joinBlocker(input)).toBeNull()
    expect(joinBlocker({ ...input, standing: 'seated' })).toBeNull()
    expect(joinBlocker({ ...input, viewerId: null })).toBe('signed-out')
    expect(joinBlocker({ ...input, viewerId: LEADER })).toBe('leader')
    expect(joinBlocker({ ...input, alreadyAsked: true })).toBe('already-asked')
    expect(joinBlocker({ ...input, standing: 'not-seated' })).toBe('not-seated')
  })
})

describe('team changes after seating', () => {
  it('offers removals, restores and additions up to the cap', () => {
    const changes = teamChanges({ seated: { ...seated, electedMembers: ['m1', 'm2'] }, electedMembers: ['m1', 'm2'], additions: ['a1'], removals: ['m2'],
      requested: ['m1', 'm2', 'a1', 'n1', LEADER], maxAddedModerators: 2 })
    expect(changes).toEqual({ addable: ['n1'], removable: ['m1'], restorable: ['m2'], added: ['a1'], canAdd: true })
    expect(teamChanges({ seated, electedMembers: [MEMBER], additions: ['a1', 'a2'], removals: [], requested: [], maxAddedModerators: 2 }).canAdd).toBe(false)
    expect(teamChanges({ seated, electedMembers: [MEMBER], additions: [], removals: [], requested: [], maxAddedModerators: 0 }).canAdd).toBe(false)
  })
})
