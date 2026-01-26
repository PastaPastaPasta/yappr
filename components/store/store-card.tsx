'use client'

import { useRouter } from 'next/navigation'
import { BuildingStorefrontIcon, MapPinIcon } from '@heroicons/react/24/outline'
import { RatingStars } from './rating-stars'
import type { Store, StoreRatingSummary } from '@/lib/types'

interface StoreCardProps {
  store: Store
  rating?: StoreRatingSummary
  onClick?: () => void
}

export function StoreCard({ store, rating, onClick }: StoreCardProps) {
  const router = useRouter()

  const handleClick = () => {
    if (onClick) {
      onClick()
    } else {
      router.push(`/store/view?id=${store.id}`)
    }
  }

  return (
    <div
      onClick={handleClick}
      className="p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors cursor-pointer border-b border-gray-200 dark:border-gray-800 last:border-b-0"
    >
      <div className="flex gap-4">
        {/* Store Logo */}
        <div className="flex-shrink-0 w-16 h-16 rounded-lg bg-gray-200 dark:bg-gray-800 overflow-hidden">
          {store.logoUrl ? (
            <img
              src={store.logoUrl}
              alt={store.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <BuildingStorefrontIcon className="h-8 w-8 text-gray-400" />
            </div>
          )}
        </div>

        {/* Store Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-gray-900 dark:text-white truncate">
              {store.name}
            </h3>
            {rating && rating.reviewCount > 0 && (
              <RatingStars
                rating={rating.averageRating}
                reviewCount={rating.reviewCount}
                size="sm"
              />
            )}
          </div>

          {store.description && (
            <p className="text-sm text-gray-500 mt-1 line-clamp-2">
              {store.description}
            </p>
          )}

          {store.location && (
            <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
              <MapPinIcon className="h-3 w-3" />
              {store.location}
            </div>
          )}

          {/* Status badge */}
          {store.status !== 'active' && (
            <span className={`inline-block mt-2 px-2 py-0.5 rounded-full text-xs font-medium ${
              store.status === 'paused'
                ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400'
                : 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400'
            }`}>
              {store.status === 'paused' ? 'Paused' : 'Closed'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
