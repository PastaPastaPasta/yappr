'use client'

import { windowedRankingFor, type RankingAxis } from '@/lib/contract-topology'
import type { RankingWindow } from '@/lib/services/ranked-likes'

/**
 * <window> | All time — a ranked surface's window switch. The window is the
 * axis's own ({@link windowedRankingFor}): "Today" on v9, "24h" for trending
 * tags and "3 days" for top posts on v10. Renders nothing where the axis has
 * no window (every axis on v2; creators on v10), so every surface can mount it
 * unconditionally and default to `'all'`. The node resolves the window from
 * block time; nothing client-side chooses it.
 */
export function RankingWindowToggle({
  axis,
  value,
  onChange,
  testIdPrefix,
}: {
  /** The ranked axis the surface reads. */
  axis: RankingAxis
  value: RankingWindow
  onChange: (window: RankingWindow) => void
  /** data-testid prefix; buttons render as `${prefix}-today` / `${prefix}-all`. */
  testIdPrefix: string
}) {
  const windowed = windowedRankingFor(axis)
  if (!windowed) return null
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
      {option('today', windowed.label)}
      {option('all', 'All time')}
    </div>
  )
}
