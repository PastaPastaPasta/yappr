'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import type { TrendingHashtag } from '@/lib/services/hashtag-service'
import { isCashtagStorage, cashtagStorageToDisplay } from '@/lib/post-helpers'
import { prefixRankingsAvailable } from '@/lib/contract-topology'
import { formatNumber } from '@/lib/utils'

/** Loading rows the same height as {@link TrendingHashtagRow}, so the list doesn't jump when it arrives. */
export function TrendingHashtagRowSkeleton({ count, testId }: { count: number; testId?: string }) {
  return (
    <div data-testid={testId} aria-busy="true" aria-label="Loading" className="divide-y divide-gray-200 dark:divide-gray-800">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="p-4">
          <div className="flex items-center gap-3">
            <span className="w-6" />
            <div className="flex-1">
              <div className="flex h-6 items-center"><div className="h-4 w-32 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" /></div>
              <div className="flex h-5 items-center"><div className="h-3 w-16 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" /></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function TrendingHashtagRow({ trend, index }: { trend: TrendingHashtag; index: number }) {
  const isCashtag = isCashtagStorage(trend.hashtag)
  const displayTag = isCashtag ? cashtagStorageToDisplay(trend.hashtag) : trend.hashtag
  const unit = prefixRankingsAvailable() ? 'like' : 'post'
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}>
      <Link href={`/hashtag?tag=${encodeURIComponent(trend.hashtag)}`} className="block w-full p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-yappr-600 focus-visible:-outline-offset-2">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400 w-6">#{index + 1}</span>
          <div className="flex-1">
            <p className="font-bold text-yappr-500 hover:underline">{isCashtag ? '$' : '#'}{displayTag}</p>
            <p className="text-sm text-gray-500">{formatNumber(trend.postCount)} {unit}{trend.postCount === 1 ? '' : 's'}</p>
          </div>
        </div>
      </Link>
    </motion.div>
  )
}
