'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChevronDownIcon, ChevronUpIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { governanceService } from '@/lib/services/governance-service'
import type { MasternodeVote, VoteOutcome } from '@/lib/types'

interface GovernanceMNVoteListProps {
  proposalHash: string
  yesCount: number
  noCount: number
  abstainCount: number
  totalMasternodes: number
  className?: string
}

// Vote outcome styling configuration
const outcomeConfig: Record<VoteOutcome, { label: string; className: string }> = {
  yes: {
    label: 'Yes',
    className: 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30',
  },
  no: {
    label: 'No',
    className: 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30',
  },
  abstain: {
    label: 'Abstain',
    className: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800',
  },
}

function VoteSkeleton() {
  return (
    <div className="flex items-center justify-between py-2 px-3 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded" />
        <div className="h-5 w-14 bg-gray-200 dark:bg-gray-800 rounded-full" />
      </div>
      <div className="h-4 w-20 bg-gray-200 dark:bg-gray-800 rounded" />
    </div>
  )
}

export function GovernanceMNVoteList({
  proposalHash,
  yesCount,
  noCount,
  abstainCount,
  totalMasternodes,
  className,
}: GovernanceMNVoteListProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [votes, setVotes] = useState<MasternodeVote[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedHash, setCopiedHash] = useState<string | null>(null)

  const totalVotes = yesCount + noCount + abstainCount
  const votedPercentage = totalMasternodes > 0
    ? Math.round((totalVotes / totalMasternodes) * 100)
    : 0

  // Load votes when expanded
  const loadVotes = useCallback(async () => {
    if (votes.length > 0) return // Already loaded

    setLoading(true)
    setError(null)

    try {
      const fetchedVotes = await governanceService.getVotesForProposal(proposalHash, { limit: 100 })
      // Sort by timestamp descending (newest first)
      const sortedVotes = fetchedVotes.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      setVotes(sortedVotes)
    } catch (err) {
      console.error('Failed to load MN votes:', err)
      setError('Failed to load votes')
    } finally {
      setLoading(false)
    }
  }, [proposalHash, votes.length])

  // Load votes when section is expanded
  useEffect(() => {
    if (isExpanded) {
      void loadVotes()
    }
  }, [isExpanded, loadVotes])

  const handleToggle = () => {
    setIsExpanded(prev => !prev)
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedHash(text)
      setTimeout(() => setCopiedHash(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Truncate hash for display
  const truncateHash = (hash: string, start = 8, end = 8): string => {
    if (hash.length <= start + end) return hash
    return `${hash.slice(0, start)}...${hash.slice(-end)}`
  }

  // Format timestamp
  const formatTime = (date: Date): string => {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className={cn('border-t border-gray-200 dark:border-gray-800', className)}>
      {/* Summary Header - Always visible */}
      <button
        onClick={handleToggle}
        className="w-full p-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
      >
        <div>
          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Masternode Votes
          </h3>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            <span className="text-green-600 dark:text-green-400 font-medium">{yesCount} Yes</span>
            <span className="text-gray-400 mx-1">·</span>
            <span className="text-red-600 dark:text-red-400 font-medium">{noCount} No</span>
            <span className="text-gray-400 mx-1">·</span>
            <span className="text-gray-600 dark:text-gray-400 font-medium">{abstainCount} Abstain</span>
            <span className="text-gray-400 ml-2">
              ({totalVotes.toLocaleString()} of ~{totalMasternodes.toLocaleString()} voted · {votedPercentage}%)
            </span>
          </p>
        </div>
        <div className="shrink-0 ml-4">
          {isExpanded ? (
            <ChevronUpIcon className="h-5 w-5 text-gray-500" />
          ) : (
            <ChevronDownIcon className="h-5 w-5 text-gray-500" />
          )}
        </div>
      </button>

      {/* Expandable Vote List */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-gray-200 dark:border-gray-800">
              {/* Loading State */}
              {loading && (
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <VoteSkeleton key={i} />
                  ))}
                </div>
              )}

              {/* Error State */}
              {error && !loading && (
                <div className="p-4 text-center">
                  <p className="text-sm text-red-500 mb-2">{error}</p>
                  <button
                    onClick={() => {
                      setVotes([])
                      void loadVotes()
                    }}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Empty State */}
              {!loading && !error && votes.length === 0 && (
                <div className="p-4 text-center">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No individual vote records available yet.
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    Vote details are synced by the oracle daemon.
                  </p>
                </div>
              )}

              {/* Vote List */}
              {!loading && !error && votes.length > 0 && (
                <div className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
                  {votes.map((vote, index) => (
                    <motion.div
                      key={vote.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(index * 0.02, 0.2) }}
                      className="flex items-center justify-between py-2 px-4 hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {/* ProTxHash */}
                        <code className="text-xs font-mono text-gray-600 dark:text-gray-400 truncate">
                          {truncateHash(vote.proTxHash)}
                        </code>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            void copyToClipboard(vote.proTxHash)
                          }}
                          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
                          title="Copy ProTxHash"
                        >
                          {copiedHash === vote.proTxHash ? (
                            <CheckIcon className="h-3 w-3 text-green-500" />
                          ) : (
                            <ClipboardDocumentIcon className="h-3 w-3 text-gray-400" />
                          )}
                        </button>

                        {/* Outcome Badge */}
                        <span
                          className={cn(
                            'text-xs font-medium px-2 py-0.5 rounded-full shrink-0',
                            outcomeConfig[vote.outcome].className
                          )}
                        >
                          {outcomeConfig[vote.outcome].label}
                        </span>
                      </div>

                      {/* Timestamp */}
                      <span className="text-xs text-gray-500 dark:text-gray-500 shrink-0 ml-2">
                        {formatTime(vote.timestamp)}
                      </span>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* Show count if more votes exist */}
              {!loading && !error && votes.length > 0 && votes.length < totalVotes && (
                <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-800">
                  <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                    Showing {votes.length} of {totalVotes.toLocaleString()} votes
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
