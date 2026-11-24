import { describe, expect, it } from 'vitest'
import { lastAcceptedNonce, nonceAdmissible } from './nonce-rules.mjs'

const n = (value: number) => BigInt(value)
/** Platform at `tip` with `missing` (nonces behind it) not yet executed. */
const at = (tip: number, ...missing: number[]) => missing.reduce((raw, nonce) => raw | (BigInt(1) << BigInt(40 + tip - nonce - 1)), n(tip))

describe('nonceAdmissible', () => {
  it('admits a nonce ahead of the tip up to the last one Drive accepts', () => {
    expect(lastAcceptedNonce(n(100))).toBe(n(124))
    expect(nonceAdmissible(n(100), n(101))).toBe(true)
    expect(nonceAdmissible(n(100), n(124))).toBe(true)
    expect(nonceAdmissible(n(100), n(125))).toBe(false)
  })

  it('admits at most 23 ahead before the identity first wrote to the contract', () => {
    expect(nonceAdmissible(undefined, n(23))).toBe(true)
    expect(nonceAdmissible(undefined, n(24))).toBe(false)
  })

  it('admits a missing nonce behind the tip at distance 23, never at 24, where Drive refuses it as too far in the past', () => {
    expect(nonceAdmissible(at(124, 101), n(101))).toBe(true)
    expect(nonceAdmissible(at(125, 101), n(101))).toBe(false)
  })

  it('never admits a nonce that was used: the tip, or one behind it that is no longer missing', () => {
    expect(nonceAdmissible(at(103, 102), n(103))).toBe(false)
    expect(nonceAdmissible(at(103, 102), n(101))).toBe(false)
    expect(nonceAdmissible(at(103, 102), n(102))).toBe(true)
  })
})
