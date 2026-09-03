'use client'

import { logger } from '@/lib/logger'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FireIcon } from '@heroicons/react/24/outline'
import { formatNumber } from '@/lib/utils'
import { hashtagService, type TrendingHashtag } from '@/lib/services/hashtag-service'
import { getTagDisplayText } from '@/lib/post-helpers'
import { prefixRankingsAvailable } from '@/lib/contract-topology'

/** Rows shown in the box. */
const TRENDING_LIMIT = 8
/**
 * Rows requested from the service. The hashtag service caches the first page
 * it fetches per window and slices later callers from it, and this box mounts
 * on nearly every page — so it asks for as many rows as the Explore Trending
 * tab does and trims locally, rather than leaving Explore a short cache.
 */
const TRENDING_FETCH_LIMIT = 12

/**
 * The right-sidebar trending box: the same ranking the Explore Trending tab
 * shows (a proved per-tag like ranking on v5+, a client-derived sample of
 * recent posts before that), all-time window, trimmed to a short list. Reads
 * are served from the hashtag service's 5-minute cache, so mounting this on
 * every page costs one ranked query per cache window.
 */
export function TrendingHashtags() {
  const [trending, setTrending] = useState<TrendingHashtag[] | null>(null)

  useEffect(() => {
    let cancelled = false
    hashtagService
      .getTrendingHashtags({ timeWindowHours: 168, minPosts: 1, limit: TRENDING_FETCH_LIMIT, window: 'all' })
      .then((tags) => {
        if (!cancelled) setTrending(tags.slice(0, TRENDING_LIMIT))
      })
      .catch((error) => {
        logger.error('Failed to load sidebar trending hashtags:', error)
        if (!cancelled) setTrending([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="bg-gray-50 dark:bg-gray-950 rounded-2xl overflow-hidden" data-testid="sidebar-trending">
      <h2 className="text-xl font-bold px-4 py-3 flex items-center gap-2">
        <FireIcon className="h-5 w-5 text-yappr-500" />
        Trending
      </h2>
      <TrendingBody trending={trending} />
    </div>
  )
}

function TrendingBody({ trending }: { trending: TrendingHashtag[] | null }) {
  if (trending === null) {
    return (
      <div className="px-4 pb-3 space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-4 w-28 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-3 w-16 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        ))}
      </div>
    )
  }

  if (trending.length === 0) {
    return <p className="px-4 pb-4 text-sm text-gray-500">No trending tags yet</p>
  }

  // v5's proved ranking counts LIKES on tagged posts; earlier topologies count posts.
  const unit = prefixRankingsAvailable() ? 'like' : 'post'

  return (
    <ul>
      {trending.map((trend, index) => (
        <li key={trend.hashtag}>
          <Link
            href={`/hashtag?tag=${encodeURIComponent(trend.hashtag)}`}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
          >
            <span className="text-xs text-gray-400 w-4 shrink-0">{index + 1}</span>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{getTagDisplayText(trend.hashtag)}</p>
              <p className="text-xs text-gray-500">
                {formatNumber(trend.postCount)} {trend.postCount === 1 ? unit : `${unit}s`}
              </p>
            </div>
          </Link>
        </li>
      ))}
      <li>
        <Link
          href="/explore"
          className="block px-4 py-3 text-sm text-yappr-500 hover:text-yappr-600 dark:hover:text-yappr-400 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
        >
          Show more
        </Link>
      </li>
    </ul>
  )
}
