import { describe, expect, it } from 'vitest'
import {
  POLL_DURATIONS,
  POLL_MAX_DURATION_MS,
  applyChoiceDelta,
  charCount,
  choiceDelta,
  decodeChoiceKey,
  editorStart,
  isChoiceIndex,
  normalizeChoices,
  pollEndsAt,
  pollEndsAtError,
  pollLimits,
  pollOptionsError,
  pollQuestionError,
  planBallotWrite,
  sameChoices,
  sumCounts,
  trimPollOptions,
  type Ballot,
} from './pollr-rules'

const v7 = pollLimits('v7')
const v3 = pollLimits('v3')
const ballot = (choices: number[], revision = 1): Ballot => ({ id: 'b', revision, choices })

describe('poll limits', () => {
  it('counts characters as code points, the way the contract does', () => {
    expect('👍'.length).toBe(2)
    expect(charCount('👍')).toBe(1)
  })

  it('v7 caps the question at 280 characters and 560 bytes', () => {
    expect(pollQuestionError('q'.repeat(280), v7)).toBeNull()
    expect(pollQuestionError('q'.repeat(281), v7)).toMatch(/280/)
    // 200 three-byte characters: within 280 characters, over 560 bytes.
    expect(pollQuestionError('€'.repeat(200), v7)).toMatch(/560 bytes/)
    expect(pollQuestionError('', v7)).toMatch(/required/)
    // v3/v4 allow 512 characters and have no byte cap.
    expect(pollQuestionError('€'.repeat(500), v3)).toBeNull()
  })

  it('v7 caps each option at 80 characters and 160 bytes', () => {
    expect(pollOptionsError(['a'.repeat(80), 'b'], v7)).toBeNull()
    expect(pollOptionsError(['a'.repeat(81), 'b'], v7)).toMatch(/80/)
    expect(pollOptionsError(['👍'.repeat(41), 'b'], v7)).toMatch(/160 bytes/)
    expect(pollOptionsError(['a'.repeat(100), 'b'], v3)).toBeNull()
  })

  it('needs 2-10 options, and on v7 distinct ones', () => {
    expect(pollOptionsError(['a'], v7)).toMatch(/between 2 and 10/)
    expect(pollOptionsError(Array.from({ length: 11 }, (_, i) => `o${i}`), v7)).toMatch(/between 2 and 10/)
    expect(pollOptionsError(['Yes', 'No', 'Yes'], v7)).toMatch(/different/)
    // The contract compares exact strings; v3 has no uniqueness rule at all.
    expect(pollOptionsError(['Yes', 'yes'], v7)).toBeNull()
    expect(pollOptionsError(['Yes', 'Yes'], v3)).toBeNull()
  })

  it('v7 requires a close time in the future, at most 31 days out', () => {
    const now = 1_000_000
    expect(pollEndsAtError(undefined, v7, now)).toMatch(/close time/)
    expect(pollEndsAtError(now, v7, now)).toMatch(/future/)
    expect(pollEndsAtError(now + POLL_MAX_DURATION_MS, v7, now)).toBeNull()
    expect(pollEndsAtError(now + POLL_MAX_DURATION_MS + 1, v7, now)).toMatch(/31 days/)
    // v3's close time is optional and unbounded.
    expect(pollEndsAtError(undefined, v3, now)).toBeNull()
    expect(pollEndsAtError(now + 2 * POLL_MAX_DURATION_MS, v3, now)).toBeNull()
  })

  it('offers only durations the 31-day rule accepts, defaulting to the first', () => {
    for (const { value } of POLL_DURATIONS) {
      expect(pollEndsAtError(pollEndsAt(value, 0), v7, 0)).toBeNull()
    }
    expect(pollEndsAt('7d', 0)).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('ballot plan', () => {
  it('creates the one ballot for a first vote, single or multi choice', () => {
    expect(planBallotWrite(null, [2])).toEqual({ kind: 'create', choices: [2] })
    expect(planBallotWrite(null, [2, 0])).toEqual({ kind: 'create', choices: [0, 2] })
  })

  it('replaces the choices to change the vote', () => {
    const mine = ballot([1], 3)
    expect(planBallotWrite(mine, [2])).toEqual({ kind: 'replace', ballot: mine, choices: [2] })
    // Multi choice: ticking and unticking is one replace of the whole selection.
    const several = ballot([0, 1])
    expect(planBallotWrite(several, [1, 2])).toEqual({ kind: 'replace', ballot: several, choices: [1, 2] })
  })

  it('withdraws by replacing the ballot with no choices', () => {
    const mine = ballot([0, 2])
    expect(planBallotWrite(mine, [])).toEqual({ kind: 'replace', ballot: mine, choices: [] })
  })

  it('re-picks on a withdrawn ballot by replacing it, never creating a second', () => {
    const withdrawn = ballot([], 2)
    expect(planBallotWrite(withdrawn, [0])).toEqual({ kind: 'replace', ballot: withdrawn, choices: [0] })
  })

  it('writes nothing when the selection is unchanged', () => {
    expect(planBallotWrite(ballot([1]), [1])).toBeNull()
    expect(planBallotWrite(ballot([0, 2]), [2, 0])).toBeNull()
    expect(planBallotWrite(ballot([]), [])).toBeNull()
    expect(planBallotWrite(null, [])).toBeNull()
  })
})

describe('editor start after an interrupted vote', () => {
  it('starts from the recorded choices when nothing was left unsent', () => {
    expect(editorStart([2, 0], null)).toEqual({ selected: [0, 2], unsent: [] })
  })

  it('starts from the last request and marks what the chain does not show', () => {
    // [0, 1, 2] was asked for and never landed: the chain still shows [0].
    expect(editorStart([0], [0, 1, 2])).toEqual({ selected: [0, 1, 2], unsent: [1, 2] })
    // A withdrawal that never landed marks the choice it would have dropped.
    expect(editorStart([0, 1], [0])).toEqual({ selected: [0], unsent: [1] })
    // It landed: nothing to mark.
    expect(editorStart([0, 1, 2], [2, 1, 0])).toEqual({ selected: [0, 1, 2], unsent: [] })
  })
})

describe('choices and tallies', () => {
  it('decodes grouped-count keys of both integer encodings', () => {
    // PV14 (5.0.0-beta.5): plain big-endian bytes.
    expect(['00', '03', '09'].map(decodeChoiceKey)).toEqual([0, 3, 9])
    // Testnet: the top bit flipped.
    expect(['80', '83', '89'].map(decodeChoiceKey)).toEqual([0, 3, 9])
    // Not a choice: out of range, the aggregate key, or not one byte of hex.
    expect(['0a', '8a', '', 'zz', '0080', '8'].map(decodeChoiceKey)).toEqual([null, null, null, null, null, null])
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
