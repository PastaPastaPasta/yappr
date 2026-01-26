/**
 * Crypto Price Service
 * Fetches cryptocurrency prices from multiple APIs (CoinGecko + CryptoCompare),
 * averages them for accuracy, and caches results.
 */

// Scheme to API identifier mapping
const SCHEME_TO_IDS: Record<string, { coingecko: string; cryptocompare: string }> = {
  'dash:': { coingecko: 'dash', cryptocompare: 'DASH' },
  'tdash:': { coingecko: 'dash', cryptocompare: 'DASH' },
  'bitcoin:': { coingecko: 'bitcoin', cryptocompare: 'BTC' },
  'litecoin:': { coingecko: 'litecoin', cryptocompare: 'LTC' },
  'ethereum:': { coingecko: 'ethereum', cryptocompare: 'ETH' },
  'monero:': { coingecko: 'monero', cryptocompare: 'XMR' },
  'dogecoin:': { coingecko: 'dogecoin', cryptocompare: 'DOGE' },
  'bitcoincash:': { coingecko: 'bitcoin-cash', cryptocompare: 'BCH' },
  'zcash:': { coingecko: 'zcash', cryptocompare: 'ZEC' },
  'stellar:': { coingecko: 'stellar', cryptocompare: 'XLM' },
  'ripple:': { coingecko: 'ripple', cryptocompare: 'XRP' },
  'solana:': { coingecko: 'solana', cryptocompare: 'SOL' },
  'cardano:': { coingecko: 'cardano', cryptocompare: 'ADA' },
  'polkadot:': { coingecko: 'polkadot', cryptocompare: 'DOT' },
  'tron:': { coingecko: 'tron', cryptocompare: 'TRX' },
  'lightning:': { coingecko: 'bitcoin', cryptocompare: 'BTC' },
}

// Cache duration in milliseconds (60 seconds)
const CACHE_DURATION = 60 * 1000

export interface PriceResult {
  price: number
  sources: string[]
  timestamp: number
}

export interface ConversionResult {
  cryptoAmount: number
  price: number
  sources: string[]
}

interface CacheEntry {
  result: PriceResult
  expiresAt: number
}

class CryptoPriceService {
  private cache: Map<string, CacheEntry> = new Map()

  /**
   * Normalize scheme to lowercase with trailing colon
   */
  private normalizeScheme(scheme: string): string {
    const normalized = scheme.toLowerCase()
    return normalized.endsWith(':') ? normalized : `${normalized}:`
  }

  /**
   * Get cache key for a scheme/currency pair
   */
  private getCacheKey(scheme: string, fiatCurrency: string): string {
    return `${this.normalizeScheme(scheme)}_${fiatCurrency.toUpperCase()}`
  }

  /**
   * Fetch price from CoinGecko API
   */
  private async fetchCoinGecko(scheme: string, fiatCurrency: string): Promise<number | null> {
    const ids = SCHEME_TO_IDS[this.normalizeScheme(scheme)]
    if (!ids) return null

    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.coingecko}&vs_currencies=${fiatCurrency.toLowerCase()}`
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      })

      if (!response.ok) return null

      const data = await response.json()
      const price = data?.[ids.coingecko]?.[fiatCurrency.toLowerCase()]
      return typeof price === 'number' ? price : null
    } catch {
      return null
    }
  }

  /**
   * Fetch price from CryptoCompare API
   */
  private async fetchCryptoCompare(scheme: string, fiatCurrency: string): Promise<number | null> {
    const ids = SCHEME_TO_IDS[this.normalizeScheme(scheme)]
    if (!ids) return null

    try {
      const url = `https://min-api.cryptocompare.com/data/price?fsym=${ids.cryptocompare}&tsyms=${fiatCurrency.toUpperCase()}`
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      })

      if (!response.ok) return null

      const data = await response.json()
      const price = data?.[fiatCurrency.toUpperCase()]
      return typeof price === 'number' ? price : null
    } catch {
      return null
    }
  }

  /**
   * Get averaged price from multiple sources
   */
  async getPrice(scheme: string, fiatCurrency: string): Promise<PriceResult | null> {
    const cacheKey = this.getCacheKey(scheme, fiatCurrency)

    // Check cache first
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result
    }

    // Fetch from both APIs in parallel
    const [geckoPrice, comparePrice] = await Promise.allSettled([
      this.fetchCoinGecko(scheme, fiatCurrency),
      this.fetchCryptoCompare(scheme, fiatCurrency),
    ])

    const prices: number[] = []
    const sources: string[] = []

    if (geckoPrice.status === 'fulfilled' && geckoPrice.value !== null) {
      prices.push(geckoPrice.value)
      sources.push('CoinGecko')
    }
    if (comparePrice.status === 'fulfilled' && comparePrice.value !== null) {
      prices.push(comparePrice.value)
      sources.push('CryptoCompare')
    }

    if (prices.length === 0) {
      return null
    }

    // Average the prices
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length
    const result: PriceResult = {
      price: avgPrice,
      sources,
      timestamp: Date.now(),
    }

    // Cache the result
    this.cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + CACHE_DURATION,
    })

    return result
  }

  /**
   * Convert fiat amount to crypto
   */
  async convertToCrypto(
    fiatAmount: number,
    fiatCurrency: string,
    scheme: string
  ): Promise<ConversionResult | null> {
    const priceResult = await this.getPrice(scheme, fiatCurrency)
    if (!priceResult || priceResult.price <= 0) {
      return null
    }

    return {
      cryptoAmount: fiatAmount / priceResult.price,
      price: priceResult.price,
      sources: priceResult.sources,
    }
  }

  /**
   * Check if a scheme is supported for price lookups
   */
  isSchemeSupported(scheme: string): boolean {
    return this.normalizeScheme(scheme) in SCHEME_TO_IDS
  }

  /**
   * Clear the price cache
   */
  clearCache(): void {
    this.cache.clear()
  }
}

// Export singleton instance
export const cryptoPriceService = new CryptoPriceService()
