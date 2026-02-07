'use client'

import { PlusIcon, MinusIcon } from '@heroicons/react/24/outline'

interface QuantityControlProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  size?: 'sm' | 'md'
}

export function QuantityControl({
  value,
  onChange,
  min = 1,
  max = Infinity,
  size = 'md'
}: QuantityControlProps) {
  const handleDecrement = () => {
    if (value > min) {
      onChange(value - 1)
    }
  }

  const handleIncrement = () => {
    if (value < max) {
      onChange(value + 1)
    }
  }

  const buttonClasses = size === 'sm'
    ? 'p-1 rounded border border-surface-200 dark:border-surface-700 hover:bg-surface-100 dark:hover:bg-surface-800'
    : 'p-2 rounded-lg border border-surface-200 dark:border-surface-700 hover:bg-surface-100 dark:hover:bg-surface-800'

  const iconClasses = 'h-4 w-4'

  const valueClasses = size === 'sm'
    ? 'w-8 text-center'
    : 'w-12 text-center font-medium'

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleDecrement}
        disabled={value <= min}
        aria-label="Decrease quantity"
        className={`${buttonClasses} ${value <= min ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <MinusIcon className={iconClasses} />
      </button>
      <span className={valueClasses}>{value}</span>
      <button
        type="button"
        onClick={handleIncrement}
        disabled={value >= max}
        aria-label="Increase quantity"
        className={`${buttonClasses} ${value >= max ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <PlusIcon className={iconClasses} />
      </button>
    </div>
  )
}
