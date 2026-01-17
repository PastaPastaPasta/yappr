'use client'

import { ArrowTopRightOnSquareIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { Proposal } from '@/lib/types'
import { GovernanceStatusBadge } from './GovernanceStatusBadge'
import { GovernanceProgressBar } from './GovernanceProgressBar'

interface GovernanceProposalDetailProps {
  proposal: Proposal
  className?: string
}

export function GovernanceProposalDetail({ proposal, className }: GovernanceProposalDetailProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Format DASH amount
  const formatDash = (amount: number): string => {
    return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })} DASH`
  }

  // Truncate hash for display
  const truncateHash = (hash: string, start = 8, end = 8): string => {
    if (hash.length <= start + end) return hash
    return `${hash.slice(0, start)}...${hash.slice(-end)}`
  }

  return (
    <div className={cn('divide-y divide-gray-200 dark:divide-gray-800', className)}>
      {/* Header Section */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {proposal.name}
          </h2>
          <GovernanceStatusBadge status={proposal.status} className="shrink-0 text-sm" />
        </div>

        {/* URL Link */}
        {proposal.url && (
          <a
            href={proposal.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-blue-600 dark:text-blue-400 hover:underline mb-4"
          >
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            <span className="break-all">{proposal.url}</span>
          </a>
        )}
      </div>

      {/* Payment Info */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Payment Details
        </h3>
        <div className="space-y-3">
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Amount</span>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {formatDash(proposal.paymentAmountDash)}
            </p>
          </div>
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Payment Address</span>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-sm font-mono text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded break-all">
                {proposal.paymentAddress}
              </code>
              <button
                onClick={() => copyToClipboard(proposal.paymentAddress, 'address')}
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
                title="Copy address"
              >
                {copiedField === 'address' ? (
                  <CheckIcon className="h-4 w-4 text-green-500" />
                ) : (
                  <ClipboardDocumentIcon className="h-4 w-4 text-gray-500" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Vote Progress Section */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Voting Progress
        </h3>

        <GovernanceProgressBar
          yesCount={proposal.yesCount}
          noCount={proposal.noCount}
          abstainCount={proposal.abstainCount}
          fundingThreshold={proposal.fundingThreshold}
          showCounts
        />

        {/* Vote Statistics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Yes Votes</span>
            <p className="text-lg font-semibold text-green-600 dark:text-green-400">{proposal.yesCount}</p>
          </div>
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">No Votes</span>
            <p className="text-lg font-semibold text-red-600 dark:text-red-400">{proposal.noCount}</p>
          </div>
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Abstain</span>
            <p className="text-lg font-semibold text-gray-600 dark:text-gray-400">{proposal.abstainCount}</p>
          </div>
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Net Votes</span>
            <p className={cn(
              'text-lg font-semibold',
              proposal.netVotes >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            )}>
              {proposal.netVotes >= 0 ? '+' : ''}{proposal.netVotes}
            </p>
          </div>
        </div>

        {/* Threshold Info */}
        <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">
              Funding Threshold
            </span>
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {proposal.fundingThreshold} net votes required
            </span>
          </div>
          <div className="flex items-center justify-between text-sm mt-1">
            <span className="text-gray-600 dark:text-gray-400">
              Status
            </span>
            <span className={cn(
              'font-medium',
              proposal.votesNeeded <= 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-900 dark:text-gray-100'
            )}>
              {proposal.votesNeeded <= 0
                ? 'Threshold met'
                : `${proposal.votesNeeded} more votes needed`}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm mt-1">
            <span className="text-gray-600 dark:text-gray-400">
              Total Masternodes
            </span>
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {proposal.totalMasternodes.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Epoch & Timeline Info */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Timeline
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Start Epoch</span>
            <p className="text-lg font-medium text-gray-900 dark:text-gray-100">{proposal.startEpoch}</p>
          </div>
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">End Epoch</span>
            <p className="text-lg font-medium text-gray-900 dark:text-gray-100">{proposal.endEpoch}</p>
          </div>
          {proposal.createdAtBlockHeight && (
            <div>
              <span className="text-sm text-gray-500 dark:text-gray-400">Created at Block</span>
              <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {proposal.createdAtBlockHeight.toLocaleString()}
              </p>
            </div>
          )}
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Last Updated</span>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {proposal.lastUpdatedAt.toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      {/* Technical Details */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Technical Details
        </h3>
        <div className="space-y-3">
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Proposal Hash</span>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-xs font-mono text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded break-all">
                {proposal.hash}
              </code>
              <button
                onClick={() => copyToClipboard(proposal.hash, 'hash')}
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
                title="Copy hash"
              >
                {copiedField === 'hash' ? (
                  <CheckIcon className="h-4 w-4 text-green-500" />
                ) : (
                  <ClipboardDocumentIcon className="h-4 w-4 text-gray-500" />
                )}
              </button>
            </div>
          </div>
          {proposal.collateralHash && (
            <div>
              <span className="text-sm text-gray-500 dark:text-gray-400">Collateral Hash</span>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                  {truncateHash(proposal.collateralHash)}
                </code>
                <button
                  onClick={() => copyToClipboard(proposal.collateralHash ?? '', 'collateral')}
                  className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
                  title="Copy collateral hash"
                >
                  {copiedField === 'collateral' ? (
                    <CheckIcon className="h-4 w-4 text-green-500" />
                  ) : (
                    <ClipboardDocumentIcon className="h-4 w-4 text-gray-500" />
                  )}
                </button>
              </div>
            </div>
          )}
          <div>
            <span className="text-sm text-gray-500 dark:text-gray-400">Object Type</span>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {proposal.gobjectType === 1 ? 'Proposal' : proposal.gobjectType === 2 ? 'Trigger' : 'Watchdog'}
            </p>
          </div>
        </div>
      </div>

      {/* Placeholder: Community Support (Phase 3) */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Community Support
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          Community sentiment will be available once proposal claims are implemented.
        </p>
      </div>

      {/* Placeholder: Discussion (Phase 3) */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Discussion
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          Proposal discussion will be available once claims and linked posts are implemented.
        </p>
      </div>
    </div>
  )
}
