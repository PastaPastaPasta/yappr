import { describe, expect, it, vi } from 'vitest'

async function load(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./payment-preference')
}

describe('planPayment', () => {
  it('spends credits on an unpriced type whatever the setting', async () => {
    const { planPayment } = await load('v9')
    expect(planPayment('follow', 'create', 1000n, 'yapp')).toMatchObject({ payWith: 'credits', yapp: 0n, actionFee: null })
  })

  it('cannot override a REQUIRED token cost (v2)', async () => {
    const { planPayment, paymentIsChoosable } = await load('v2')
    expect(paymentIsChoosable('post')).toBe(false)
    expect(planPayment('post', 'create', 0n, 'credits')).toMatchObject({
      payWith: 'yapp', yapp: 10n, gasFeesPaidBy: 0, gasMayBeSponsored: false, fallbackReason: 'token-required',
    })
  })

  it('follows the setting on v9 and carries the action fee', async () => {
    const { planPayment, paymentIsChoosable } = await load('v9')
    expect(paymentIsChoosable('post')).toBe(true)
    expect(planPayment('post', 'create', 100n, 'yapp')).toEqual({
      payWith: 'yapp', yapp: 10n, gasFeesPaidBy: 2, gasMayBeSponsored: true,
      actionFee: { owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' }, fallbackReason: null,
    })
    expect(planPayment('post', 'create', 100n, 'credits')).toMatchObject({ payWith: 'credits', yapp: 0n, gasMayBeSponsored: false, fallbackReason: null })
    expect(planPayment('like', 'create', 5n, 'credits').actionFee).toBeNull()
  })

  it('falls back to credits when YAPP does not cover the cost (40700 otherwise)', async () => {
    const { planPayment } = await load('v9')
    expect(planPayment('post', 'create', 9n, 'yapp')).toMatchObject({ payWith: 'credits', fallbackReason: 'insufficient-yapp' })
    expect(planPayment('post', 'create', null, 'yapp')).toMatchObject({ payWith: 'credits', fallbackReason: 'insufficient-yapp' })
    expect(planPayment('like', 'create', 1n, 'yapp')).toMatchObject({ payWith: 'yapp', yapp: 1n })
  })

  it('always spends credits while YAPP is locked: a paused token is refused 40711 on beta.3', async () => {
    for (const topology of ['v10', 'v13']) {
      const { planPayment, paymentIsChoosable } = await load(topology)
      expect(paymentIsChoosable('post')).toBe(false)
      for (const docType of ['post', 'reply', 'like', 'likeReply']) {
        // Whatever the balance, even one that covers the cost many times over.
        for (const balance of [1_000_000n, 0n, null]) {
          expect(planPayment(docType, 'create', balance, 'yapp')).toMatchObject({
            payWith: 'credits', yapp: 0n, gasFeesPaidBy: 0, gasMayBeSponsored: false, fallbackReason: 'yapp-locked',
          })
        }
        // A user who asked for credits gets exactly that: not a fallback.
        expect(planPayment(docType, 'create', 1_000_000n, 'credits')).toMatchObject({ payWith: 'credits', yapp: 0n, fallbackReason: null })
      }
      // The credit action fee still rides along.
      expect(planPayment('post', 'create', 1_000_000n, 'yapp').actionFee).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
    }
  })

  it('pays YAPP exactly as before on v14, whose YAPP starts unpaused', async () => {
    const { planPayment, paymentIsChoosable } = await load('v14')
    expect(paymentIsChoosable('post')).toBe(true)
    expect(planPayment('post', 'create', 100n, 'yapp')).toEqual({
      payWith: 'yapp', yapp: 10n, gasFeesPaidBy: 2, gasMayBeSponsored: true,
      actionFee: { owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' }, fallbackReason: null,
    })
    for (const docType of ['reply', 'like', 'likeReply']) {
      expect(planPayment(docType, 'create', 100n, 'yapp')).toMatchObject({ payWith: 'yapp', gasMayBeSponsored: true, fallbackReason: null })
    }
    expect(planPayment('post', 'create', 9n, 'yapp')).toMatchObject({ payWith: 'credits', fallbackReason: 'insufficient-yapp' })
    expect(planPayment('post', 'create', 100n, 'credits')).toMatchObject({ payWith: 'credits', fallbackReason: null })
  })

  it('keeps paying YAPP where it is not locked (v9)', async () => {
    const { planPayment } = await load('v9')
    for (const docType of ['post', 'reply', 'like', 'likeReply']) {
      expect(planPayment(docType, 'create', 1_000_000n, 'yapp')).toMatchObject({ payWith: 'yapp', gasMayBeSponsored: true, fallbackReason: null })
    }
  })

  it('only the create action is token-priced; other actions still carry their fee', async () => {
    const { planPayment } = await load('v9')
    expect(planPayment('post', 'replace', 100n, 'yapp')).toMatchObject({ payWith: 'credits', yapp: 0n, actionFee: null })
  })
})
