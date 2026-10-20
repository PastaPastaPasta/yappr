'use client'

import { windowedRankingFor, type RankingAxis } from '@/lib/contract-topology'
import type { RankingWindow } from '@/lib/services/ranked-likes'

/**
 * Recent | All time — a ranked surface's window switch. "Recent" is the
 * axis's own window ({@link windowedRankingFor}: a UTC day on v9, 24h for
 * trending tags and 3 days for top posts on v10); the span stays out of the
 * label. Renders nothing where the axis has no window (every axis on v2;
 * creators on v10), so every surface can mount it unconditionally and default
 * to `'all'`. The node resolves the window from block time; nothing
 * client-side chooses it.
 */
export function RankingWindowToggle({
  axis,
  value,
  onChange,
  testIdPrefix,
  inline = false,
}: {
  /** The ranked axis the surface reads. */
  axis: RankingAxis
  value: RankingWindow
  onChange: (window: RankingWindow) => void
  /** data-testid prefix; buttons render as `${prefix}-today` / `${prefix}-all`. */
  testIdPrefix: string
  /** Sit right-aligned inside an existing pill row (Latest | Top) instead of adding a row of its own. */
  inline?: boolean
}) {
  if (!windowedRankingFor(axis)) return null
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
    <div
      className={inline ? 'ml-auto flex items-center gap-1' : 'flex items-center gap-1.5 px-4 py-2 border-b border-gray-200 dark:border-gray-800'}
      data-testid={`${testIdPrefix}-window`}
    >
      {option('today', 'Recent')}
      {option('all', 'All time')}
    </div>
  )
}
