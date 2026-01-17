'use client'

import { cn } from '@/lib/utils'
import type { ProposalStatus } from '@/lib/types'

interface GovernanceStatusBadgeProps {
  status: ProposalStatus
  className?: string
}

const statusConfig: Record<ProposalStatus, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300',
  },
  passed: {
    label: 'Passed',
    className: 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300',
  },
  funded: {
    label: 'Funded',
    className: 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300',
  },
  expired: {
    label: 'Expired',
    className: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  },
}

export function GovernanceStatusBadge({ status, className }: GovernanceStatusBadgeProps) {
  const config = statusConfig[status]

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
        config.className,
        className
      )}
    >
      {config.label}
    </span>
  )
}
