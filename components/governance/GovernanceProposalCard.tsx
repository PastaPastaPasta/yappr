'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { Proposal } from '@/lib/types'
import { GovernanceStatusBadge } from './GovernanceStatusBadge'
import { GovernanceProgressBar } from './GovernanceProgressBar'
import { CurrencyDollarIcon, LinkIcon } from '@heroicons/react/24/outline'

interface GovernanceProposalCardProps {
  proposal: Proposal
  className?: string
}

export function GovernanceProposalCard({ proposal, className }: GovernanceProposalCardProps) {
  // Format DASH amount with appropriate precision
  const formatDash = (amount: number): string => {
    if (amount >= 1000) {
      return `${(amount / 1000).toFixed(1)}K DASH`
    }
    return `${amount.toLocaleString()} DASH`
  }

  // Safely extract hostname from URL
  const getHostname = (url: string): string | null => {
    try {
      return new URL(url).hostname
    } catch {
      return null
    }
  }

  const hostname = proposal.url ? getHostname(proposal.url) : null

  return (
    <Link
      href={`/governance/${proposal.hash}`}
      className={cn(
        'block p-4 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800',
        'rounded-xl hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors',
        className
      )}
    >
      {/* Header: Name and Status */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 line-clamp-2">
          {proposal.name}
        </h3>
        <GovernanceStatusBadge status={proposal.status} className="shrink-0" />
      </div>

      {/* Amount and Link */}
      <div className="flex items-center gap-4 mb-3 text-sm text-gray-600 dark:text-gray-400">
        <div className="flex items-center gap-1">
          <CurrencyDollarIcon className="h-4 w-4" />
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {formatDash(proposal.paymentAmountDash)}
          </span>
        </div>
        {hostname && (
          <div className="flex items-center gap-1 min-w-0">
            <LinkIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{hostname}</span>
          </div>
        )}
      </div>

      {/* Vote Progress */}
      <GovernanceProgressBar
        yesCount={proposal.yesCount}
        noCount={proposal.noCount}
        abstainCount={proposal.abstainCount}
        fundingThreshold={proposal.fundingThreshold}
      />

      {/* Footer: Threshold info */}
      <div className="mt-3 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>
          {proposal.votesNeeded > 0 ? (
            <span>{proposal.votesNeeded} more votes needed</span>
          ) : (
            <span className="text-green-600 dark:text-green-400">Threshold met</span>
          )}
        </span>
        <span>Epoch {proposal.endEpoch}</span>
      </div>
    </Link>
  )
}
