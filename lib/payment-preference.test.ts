import { describe, expect, it, vi } from 'vitest'

async function load(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./payment-preference')
}

describe('planPayment', () => {
  it('spends credits on an unpriced type whatever the setting', async () => {
    const { planPayment } = await load('v8')
    expect(planPayment('follow', 'create', 1000n, 'yapp')).toMatchObject({ payWith: 'credits', yapp: 0n, actionFee: null })
  })

  it('cannot override a REQUIRED token cost (pre-v8)', async () => {
    const { planPayment, paymentIsChoosable } = await load('v7')
    expect(paymentIsChoosable('post')).toBe(false)
    expect(planPayment('post', 'create', 0n, 'credits')).toMatchObject({
      payWith: 'yapp', yapp: 10n, gasFeesPaidBy: 0, gasMayBeSponsored: false, fallbackReason: 'token-required',
    })
  })

  it('follows the setting on v8 and carries the action fee', async () => {
    const { planPayment, paymentIsChoosable } = await load('v8')
    expect(paymentIsChoosable('post')).toBe(true)
    expect(planPayment('post', 'create', 100n, 'yapp')).toEqual({
      payWith: 'yapp', yapp: 10n, gasFeesPaidBy: 2, gasMayBeSponsored: true,
      actionFee: { owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' }, fallbackReason: null,
    })
    expect(planPayment('post', 'create', 100n, 'credits')).toMatchObject({ payWith: 'credits', yapp: 0n, gasMayBeSponsored: false, fallbackReason: null })
    expect(planPayment('like', 'create', 5n, 'credits').actionFee).toBeNull()
  })

  it('falls back to credits when YAPP does not cover the cost (40700 otherwise)', async () => {
    const { planPayment } = await load('v8')
    expect(planPayment('post', 'create', 9n, 'yapp')).toMatchObject({ payWith: 'credits', fallbackReason: 'insufficient-yapp' })
    expect(planPayment('post', 'create', null, 'yapp')).toMatchObject({ payWith: 'credits', fallbackReason: 'insufficient-yapp' })
    expect(planPayment('like', 'create', 1n, 'yapp')).toMatchObject({ payWith: 'yapp', yapp: 1n })
  })

  it('only the create action is token-priced; other actions still carry their fee', async () => {
    const { planPayment } = await load('v8')
    expect(planPayment('post', 'replace', 100n, 'yapp')).toMatchObject({ payWith: 'credits', yapp: 0n, actionFee: null })
  })
})
