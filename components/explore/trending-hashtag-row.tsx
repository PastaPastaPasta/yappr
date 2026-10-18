'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import type { TrendingHashtag } from '@/lib/services/hashtag-service'
import { isCashtagStorage, cashtagStorageToDisplay } from '@/lib/post-helpers'
import { prefixRankingsAvailable } from '@/lib/contract-topology'
import { formatNumber } from '@/lib/utils'

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
