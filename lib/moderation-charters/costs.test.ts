import { describe, expect, it } from 'vitest'
import { CHARTER_KEY_SETUP_CREDITS, applyCostLines, costTotal, formatCents, formatCost, formatDash, joinCostLines, startCostLines, type CreateFees } from './costs'
import { CONTEST_FUND_CREDITS } from './rules.mjs'

// Priced on testnet with documentCreateCost (rc.4): the order of magnitude matters, not the digits.
const FEES: CreateFees = {
  reason: 29_696_160n, submittedCharter: 73_125_360n, joinRequest: 50_615_460n,
  electedCharter: 43_301_180n, addedModerator: 33_338_680n, removedModerator: 32_327_480n,
}

describe('costs', () => {
  it('prices starting a team: the charter key once, each new reason, and the proposal', () => {
    const lines = startCostLines(FEES, { newReasons: 2, needsCharterKey: true })
    expect(lines.map((line) => line.credits)).toEqual([CHARTER_KEY_SETUP_CREDITS, FEES.reason * 2n, FEES.submittedCharter])
    expect(startCostLines(FEES, { newReasons: 0, needsCharterKey: false })).toEqual([{ label: 'Proposal', credits: FEES.submittedCharter }])
  })

  it('prices joining and applying; the application carries the 0.5 DASH deposit as its own line', () => {
    expect(costTotal(joinCostLines(FEES, { needsCharterKey: false }))).toBe(FEES.joinRequest)
    const apply = applyCostLines(FEES)
    expect(apply[0]).toMatchObject({ credits: CONTEST_FUND_CREDITS, deposit: true })
    expect(costTotal(apply)).toBe(CONTEST_FUND_CREDITS + FEES.electedCharter)
  })

  it('shows every amount in DASH and cents at $60 a DASH', () => {
    expect(formatCost(CONTEST_FUND_CREDITS)).toBe('0.5 DASH (about 3,000¢)')
    expect(formatDash(FEES.submittedCharter)).toBe('0.0007313')
    expect(formatCents(FEES.submittedCharter)).toBe('about 4.4¢')
    expect(formatCents(1_000_000n)).toBe('under 0.1¢')
    expect(formatCents(51_000_000_000n)).toBe('about 3,060¢')
    expect(formatDash(125_000_000_000n)).toBe('1.25')
    expect(formatCost(0n)).toBe('0 DASH (0¢)')
  })
})
