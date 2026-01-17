'use client'

import { cn } from '@/lib/utils'

interface GovernanceProgressBarProps {
  yesCount: number
  noCount: number
  abstainCount: number
  fundingThreshold: number
  className?: string
  showCounts?: boolean
}

export function GovernanceProgressBar({
  yesCount,
  noCount,
  abstainCount,
  fundingThreshold,
  className,
  showCounts = false,
}: GovernanceProgressBarProps) {
  const totalVotes = yesCount + noCount + abstainCount
  const netVotes = yesCount - noCount

  // Calculate percentages for the bar segments
  const yesPercent = totalVotes > 0 ? (yesCount / totalVotes) * 100 : 0
  const noPercent = totalVotes > 0 ? (noCount / totalVotes) * 100 : 0

  // Calculate progress toward funding threshold
  const thresholdProgress = fundingThreshold > 0 ? Math.min(100, (netVotes / fundingThreshold) * 100) : 0
  const isPassing = netVotes >= fundingThreshold

  return (
    <div className={cn('space-y-1', className)}>
      {/* Vote bar showing yes/no ratio */}
      <div className="relative h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        {totalVotes > 0 ? (
          <>
            {/* Yes votes (green) */}
            <div
              className="absolute left-0 top-0 h-full bg-green-500 transition-all duration-300"
              style={{ width: `${yesPercent}%` }}
            />
            {/* No votes (red) - positioned after yes */}
            <div
              className="absolute top-0 h-full bg-red-500 transition-all duration-300"
              style={{ left: `${yesPercent}%`, width: `${noPercent}%` }}
            />
            {/* Abstain votes take the remaining gray space */}
          </>
        ) : (
          <div className="h-full w-full" />
        )}
      </div>

      {/* Optional counts display */}
      {showCounts && (
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
          <div className="flex gap-3">
            <span className="text-green-600 dark:text-green-400">{yesCount} Yes</span>
            <span className="text-red-600 dark:text-red-400">{noCount} No</span>
            {abstainCount > 0 && (
              <span className="text-gray-500 dark:text-gray-400">{abstainCount} Abstain</span>
            )}
          </div>
          <span className={cn(isPassing ? 'text-green-600 dark:text-green-400' : '')}>
            {netVotes >= 0 ? '+' : ''}{netVotes} net
          </span>
        </div>
      )}

      {/* Threshold progress indicator */}
      {!showCounts && (
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{totalVotes} votes</span>
          <span className={cn(isPassing ? 'text-green-600 dark:text-green-400' : '')}>
            {Math.round(thresholdProgress)}% to threshold
          </span>
        </div>
      )}
    </div>
  )
}
