'use client'

interface PresenceIndicatorProps {
  userId: string
  size?: 'sm' | 'md' | 'lg'
  hideOffline?: boolean
  className?: string
}

const sizeClasses = {
  sm: 'h-2 w-2',
  md: 'h-3 w-3',
  lg: 'h-4 w-4',
}

/**
 * Presence indicator component - shows user online status
 * Currently a placeholder - presence system not yet implemented
 */
export function PresenceIndicator({
  size = 'sm',
  hideOffline = true,
  className = '',
}: PresenceIndicatorProps) {
  // Presence system not implemented yet - hide indicator
  if (hideOffline) {
    return null
  }

  const sizeClass = sizeClasses[size]

  return (
    <div
      className={`${sizeClass} rounded-full bg-gray-400 border-2 border-white dark:border-surface-800 ${className}`}
    />
  )
}
