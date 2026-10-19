import { describe, expect, it } from 'vitest'
import { electionResult } from './election-result'
import type { ElectionContest, SeatedTeam } from './services/moderation-election-service'

const time = Date.UTC(2026, 9, 18, 18, 54, 21, 780)
const format = (ms: number) => new Date(ms).toISOString()
const team: SeatedTeam = { leaderId: 'leader', members: [], electedCharterId: 'charter', submittedCharterId: 'proposal' }
const contest = (kind: string | null, decidedAtMs: number | null = time): ElectionContest => ({
  contenders: [], abstainVotes: 0, lockVotes: 0, endsAtMs: null,
  winner: kind ? { kind, identityId: kind === 'WonByIdentity' ? 'leader' : null, decidedAtMs } : null,
})

describe('election result copy', () => {
  it('shows a seated winner with the actual decision time even without a scheduled end', () => {
    expect(electionResult(contest('WonByIdentity'), team, format)).toBe('Elected — this team was seated on 2026-10-18T18:54:21.780Z.')
  })
  it('does not claim seating when the elected team has not been read or differs', () => {
    expect(electionResult(contest('WonByIdentity'), null, format)).toBe('Team elected on 2026-10-18T18:54:21.780Z.')
    expect(electionResult(contest('WonByIdentity'), { ...team, leaderId: 'other' }, format)).not.toContain('seated')
  })
  it.each(['Locked', 'locked'])('explains a %s election', kind => {
    expect(electionResult(contest(kind), null, format)).toBe('Election locked — no team was elected on 2026-10-18T18:54:21.780Z.')
  })
  it('explains no winner without exposing an enum', () => {
    expect(electionResult(contest('NoWinner'), null, format)).toBe('Voting ended on 2026-10-18T18:54:21.780Z — no team was elected.')
  })
  it('keeps an unfamiliar completed outcome in plain language', () => {
    expect(electionResult(contest('FutureOutcome'), null, format)).toBe('Voting ended on 2026-10-18T18:54:21.780Z.')
  })
  it.each([null, NaN, Infinity, 0])('does not invent a seating date for %s', time => {
    expect(electionResult(contest('WonByIdentity', time), team, format)).toBe('Elected — this team was seated.')
  })
  it('shows voting with its scheduled end, and omits an unavailable end', () => {
    expect(electionResult({ ...contest(null), endsAtMs: time }, null, format)).toBe('Voting in progress — ends 2026-10-18T18:54:21.780Z.')
    expect(electionResult(contest(null), null, format)).toBe('Voting in progress.')
  })
})
