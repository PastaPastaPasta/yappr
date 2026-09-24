import { describe, expect, it, vi } from 'vitest'
import { actionFeeAgreementOptions, tokenPaymentOptions } from './transition-agreements'

async function plannerFor(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./payment-preference')
}

describe('actionFeeAgreementOptions', () => {
  it('names the declared pots and the known multiplier with a 20% tolerance for feeMultiplier pricing', () => {
    expect(actionFeeAgreementOptions({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' }, 1000n)).toEqual({
      owner: 0n,
      moderators: 80_000_000n,
      feeMultiplier: { knownPermille: 1000n, increaseTolerancePercent: 20 },
    })
  })

  it('leaves the multiplier out for a fixed fee (naming it is the same 40133)', () => {
    expect(actionFeeAgreementOptions({ owner: 5n, moderators: 0n, pricing: 'fixed' }, 1500n)).toEqual({ owner: 5n, moderators: 0n })
  })

  it('always agrees to the FULL declared moderators fee, never a discount (a discount is what 40139 checks)', () => {
    // On an elected contract Drive only compares a LOWER moderators amount with
    // the seated charter's share; the declared amount passes seated or not.
    for (const moderators of [80_000_000n, 16_000_000n, 1n]) {
      expect(actionFeeAgreementOptions({ owner: 0n, moderators, pricing: 'feeMultiplier' }, 1000n).moderators).toBe(moderators)
    }
  })

  it('carries the multiplier it is given, not a constant', () => {
    const options = actionFeeAgreementOptions({ owner: 0n, moderators: 16_000_000n, pricing: 'feeMultiplier' }, 1250n)
    expect(options.feeMultiplier?.knownPermille).toBe(1250n)
  })
})

describe('tokenPaymentOptions', () => {
  it('on v8 pays YAPP with the PreferContractOwner gas offer when the plan says yapp', async () => {
    const { planPayment } = await plannerFor('v8')
    expect(tokenPaymentOptions(planPayment('post', 'create', 100n, 'yapp'), 0)).toEqual({
      tokenContractPosition: 0,
      maximumTokenCost: 10n,
      gasFeesPaidBy: 2,
    })
  })

  it('on v8 omits the payment info entirely when the plan says credits', async () => {
    const { planPayment } = await plannerFor('v8')
    expect(tokenPaymentOptions(planPayment('post', 'create', 100n, 'credits'), 0)).toBeUndefined()
    // Too little YAPP plans credits too: payment info present would be 40700.
    expect(tokenPaymentOptions(planPayment('post', 'create', 9n, 'yapp'), 0)).toBeUndefined()
    expect(tokenPaymentOptions(planPayment('post', 'create', null, 'yapp'), 0)).toBeUndefined()
    // An unpriced type never carries one.
    expect(tokenPaymentOptions(planPayment('follow', 'create', 100n, 'yapp'), 0)).toBeUndefined()
  })

  it('before v8 is exactly the historical bag: position and cap, no gas offer, whatever the setting or balance', async () => {
    const { planPayment } = await plannerFor('v7')
    const expected = { tokenContractPosition: 0, maximumTokenCost: 10n }
    expect(tokenPaymentOptions(planPayment('post', 'create', 0n, 'credits'), 0)).toEqual(expected)
    expect(tokenPaymentOptions(planPayment('post', 'create', null, 'yapp'), 0)).toEqual(expected)
    expect(tokenPaymentOptions(planPayment('like', 'create', 100n, 'yapp'), 0)).toEqual({ tokenContractPosition: 0, maximumTokenCost: 1n })
  })

  it('never asks for gasFeesPaidBy 1 (insisting on the owner is 40129)', async () => {
    const { planPayment } = await plannerFor('v8')
    for (const docType of ['post', 'reply', 'like', 'likeReply', 'repost']) {
      expect(tokenPaymentOptions(planPayment(docType, 'create', 1000n, 'yapp'), 0)?.gasFeesPaidBy).toBe(2)
    }
  })
})
