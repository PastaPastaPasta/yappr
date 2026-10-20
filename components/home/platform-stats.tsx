'use client'

import { cn, formatNumber } from '@/lib/utils'
import { postListingsCarryLiveMarker } from '@/lib/contract-topology'

interface PlatformStatsProps {
  totalPosts: number
  authorCount: number
  authorCountCapped: boolean
  postsToday: number | null
  loading: boolean
  error: string | null
}

interface Stat {
  label: string
  value: string
}

/**
 * A row of simple counts under the hero. While loading it holds the same
 * cells the numbers will fill, so nothing moves when they land; on error it steps aside
 * (the posts below carry the retry).
 */
export function PlatformStats({
  totalPosts,
  authorCount,
  authorCountCapped,
  postsToday,
  loading,
  error,
}: PlatformStatsProps) {
  if (error) return null

  const stats: Stat[] = [
    { label: 'Posts', value: formatNumber(totalPosts) },
    { label: 'People posting', value: `${formatNumber(authorCount)}${authorCountCapped ? '+' : ''}` },
  ]
  // The cut decides up front whether a daily count exists, so the cell count
  // is the same while loading and after. A read that failed shows a dash.
  if (postListingsCarryLiveMarker()) {
    stats.push({ label: 'Posts today', value: postsToday === null ? '—' : formatNumber(postsToday) })
  }

  return (
    <section aria-label="Yappr in numbers" className="mx-auto mb-10 max-w-xl">
      <dl
        className={cn(
          'grid divide-x divide-gray-200 rounded-2xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800',
          stats.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
        )}
      >
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col-reverse items-center px-2 py-4 text-center">
            <dt className="text-xs text-gray-500 dark:text-gray-400 sm:text-sm">{stat.label}</dt>
            <dd className="mb-1 flex h-8 items-center text-2xl font-bold tabular-nums">
              {loading ? (
                <span aria-hidden="true" className="block h-7 w-12 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
              ) : (
                stat.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
