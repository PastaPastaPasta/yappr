'use client'

import { useRouter } from 'next/navigation'
import { CubeIcon } from '@heroicons/react/24/outline'
import { storeItemService } from '@/lib/services/store-item-service'
import { PriceRangeDisplay } from './price-display'
import type { StoreItem } from '@/lib/types'

interface ItemCardProps {
  item: StoreItem
  onClick?: () => void
  showStore?: boolean
}

export function ItemCard({ item, onClick, showStore }: ItemCardProps) {
  const router = useRouter()

  const handleClick = () => {
    if (onClick) {
      onClick()
    } else {
      router.push(`/item?id=${item.id}`)
    }
  }

  const priceRange = storeItemService.getPriceRange(item)
  const isOutOfStock = storeItemService.isOutOfStock(item)

  return (
    <div
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      role="button"
      tabIndex={0}
      className="cursor-pointer group focus:outline-none focus:ring-2 focus:ring-yappr-500 rounded-lg"
    >
      <div className="relative aspect-square bg-surface-100 dark:bg-surface-800 rounded-lg overflow-hidden">
        {item.imageUrls?.[0] ? (
          <img
            src={item.imageUrls[0]}
            alt={item.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <CubeIcon className="h-12 w-12 text-gray-300" />
          </div>
        )}

        {isOutOfStock && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <span className="text-white font-medium text-sm">Out of Stock</span>
          </div>
        )}

        {item.status !== 'active' && !isOutOfStock && (
          <div className="absolute top-2 right-2">
            <span className="px-2 py-1 bg-yellow-500 text-white text-xs rounded-full">
              {item.status}
            </span>
          </div>
        )}
      </div>

      <div className="mt-2">
        <h3 className="font-medium text-sm truncate group-hover:text-yappr-600 transition-colors">
          {item.title}
        </h3>

        {showStore && item.storeName && (
          <p className="text-xs text-gray-500 truncate">
            {item.storeName}
          </p>
        )}

        <PriceRangeDisplay
          minPrice={priceRange.min}
          maxPrice={priceRange.max}
          currency={item.currency}
          size="sm"
          className="mt-0.5"
        />

        {item.variants && item.variants.axes.length > 0 && (
          <p className="text-xs text-gray-400 mt-0.5">
            {item.variants.combinations.length} variants
          </p>
        )}
      </div>
    </div>
  )
}
