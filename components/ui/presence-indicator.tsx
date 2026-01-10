'use client'

import { memo } from 'react'
import { usePresence } from '@/hooks/use-presence'
import * as Tooltip from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

interface PresenceIndicatorProps {
  userId: string
  size?: 'sm' | 'md' | 'lg'
  showTooltip?: boolean
  className?: string
  /** If true, only shows for online/away users (not offline) */
  hideOffline?: boolean
}

const dotSizes = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
  lg: 'h-3 w-3',
}

const statusColors = {
  online: 'bg-green-500',
  away: 'bg-yellow-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-400',
  loading: 'bg-gray-300 animate-pulse',
}

function formatLastSeen(lastSeen: Date | null): string {
  if (!lastSeen) return 'Offline'

  const now = new Date()
  const diffMs = now.getTime() - lastSeen.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return lastSeen.toLocaleDateString()
}

function getStatusLabel(status: string, lastSeen: Date | null, isRecentlyActive: boolean): string {
  switch (status) {
    case 'online':
      return 'Online'
    case 'away':
      return 'Away'
    case 'dnd':
      return 'Do not disturb'
    case 'offline':
      if (isRecentlyActive && lastSeen) {
        return `Active ${formatLastSeen(lastSeen)}`
      }
      return lastSeen ? `Last seen ${formatLastSeen(lastSeen)}` : 'Offline'
    case 'loading':
      return 'Loading...'
    default:
      return 'Offline'
  }
}

export const PresenceIndicator = memo(function PresenceIndicator({
  userId,
  size = 'md',
  showTooltip = true,
  className,
  hideOffline = false,
}: PresenceIndicatorProps) {
  const presence = usePresence(userId)

  // Don't render if hiding offline and user is offline
  if (hideOffline && presence.status === 'offline' && !presence.isRecentlyActive) {
    return null
  }

  // Don't render while loading (avoid flicker)
  if (presence.isLoading) {
    return null
  }

  // Determine the visual status
  let visualStatus = presence.status
  if (presence.status === 'offline' && presence.isRecentlyActive) {
    // Show gray dot for recently active users
    visualStatus = 'offline'
  }

  const dotClass = cn(
    'rounded-full ring-2 ring-white dark:ring-gray-900',
    dotSizes[size],
    statusColors[visualStatus as keyof typeof statusColors] || statusColors.offline,
    className
  )

  const tooltipLabel = getStatusLabel(
    presence.status,
    presence.lastSeen,
    presence.isRecentlyActive
  )

  const dot = <span className={dotClass} />

  if (!showTooltip) {
    return dot
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {dot}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow-md"
            sideOffset={5}
          >
            {tooltipLabel}
            <Tooltip.Arrow className="fill-gray-900" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
})

/**
 * Presence badge with text label
 * Shows "Online", "Away", etc.
 */
interface PresenceBadgeProps {
  userId: string
  showLastSeen?: boolean
  className?: string
}

export const PresenceBadge = memo(function PresenceBadge({
  userId,
  showLastSeen = true,
  className,
}: PresenceBadgeProps) {
  const presence = usePresence(userId)

  if (presence.isLoading) {
    return null
  }

  const label = getStatusLabel(
    presence.status,
    showLastSeen ? presence.lastSeen : null,
    presence.isRecentlyActive
  )

  const badgeColors = {
    online: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    away: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    dnd: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    offline: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        badgeColors[presence.status as keyof typeof badgeColors] || badgeColors.offline,
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', statusColors[presence.status] || statusColors.offline)} />
      {label}
    </span>
  )
})
