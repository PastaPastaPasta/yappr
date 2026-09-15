'use client'

import { useState } from 'react'
import * as RadioGroup from '@radix-ui/react-radio-group'
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
    <RadioGroup.Root
      aria-label="Rating"
      orientation="horizontal"
      value={value === 0 ? '' : String(value)}
      onValueChange={(rating) => {
        setHoverRating(0)
        onChange(Number(rating))
      }}
      disabled={disabled}
      className="flex gap-1"
      onMouseLeave={() => setHoverRating(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <RadioGroup.Item
          key={star}
          value={String(star)}
          aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`}
          onMouseMove={() => !disabled && setHoverRating(star)}
          className={`rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500 focus-visible:ring-offset-2 transition-transform ${
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
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
