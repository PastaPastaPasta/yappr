import { describe, expect, it } from 'vitest'
import {
  POLL_DURATIONS,
  POLL_MAX_DURATION_MS,
  applyChoiceDelta,
  canDeletePoll,
  charCount,
  choiceDelta,
  editorStart,
  isChoiceIndex,
  normalizeChoices,
  pollEndsAt,
  pollEndsAtError,
  pollLimits,
  pollOptionsError,
  pollQuestionError,
  planBallotWrites,
  recordedChoices,
  sameChoices,
  sumCounts,
  trimPollOptions,
  type Ballot,
} from './pollr-rules'

const v5 = pollLimits('v5')
const v3 = pollLimits('v3')
const ballot = (slot: number, choice: number | null, revision = 1): Ballot => ({ id: `b${slot}`, revision, slot, choice })

describe('poll limits', () => {
  it('counts characters as code points, the way the contract does', () => {
    expect('👍'.length).toBe(2)
    expect(charCount('👍')).toBe(1)
  })

  it('v5 caps the question at 280 characters and 560 bytes', () => {
    expect(pollQuestionError('q'.repeat(280), v5)).toBeNull()
    expect(pollQuestionError('q'.repeat(281), v5)).toMatch(/280/)
    // 200 three-byte characters: within 280 characters, over 560 bytes.
    expect(pollQuestionError('€'.repeat(200), v5)).toMatch(/560 bytes/)
    expect(pollQuestionError('', v5)).toMatch(/required/)
    // v3/v4 allow 512 characters and have no byte cap.
    expect(pollQuestionError('€'.repeat(500), v3)).toBeNull()
  })

  it('v5 caps each option at 80 characters and 160 bytes', () => {
    expect(pollOptionsError(['a'.repeat(80), 'b'], v5)).toBeNull()
    expect(pollOptionsError(['a'.repeat(81), 'b'], v5)).toMatch(/80/)
    expect(pollOptionsError(['👍'.repeat(41), 'b'], v5)).toMatch(/160 bytes/)
    expect(pollOptionsError(['a'.repeat(100), 'b'], v3)).toBeNull()
  })

  it('needs 2-10 options, and on v5 distinct ones', () => {
    expect(pollOptionsError(['a'], v5)).toMatch(/between 2 and 10/)
    expect(pollOptionsError(Array.from({ length: 11 }, (_, i) => `o${i}`), v5)).toMatch(/between 2 and 10/)
    expect(pollOptionsError(['Yes', 'No', 'Yes'], v5)).toMatch(/different/)
    // The contract compares exact strings; v3 has no uniqueness rule at all.
    expect(pollOptionsError(['Yes', 'yes'], v5)).toBeNull()
    expect(pollOptionsError(['Yes', 'Yes'], v3)).toBeNull()
  })

  it('v5 requires a close time in the future, at most 31 days out', () => {
    const now = 1_000_000
    expect(pollEndsAtError(undefined, v5, now)).toMatch(/close time/)
    expect(pollEndsAtError(now, v5, now)).toMatch(/future/)
    expect(pollEndsAtError(now + POLL_MAX_DURATION_MS, v5, now)).toBeNull()
    expect(pollEndsAtError(now + POLL_MAX_DURATION_MS + 1, v5, now)).toMatch(/31 days/)
    // v3's close time is optional and unbounded.
    expect(pollEndsAtError(undefined, v3, now)).toBeNull()
    expect(pollEndsAtError(now + 2 * POLL_MAX_DURATION_MS, v3, now)).toBeNull()
  })

  it('offers only durations the 31-day rule accepts, defaulting to the first', () => {
    for (const { value } of POLL_DURATIONS) {
      expect(pollEndsAtError(pollEndsAt(value, 0), v5, 0)).toBeNull()
    }
    expect(pollEndsAt('7d', 0)).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('ballot plan, single choice', () => {
  it('creates the one ballot (slot 0) for a first vote', () => {
    expect(planBallotWrites(false, [], [2])).toEqual([{ kind: 'create', slot: 0, choice: 2 }])
  })

  it('replaces the choice to change the vote, and drops it to withdraw', () => {
    const mine = ballot(0, 1, 3)
    expect(planBallotWrites(false, [mine], [2])).toEqual([{ kind: 'replace', ballot: mine, choice: 2 }])
    expect(planBallotWrites(false, [mine], [])).toEqual([{ kind: 'replace', ballot: mine, choice: null }])
  })

  it('re-picks on a withdrawn ballot by replacing it, never creating a second', () => {
    const withdrawn = ballot(0, null, 2)
    expect(planBallotWrites(false, [withdrawn], [0])).toEqual([{ kind: 'replace', ballot: withdrawn, choice: 0 }])
  })

  it('writes nothing when the selection is unchanged', () => {
    expect(planBallotWrites(false, [ballot(0, 1)], [1])).toEqual([])
    expect(planBallotWrites(false, [ballot(0, null)], [])).toEqual([])
    expect(planBallotWrites(false, [], [])).toEqual([])
  })
})

describe('ballot plan, multi choice', () => {
  it('creates one ballot per newly ticked option, slot = option', () => {
    expect(planBallotWrites(true, [], [0, 2])).toEqual([
      { kind: 'create', slot: 0, choice: 0 },
      { kind: 'create', slot: 2, choice: 2 },
    ])
  })

  it('unticks by dropping the choice and re-ticks by replacing it back', () => {
    const zero = ballot(0, 0)
    const two = ballot(2, null)
    expect(planBallotWrites(true, [zero, two], [2])).toEqual([
      { kind: 'replace', ballot: zero, choice: null },
      { kind: 'replace', ballot: two, choice: 2 },
    ])
  })

  it('leaves untouched options alone and mixes creates with replaces', () => {
    const zero = ballot(0, 0)
    expect(planBallotWrites(true, [zero], [0, 1])).toEqual([{ kind: 'create', slot: 1, choice: 1 }])
    expect(planBallotWrites(true, [zero], [])).toEqual([{ kind: 'replace', ballot: zero, choice: null }])
  })
})

describe('editor start after an interrupted vote', () => {
  it('starts from the recorded choices when nothing was left unsent', () => {
    expect(editorStart([2, 0], null)).toEqual({ selected: [0, 2], unsent: [] })
  })

  it('starts from the last request and marks what the chain does not show', () => {
    // [0, 1, 2] was asked for: 0 confirmed, 1 landed after a timeout, 2 was never sent.
    expect(editorStart([0, 1], [0, 1, 2])).toEqual({ selected: [0, 1, 2], unsent: [2] })
    // An untick that never went out counts as unsent too.
    expect(editorStart([0, 1], [0])).toEqual({ selected: [0], unsent: [1] })
    // Everything landed: nothing to mark.
    expect(editorStart([0, 1, 2], [2, 1, 0])).toEqual({ selected: [0, 1, 2], unsent: [] })
  })
})

describe('choices and tallies', () => {
  it('reads the recorded choices off ballots, skipping withdrawn ones', () => {
    expect(recordedChoices([ballot(2, 2), ballot(0, null), ballot(1, 1)])).toEqual([1, 2])
  })

  it('trims options, checks choice indexes and sums counts', () => {
    expect(trimPollOptions([' a ', '', '  ', 'b'])).toEqual(['a', 'b'])
    expect([isChoiceIndex(9), isChoiceIndex(10), isChoiceIndex(2, 2), isChoiceIndex(-1)]).toEqual([true, false, false, false])
    expect(sumCounts([1, 2, 3])).toBe(6)
  })

  it('normalizes, compares and diffs selections', () => {
    expect(normalizeChoices([3, 1, 1, 12, -1, 1.5], 4)).toEqual([1, 3])
    expect(sameChoices([2, 0], [0, 2])).toBe(true)
    expect(sameChoices([0], [0, 2])).toBe(false)
    expect(choiceDelta([0, 2], [1, 2])).toEqual({ added: [1], removed: [0] })
  })

  it('moves a vote between options and withdraws one without going below zero', () => {
    expect(applyChoiceDelta([3, 1, 0], [1], [0])).toEqual({ counts: [2, 2, 0], total: 4 })
    expect(applyChoiceDelta([0, 1, 0], [], [0, 1])).toEqual({ counts: [0, 0, 0], total: 0 })
    // Out-of-range choices are ignored.
    expect(applyChoiceDelta([1, 1], [5], [])).toEqual({ counts: [1, 1], total: 2 })
  })
})

describe('v6', () => {
  it('keeps v5’s poll limits', () => {
    expect(pollLimits('v6')).toEqual(v5)
  })

  it('lets only the owner delete a poll, and only while no ballot names it', () => {
    expect(canDeletePoll('v6', true, 0)).toBe(true)
    // A withdrawn ballot still counts: one ballot of any kind keeps the poll.
    expect(canDeletePoll('v6', true, 1)).toBe(false)
    expect(canDeletePoll('v6', false, 0)).toBe(false)
    // An unknown count offers nothing.
    expect(canDeletePoll('v6', true, null)).toBe(false)
    // Before v6 a poll is permanent.
    expect(canDeletePoll('v5', true, 0)).toBe(false)
    expect(canDeletePoll('v3', true, 0)).toBe(false)
  })
})
