'use client'

import Link from 'next/link'
import { ScaleIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

interface ProposalBadgeProps {
  /** The proposal hash for navigation */
  proposalHash: string
  /** Optional proposal name for tooltip */
  proposalName?: string
  /** Additional className */
  className?: string
  /** Size variant */
  size?: 'sm' | 'md'
}

/**
 * Badge shown on posts that are linked to governance proposals.
 * Clicking the badge navigates to the proposal detail page.
 */
export function ProposalBadge({
  proposalHash,
  proposalName,
  className,
  size = 'sm',
}: ProposalBadgeProps) {
  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5 gap-1',
    md: 'text-sm px-2.5 py-1 gap-1.5',
  }

  const iconSizes = {
    sm: 'h-3 w-3',
    md: 'h-4 w-4',
  }

  return (
    <Link
      href={`/governance/proposal?hash=${proposalHash}`}
      onClick={(e) => e.stopPropagation()}
      title={proposalName ? `View proposal: ${proposalName}` : 'View proposal'}
      className={cn(
        'inline-flex items-center rounded-full font-medium transition-colors',
        'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
        'hover:bg-blue-200 dark:hover:bg-blue-800/50',
        sizeClasses[size],
        className
      )}
    >
      <ScaleIcon className={iconSizes[size]} />
      <span>Proposal</span>
    </Link>
  )
}

interface ProposalClaimBadgeProps {
  /** Whether the claim is verified */
  verified: boolean
  /** Additional className */
  className?: string
}

/**
 * Badge indicating whether a proposal claim is verified or unverified.
 */
export function ProposalClaimBadge({ verified, className }: ProposalClaimBadgeProps) {
  if (verified) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium',
          'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300',
          className
        )}
      >
        <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
            clipRule="evenodd"
          />
        </svg>
        <span>Verified</span>
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium',
        'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
        className
      )}
    >
      <span>Unverified</span>
    </span>
  )
}
