import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DepositChangedError, depositCap, formatDeposit } from '../lib/dpns/contest-deposit.ts'

const DEPOSIT = 10_000_000_000n

test('a name that goes to no vote has no cap', () => {
  assert.equal(depositCap('alice-has-a-long-name', null, null), null)
  assert.equal(depositCap('alice-has-a-long-name', DEPOSIT, null), null)
})

test('the approved deposit is the cap while the deposit read now is not more', () => {
  assert.equal(depositCap('alice', DEPOSIT, DEPOSIT), DEPOSIT)
  assert.equal(depositCap('alice', 2n * DEPOSIT, DEPOSIT), 2n * DEPOSIT)
})

test('a deposit that rose since the review, or was never shown, is refused before signing', () => {
  assert.throws(() => depositCap('alice', DEPOSIT, 2n * DEPOSIT), (error) =>
    error instanceof DepositChangedError
      && error.current === 2n * DEPOSIT
      && error.message === 'The vote deposit for alice.dash went up from 0.1 DASH to 0.2 DASH since you reviewed it, so nothing was charged. Review the new amount, then try again.')
  assert.throws(() => depositCap('alice', null, DEPOSIT), /goes to a community vote with a 0\.1 DASH deposit/)
  assert.throws(() => depositCap('alice', undefined, DEPOSIT), DepositChangedError)
})

test('formats credits as DASH', () => {
  assert.equal(formatDeposit(DEPOSIT), '0.1 DASH')
  assert.equal(formatDeposit(100_000_000_000n), '1 DASH')
  assert.equal(formatDeposit(12_345_000_000n), '0.12345 DASH')
})
