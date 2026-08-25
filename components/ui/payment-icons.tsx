'use client'

import { CurrencyDollarIcon } from '@heroicons/react/24/outline'

// Payment scheme to display name mapping
export const PAYMENT_SCHEME_LABELS: Record<string, string> = {
  'dash:': 'Dash',
  'tdash:': 'Dash (Testnet)',
  'bitcoin:': 'Bitcoin',
  'litecoin:': 'Litecoin',
  'ethereum:': 'Ethereum',
  'monero:': 'Monero',
  'dogecoin:': 'Dogecoin',
  'bitcoincash:': 'Bitcoin Cash',
  'zcash:': 'Zcash',
  'stellar:': 'Stellar',
  'ripple:': 'XRP',
  'solana:': 'Solana',
  'cardano:': 'Cardano',
  'polkadot:': 'Polkadot',
  'tron:': 'Tron',
  'lightning:': 'Lightning',
}

// Simple colored circle icons for each payment scheme
const PAYMENT_COLORS: Record<string, string> = {
  'dash:': '#008DE4',      // Dash blue
  'tdash:': '#008DE4',     // Dash testnet (same color)
  'bitcoin:': '#F7931A',   // Bitcoin orange
  'litecoin:': '#345D9D',  // Litecoin blue
  'ethereum:': '#627EEA',  // Ethereum purple
  'monero:': '#FF6600',    // Monero orange
  'dogecoin:': '#C2A633',  // Dogecoin gold
  'bitcoincash:': '#0AC18E', // Bitcoin Cash green
  'zcash:': '#ECB244',     // Zcash yellow
  'stellar:': '#000000',   // Stellar black
  'ripple:': '#23292F',    // XRP dark
  'solana:': '#9945FF',    // Solana purple
  'cardano:': '#0033AD',   // Cardano blue
  'polkadot:': '#E6007A',  // Polkadot pink
  'tron:': '#FF0013',      // Tron red
  'lightning:': '#F7931A', // Lightning (Bitcoin) orange
}

interface PaymentSchemeIconProps {
  scheme: string
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

export function PaymentSchemeIcon({
  scheme,
  className = '',
  size = 'md',
}: PaymentSchemeIconProps) {
  const color = PAYMENT_COLORS[scheme.toLowerCase()] || '#6B7280'
  const label = PAYMENT_SCHEME_LABELS[scheme.toLowerCase()] || 'Unknown'

  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6',
  }

  const textSizes = {
    sm: 'text-[8px]',
    md: 'text-[10px]',
    lg: 'text-xs',
  }

  // Get first letter(s) for the icon
  const abbrev = getSchemeAbbreviation(scheme)

  return (
    <div
      className={`${sizeClasses[size]} rounded-full flex items-center justify-center font-bold text-white ${className}`}
      style={{ backgroundColor: color }}
      title={label}
    >
      <span className={textSizes[size]}>{abbrev}</span>
    </div>
  )
}

function getSchemeAbbreviation(scheme: string): string {
  const lowerScheme = scheme.toLowerCase()
  switch (lowerScheme) {
    case 'dash:': return 'D'
    case 'tdash:': return 'tD'
    case 'bitcoin:': return 'B'
    case 'litecoin:': return 'L'
    case 'ethereum:': return 'E'
    case 'monero:': return 'M'
    case 'dogecoin:': return 'D'
    case 'bitcoincash:': return 'BC'
    case 'zcash:': return 'Z'
    case 'stellar:': return 'XL'
    case 'ripple:': return 'X'
    case 'solana:': return 'S'
    case 'cardano:': return 'A'
    case 'polkadot:': return 'P'
    case 'tron:': return 'T'
    case 'lightning:': return 'LN'
    default: return '?'
  }
}

// Fallback generic payment icon
export function GenericPaymentIcon({
  className = '',
  size = 'md',
}: {
  className?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6',
  }

  return (
    <CurrencyDollarIcon className={`${sizeClasses[size]} text-gray-500 ${className}`} />
  )
}

// Get display label for a payment URI
export function getPaymentLabel(uri: string): string {
  const colonIndex = uri.indexOf(':')
  if (colonIndex > 0) {
    const scheme = uri.substring(0, colonIndex + 1).toLowerCase()
    return PAYMENT_SCHEME_LABELS[scheme] || scheme.replace(':', '')
  }
  return 'Payment'
}

// Truncate address for display
export function truncateAddress(uri: string, maxLength: number = 12): string {
  const colonIndex = uri.indexOf(':')
  if (colonIndex < 0) return uri

  const address = uri.substring(colonIndex + 1)
  // Remove any query params
  const cleanAddress = address.split('?')[0]

  if (cleanAddress.length <= maxLength) return cleanAddress

  const start = cleanAddress.substring(0, Math.floor(maxLength / 2))
  const end = cleanAddress.substring(cleanAddress.length - Math.floor(maxLength / 2))
  return `${start}...${end}`
}
