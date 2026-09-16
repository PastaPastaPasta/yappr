import { describe, expect, it } from 'vitest'
import { formatPrice } from './format'

describe('storefront price formatting', () => {
  it.each([
    [1, '0.00000001 DASH'],
    [100, '0.00000100 DASH'],
    [200, '0.00000200 DASH'],
    [500, '0.00000500 DASH'],
    [123456789, '1.23456789 DASH'],
    [0, '0.00000000 DASH'],
  ])('preserves all duffs in a DASH amount of %i', (price, expected) => {
    expect(formatPrice(price, 'DASH')).toBe(expected)
  })

  it('retains fiat and Bitcoin currency formatting', () => {
    expect(formatPrice(1234)).toBe('$12.34')
    expect(formatPrice(1234, 'EUR')).toBe('€12.34')
    expect(formatPrice(1, 'BTC')).toBe('0.00000001 BTC')
  })
})
