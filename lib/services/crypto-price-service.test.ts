import { afterEach, describe, expect, it, vi } from 'vitest'
import { cryptoPriceService } from './crypto-price-service'

afterEach(() => {
  vi.unstubAllGlobals()
  cryptoPriceService.clearCache()
})

describe('payment amount conversion', () => {
  it.each([
    ['dash:', 'DASH'],
    ['TDASH', 'dash'],
    ['bitcoin:', 'BTC'],
    ['lightning:', 'BTC'],
  ])('keeps %s payments in %s independent of exchange APIs', async (scheme, currency) => {
    const fetch = vi.fn().mockRejectedValue(new Error('Exchange API unavailable'))
    vi.stubGlobal('fetch', fetch)

    expect(await cryptoPriceService.convertToCrypto(0.000003, currency, scheme)).toEqual({
      cryptoAmount: 0.000003,
      price: 1,
      sources: [],
    })
    expect(await cryptoPriceService.getPrice(scheme, currency, true)).toMatchObject({ price: 1, sources: [] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still converts fiat orders using exchange prices', async () => {
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('coingecko') ? { dash: { usd: 25 } } : { USD: 25 },
    }))
    vi.stubGlobal('fetch', fetch)

    expect(await cryptoPriceService.convertToCrypto(50, 'USD', 'tdash:')).toEqual({
      cryptoAmount: 2,
      price: 25,
      sources: ['CoinGecko', 'CryptoCompare'],
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not invent a same-currency price for an unsupported payment scheme', async () => {
    expect(await cryptoPriceService.convertToCrypto(1, 'UNKNOWN', 'unknown:')).toBeNull()
  })
})
