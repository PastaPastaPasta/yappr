/**
 * Shared formatting utilities for the storefront
 */

/**
 * Get the number of decimal places for a currency
 */
export function getCurrencyDecimals(currency: string): number {
  if (currency === 'DASH' || currency === 'BTC') {
    return 8
  }
  return 2 // Fiat currencies use 2 decimal places
}

/**
 * Get the multiplier to convert display value to smallest unit
 * (e.g., dollars to cents, DASH to duffs/satoshis)
 */
export function getCurrencyMultiplier(currency: string): number {
  const decimals = getCurrencyDecimals(currency)
  return Math.pow(10, decimals)
}

/**
 * Get the step value for price inputs based on currency
 */
export function getCurrencyStep(currency: string): string {
  const decimals = getCurrencyDecimals(currency)
  return (1 / Math.pow(10, decimals)).toFixed(decimals)
}

/**
 * Convert a display price to smallest currency unit (cents/satoshis)
 */
export function toSmallestUnit(price: number, currency: string): number {
  return Math.round(price * getCurrencyMultiplier(currency))
}

/**
 * Convert from smallest currency unit to display price
 */
export function fromSmallestUnit(price: number, currency: string): number {
  return price / getCurrencyMultiplier(currency)
}

/**
 * Format a price in cents/satoshis to a display string
 */
export function formatPrice(price: number, currency: string = 'USD'): string {
  if (currency === 'DASH') {
    return `${(price / 100000000).toFixed(4)} DASH`
  }
  if (currency === 'BTC') {
    return `${(price / 100000000).toFixed(8)} BTC`
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(price / 100)
}

/**
 * Format a date for display
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString()
}

/**
 * Format an order ID for display (truncated)
 */
export function formatOrderId(id: string): string {
  return `${id.slice(0, 8)}...`
}

/**
 * Display decimals for crypto amounts by scheme
 */
const CRYPTO_DISPLAY_DECIMALS: Record<string, number> = {
  'bitcoin:': 8,
  'ethereum:': 6,
  'dash:': 8,
  'tdash:': 8,
  'litecoin:': 8,
  'dogecoin:': 2,
  'ripple:': 6,
  'stellar:': 2,
  'cardano:': 6,
  'solana:': 6,
  'monero:': 8,
  'bitcoincash:': 8,
  'zcash:': 8,
  'polkadot:': 4,
  'tron:': 6,
  'lightning:': 8,
}

/**
 * Crypto symbol by scheme
 */
const CRYPTO_SYMBOLS: Record<string, string> = {
  'bitcoin:': 'BTC',
  'ethereum:': 'ETH',
  'dash:': 'DASH',
  'tdash:': 'DASH',
  'litecoin:': 'LTC',
  'dogecoin:': 'DOGE',
  'ripple:': 'XRP',
  'stellar:': 'XLM',
  'cardano:': 'ADA',
  'solana:': 'SOL',
  'monero:': 'XMR',
  'bitcoincash:': 'BCH',
  'zcash:': 'ZEC',
  'polkadot:': 'DOT',
  'tron:': 'TRX',
  'lightning:': 'BTC',
}

/**
 * Get the number of display decimals for a crypto scheme
 */
export function getCryptoDisplayDecimals(scheme: string): number {
  const normalized = scheme.toLowerCase().endsWith(':') ? scheme.toLowerCase() : `${scheme.toLowerCase()}:`
  return CRYPTO_DISPLAY_DECIMALS[normalized] ?? 8
}

/**
 * Get the symbol for a crypto scheme
 */
export function getCryptoSymbol(scheme: string): string {
  const normalized = scheme.toLowerCase().endsWith(':') ? scheme.toLowerCase() : `${scheme.toLowerCase()}:`
  return CRYPTO_SYMBOLS[normalized] ?? scheme.replace(':', '').toUpperCase()
}

/**
 * Format a crypto amount for display with appropriate decimals
 */
export function formatCryptoAmount(amount: number, scheme: string): string {
  const decimals = getCryptoDisplayDecimals(scheme)
  return amount.toFixed(decimals)
}

/**
 * Format a crypto amount with symbol
 */
export function formatCryptoWithSymbol(amount: number, scheme: string): string {
  const formatted = formatCryptoAmount(amount, scheme)
  const symbol = getCryptoSymbol(scheme)
  return `${formatted} ${symbol}`
}
