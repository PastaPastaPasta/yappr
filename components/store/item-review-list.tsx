'use client'

import { logger } from '@/lib/logger'
import { useEffect, useState } from 'react'
import { CheckBadgeIcon } from '@heroicons/react/24/solid'
import { RatingStars } from './rating-stars'
import { formatDate } from '@/lib/utils/format'
import { itemReviewService } from '@/lib/services/item-review-service'
import { dpnsService } from '@/lib/services/dpns-service'
import type { ItemReview } from '@/lib/types'

interface ItemReviewListProps {
  itemId: string
  limit?: number
}

/** The newest reviews of one item, with the reviewer's name resolved in one batch. */
export function ItemReviewList({ itemId, limit = 10 }: ItemReviewListProps) {
  const [reviews, setReviews] = useState<ItemReview[]>([])
  const [names, setNames] = useState<Map<string, string | null>>(new Map())
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    itemReviewService.getItemReviews(itemId, { limit })
      .then(({ reviews: loaded }) => {
        if (!active) return
        setReviews(loaded)
        dpnsService.resolveUsernamesBatch(loaded.map((review) => review.reviewerId))
          .then((resolved) => { if (active) setNames(resolved) })
          .catch((error) => logger.warn('Failed to resolve reviewer names:', error))
      })
      .catch((error) => logger.error('Failed to load item reviews:', error))
      .finally(() => { if (active) setIsLoading(false) })
    return () => { active = false }
  }, [itemId, limit])

  if (isLoading) return <p className="text-sm text-gray-500">Loading reviews…</p>
  if (reviews.length === 0) return <p className="text-sm text-gray-500">No reviews yet</p>

  return (
    <ul className="space-y-3">
      {reviews.map((review) => {
        const name = names.get(review.reviewerId)
        return (
          <li key={review.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {name ? `@${name}` : `${review.reviewerId.slice(0, 8)}…`}
              </span>
              <RatingStars rating={review.rating} size="sm" />
              <span className="text-gray-500">{formatDate(review.createdAt)}</span>
              {review.verifiedPurchase && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300">
                  <CheckBadgeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  Verified purchase
                </span>
              )}
            </div>
            {review.content && (
              <p className="mt-1 text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{review.content}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
