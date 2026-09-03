'use client'

import { windowedRankingsAvailable } from '@/lib/contract-topology'
import type { RankingWindow } from '@/lib/services/ranked-likes'

/**
 * Today | All time — the v6 ranked-surface window switch. Renders nothing on
 * topologies without daily-windowed twins, so every surface can mount it
 * unconditionally and default to `'all'`. `'today'` reads the proved ranking
 * of the current UTC day (`newest` bucket, resolved from block time by the
 * node — nothing client-side chooses the window).
 */
export function RankingWindowToggle({
  value,
  onChange,
  testIdPrefix,
}: {
  value: RankingWindow
  onChange: (window: RankingWindow) => void
  /** data-testid prefix; buttons render as `${prefix}-today` / `${prefix}-all`. */
  testIdPrefix: string
}) {
  if (!windowedRankingsAvailable()) return null
  const option = (window: RankingWindow, label: string) => (
    <button
      onClick={() => onChange(window)}
      data-testid={`${testIdPrefix}-${window}`}
      aria-pressed={value === window}
      className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
        value === window
          ? 'bg-yappr-500 text-white'
          : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-gray-200 dark:border-gray-800" data-testid={`${testIdPrefix}-window`}>
      {option('today', 'Today')}
      {option('all', 'All time')}
    </div>
  )
}
