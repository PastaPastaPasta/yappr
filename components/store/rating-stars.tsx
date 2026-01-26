'use client'

import { StarIcon } from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'

interface RatingStarsProps {
  rating: number
  size?: 'sm' | 'md' | 'lg'
  showValue?: boolean
  reviewCount?: number
}

export function RatingStars({ rating, size = 'md', showValue, reviewCount }: RatingStarsProps) {
  const sizeClasses = {
    sm: 'h-3 w-3',
    md: 'h-4 w-4',
    lg: 'h-5 w-5'
  }

  const starClass = sizeClasses[size]

  const stars = []
  for (let i = 1; i <= 5; i++) {
    if (i <= Math.floor(rating)) {
      stars.push(<StarIconSolid key={i} className={`${starClass} text-yellow-400`} />)
    } else if (i - 0.5 <= rating) {
      // Half star - show full star with reduced opacity
      stars.push(
        <div key={i} className="relative">
          <StarIcon className={`${starClass} text-gray-300`} />
          <div className="absolute inset-0 overflow-hidden" style={{ width: '50%' }}>
            <StarIconSolid className={`${starClass} text-yellow-400`} />
          </div>
        </div>
      )
    } else {
      stars.push(<StarIcon key={i} className={`${starClass} text-gray-300`} />)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <div className="flex">{stars}</div>
      {showValue && (
        <span className={`text-gray-500 ${size === 'sm' ? 'text-xs' : 'text-sm'}`}>
          {rating.toFixed(1)}
        </span>
      )}
      {reviewCount !== undefined && (
        <span className={`text-gray-400 ${size === 'sm' ? 'text-xs' : 'text-sm'}`}>
          ({reviewCount})
        </span>
      )}
    </div>
  )
}
