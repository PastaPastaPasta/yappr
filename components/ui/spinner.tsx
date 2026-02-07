'use client'

interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  xs: 'h-4 w-4',
  sm: 'h-5 w-5',
  md: 'h-8 w-8',
  lg: 'h-12 w-12'
}

export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-2 border-surface-200 dark:border-surface-700 border-t-yappr-500 ${sizeClasses[size]} ${className}`}
      role="status"
      aria-label="Loading"
    />
  )
}
