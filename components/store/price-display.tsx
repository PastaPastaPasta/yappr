'use client'

interface PriceDisplayProps {
  price: number
  currency?: string
  className?: string
  size?: 'sm' | 'md' | 'lg'
  strikethrough?: boolean
}

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

export function PriceDisplay({ price, currency = 'USD', className, size = 'md', strikethrough }: PriceDisplayProps) {
  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-xl'
  }

  const formatted = formatPrice(price, currency)

  return (
    <span
      className={`font-medium text-yappr-600 ${sizeClasses[size]} ${strikethrough ? 'line-through text-gray-400' : ''} ${className || ''}`}
    >
      {formatted}
    </span>
  )
}

interface PriceRangeDisplayProps {
  minPrice: number
  maxPrice: number
  currency?: string
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

export function PriceRangeDisplay({ minPrice, maxPrice, currency = 'USD', className, size = 'md' }: PriceRangeDisplayProps) {
  if (minPrice === maxPrice) {
    return <PriceDisplay price={minPrice} currency={currency} className={className} size={size} />
  }

  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-xl'
  }

  return (
    <span className={`font-medium text-yappr-600 ${sizeClasses[size]} ${className || ''}`}>
      {formatPrice(minPrice, currency)} - {formatPrice(maxPrice, currency)}
    </span>
  )
}
