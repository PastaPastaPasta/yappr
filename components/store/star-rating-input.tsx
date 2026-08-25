'use client'

import { useState } from 'react'
import { StarIcon } from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'

interface StarRatingInputProps {
  value: number
  onChange: (rating: number) => void
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
}

const sizeClasses = {
  sm: 'h-5 w-5',
  md: 'h-6 w-6',
  lg: 'h-8 w-8'
}

export function StarRatingInput({
  value,
  onChange,
  size = 'md',
  disabled = false
}: StarRatingInputProps) {
  const [hoverRating, setHoverRating] = useState(0)
  const displayRating = hoverRating || value

  return (
    <div
      className="flex gap-1"
      onMouseLeave={() => setHoverRating(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={disabled}
          onClick={() => onChange(star)}
          onMouseEnter={() => !disabled && setHoverRating(star)}
          className={`transition-transform ${
            disabled
              ? 'cursor-not-allowed opacity-50'
              : 'cursor-pointer hover:scale-110'
          }`}
        >
          {star <= displayRating ? (
            <StarIconSolid
              className={`${sizeClasses[size]} ${
                hoverRating > 0
                  ? 'text-yellow-300'
                  : 'text-yellow-400'
              }`}
            />
          ) : (
            <StarIcon
              className={`${sizeClasses[size]} text-gray-300 dark:text-gray-600`}
            />
          )}
        </button>
      ))}
    </div>
  )
}
