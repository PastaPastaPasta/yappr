import { describe, expect, it } from 'vitest'
import {
  ContestFundChangedError,
  approvedContestFund,
  creditsNeeded,
  formatDpnsCost,
  shortBalanceMessage,
  totalQuote,
} from './registration-quote'

const FUND = { indexName: 'parentNameAndLabel', credits: 10_000_000_000n }

describe('the registration quote', () => {
  it('totals each vote deposit and the fees, in DASH and cents', () => {
    const quote = totalQuote([
      { label: 'alex', contestFund: FUND, fees: 70_000_000n },
      { label: 'alex2', contestFund: null, fees: 70_000_000n },
    ])
    expect(quote).toMatchObject({ contestFunds: 10_000_000_000n, fees: 140_000_000n, total: 10_140_000_000n })
    // PV14's minimum deposit: 0.1 DASH, about 600¢ at the $60 reference price.
    expect(formatDpnsCost(FUND.credits)).toBe('0.1 DASH (about 600¢)')
    expect(formatDpnsCost(quote.total)).toBe('0.1014 DASH (about 608¢)')
    expect(formatDpnsCost(70_000_000n)).toBe('0.0007 DASH (about 4.2¢)')
  })

  it('needs the deposit and the fees still to pay', () => {
    expect(creditsNeeded({ contestFund: FUND, fees: 70_000_000n })).toBe(10_070_000_000n)
    expect(creditsNeeded({ contestFund: null, fees: 70_000_000n })).toBe(70_000_000n)
    expect(shortBalanceMessage(10_070_000_000n, 10_070_000_000n)).toBeNull()
    expect(shortBalanceMessage(10_069_999_999n, 10_070_000_000n)).toMatch(/^This needs 0\.1007 DASH/)
  })
})

describe('the deposit read right before signing', () => {
  it('passes only when it is the approved one', () => {
    expect(approvedContestFund('alex', FUND.credits, FUND)).toBe(FUND)
    // No vote (any more): nothing to approve.
    expect(approvedContestFund('alex2', null, null)).toBeNull()
    expect(approvedContestFund('alex2', FUND.credits, null)).toBeNull()
  })

  it('refuses a deposit that went up, went down, or was never approved', () => {
    const up = () => approvedContestFund('alex', FUND.credits, { ...FUND, credits: 20_000_000_000n })
    expect(up).toThrow(ContestFundChangedError)
    expect(up).toThrow('The vote deposit for alex.dash changed from 0.1 DASH (about 600¢) to 0.2 DASH (about 1,200¢) since you reviewed it, so nothing more was charged. Review the new amount, then try again.')
    expect(() => approvedContestFund('alex', 20_000_000_000n, FUND)).toThrow(ContestFundChangedError)
    expect(() => approvedContestFund('alex', null, FUND)).toThrow('alex.dash goes to a community vote with a 0.1 DASH (about 600¢) deposit. Review the amount, then try again.')
    expect(() => approvedContestFund('alex', undefined, FUND)).toThrow(ContestFundChangedError)
  })
})
