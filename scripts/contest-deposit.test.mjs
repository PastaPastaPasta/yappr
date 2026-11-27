// Imports the TypeScript helper directly: needs Node 22.18+ or 23.6+ (type stripping on by default), or --experimental-strip-types from 22.6.
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

test('recognises a domain refused for stating less than the fund to join', async () => {
  const { contestNotPaidFor } = await import('../lib/dpns/contest-deposit.ts')
  assert.equal(contestNotPaidFor(new Error('Contest for document abc was not paid for, needs payment of 20000000000 credits')), true)
  assert.equal(contestNotPaidFor(new Error('Insufficient identity balance (code=40500)')), false)
})

test('recognises the SDK-shaped rejection by its numeric code, not its string form', async () => {
  const { contestNotPaidFor } = await import('../lib/dpns/contest-deposit.ts')
  const sdkError = { code: 40114, message: 'State transition rejected' }
  assert.equal(String(sdkError), '[object Object]')
  assert.equal(contestNotPaidFor(sdkError), true)
  assert.equal(contestNotPaidFor({ code: 40500, message: 'Insufficient identity balance' }), false)
  assert.equal(contestNotPaidFor({ message: 'state error 40114' }), true)
})

test('only a granted name becomes the session username; a contender never replaces it', async () => {
  const { grantedUsername } = await import('../lib/dpns/contest-deposit.ts')
  // Onboarding: a usable name registers, then Register More enters a contested one.
  let session = null
  const first = grantedUsername([{ label: 'usable-name-27', success: true, isContested: false }])
  session = first ?? session
  const second = grantedUsername([{ label: 'abc', success: true, isContested: true }])
  session = second ?? session
  assert.equal(session, 'usable-name-27')
  assert.equal(grantedUsername([{ label: 'abc', success: true, isContested: true }, { label: 'usable-name-28', success: true, isContested: false }]), 'usable-name-28')
  assert.equal(grantedUsername([{ label: 'failed-name-29', success: false, isContested: false }]), null)
})

test('continuing after a vote-only result goes on without a name, keeping none', async () => {
  const { continuesWithoutName, grantedUsername } = await import('../lib/dpns/contest-deposit.ts')
  const results = [{ label: 'abc', success: true, isContested: true }]
  // The contender is never saved as the session username…
  assert.equal(grantedUsername(results), null)
  // …and Continue takes the skip path instead of sending the user back to username setup.
  assert.equal(continuesWithoutName(null, [{ registered: true, isContested: true }]), true)
  assert.equal(continuesWithoutName('owned-name-27', [{ registered: true, isContested: true }]), false)
  assert.equal(continuesWithoutName(null, [{ registered: true, isContested: false }]), false)
  assert.equal(continuesWithoutName(null, [{ registered: false, isContested: true }]), false)
})
