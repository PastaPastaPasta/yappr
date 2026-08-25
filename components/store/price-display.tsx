'use client'

import { formatPrice } from '@/lib/utils/format'

type Size = 'sm' | 'md' | 'lg'

const TEXT_SIZE_CLASSES: Record<Size, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-xl'
}

interface PriceDisplayProps {
  price: number
  currency?: string
  className?: string
  size?: Size
  strikethrough?: boolean
}

export function PriceDisplay({ price, currency = 'USD', className, size = 'md', strikethrough }: PriceDisplayProps) {
  const formatted = formatPrice(price, currency)

  return (
    <span
      className={`font-medium text-yappr-600 ${TEXT_SIZE_CLASSES[size]} ${strikethrough ? 'line-through text-gray-400' : ''} ${className || ''}`}
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
  size?: Size
}

export function PriceRangeDisplay({ minPrice, maxPrice, currency = 'USD', className, size = 'md' }: PriceRangeDisplayProps) {
  if (minPrice === maxPrice) {
    return <PriceDisplay price={minPrice} currency={currency} className={className} size={size} />
  }

  return (
    <span className={`font-medium text-yappr-600 ${TEXT_SIZE_CLASSES[size]} ${className || ''}`}>
      {formatPrice(minPrice, currency)} - {formatPrice(maxPrice, currency)}
    </span>
  )
}
