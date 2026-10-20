import { describe, expect, it } from 'vitest'
import { formatDuration, formatPrice } from './format'

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

describe('contract window durations', () => {
  it.each([
    [86_400, 'a day', '1-day'],
    [604_800, '7 days', '7-day'],
    [129_600, '36 hours', '36-hour'],
    [3_600, 'an hour', '1-hour'],
    [5_400, '90 minutes', '90-minute'],
    [90, '90 seconds', '90-second'],
    [1, 'a second', '1-second'],
  ])('renders %i seconds in its largest whole unit', (seconds, noun, adjective) => {
    expect(formatDuration(seconds)).toBe(noun)
    expect(formatDuration(seconds, { adjective: true })).toBe(adjective)
  })
})
