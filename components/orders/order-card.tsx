'use client'

import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { ChevronDownIcon, ChevronUpIcon, BuildingStorefrontIcon, StarIcon } from '@heroicons/react/24/outline'
import { OrderStatusBadge } from '@/components/store/order-status-badge'
import { OrderItemsList } from './order-items-list'
import { Button } from '@/components/ui/button'
import { formatPrice, formatDate, formatOrderId } from '@/lib/utils/format'
import { orderStatusService } from '@/lib/services/order-status-service'
import type { StoreOrder, OrderPayload, OrderStatusUpdate, Store } from '@/lib/types'

interface OrderCardProps {
  order: StoreOrder
  payload?: OrderPayload
  status?: OrderStatusUpdate
  store?: Store
  expanded: boolean
  onToggle: () => void
  index?: number
  canReview?: boolean
  onLeaveReview?: () => void
}

export function OrderCard({
  order,
  payload,
  status,
  store,
  expanded,
  onToggle,
  index = 0,
  canReview = false,
  onLeaveReview
}: OrderCardProps) {
  const router = useRouter()

  const handleStoreClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    router.push(`/store/view?id=${order.storeId}`)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className="p-4"
    >
      <button
        onClick={onToggle}
        className="w-full text-left"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3 flex-1 min-w-0">
            <button
              onClick={handleStoreClick}
              className="w-12 h-12 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0 hover:ring-2 hover:ring-yappr-500 transition-all"
            >
              {store?.logoUrl ? (
                <img src={store.logoUrl} alt={store.name} className="w-full h-full rounded-lg object-cover" />
              ) : (
                <BuildingStorefrontIcon className="h-6 w-6 text-gray-400" />
              )}
            </button>
            <div className="flex-1 min-w-0">
              <button
                onClick={handleStoreClick}
                className="font-medium truncate hover:text-yappr-500 transition-colors text-left"
              >
                {store?.name || 'Unknown Store'}
              </button>
              <p className="text-sm text-gray-500">
                Order #{formatOrderId(order.id)}
                {payload && <span className="ml-2">{formatPrice(payload.total, payload.currency)}</span>}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {formatDate(order.createdAt)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <OrderStatusBadge status={status?.status} />
            {expanded ? (
              <ChevronUpIcon className="h-5 w-5 text-gray-400" />
            ) : (
              <ChevronDownIcon className="h-5 w-5 text-gray-400" />
            )}
          </div>
        </div>
      </button>

      {/* Expanded Details */}
      {expanded && payload && (
        <div className="mt-4 space-y-3">
          <OrderItemsList
            items={payload.items}
            currency={payload.currency}
            subtotal={payload.subtotal}
            shippingCost={payload.shippingCost}
            total={payload.total}
          />

          {/* Shipping Address */}
          <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
            <p className="text-sm font-medium mb-1">Ships to</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {payload.shippingAddress.name}, {payload.shippingAddress.city}, {payload.shippingAddress.country}
            </p>
          </div>
        </div>
      )}

      {status?.trackingNumber && (
        <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
          <p className="text-sm text-gray-500">Tracking:</p>
          <p className="font-mono text-sm">
            {status.trackingCarrier && `${status.trackingCarrier}: `}
            {status.trackingNumber}
          </p>
          {status.trackingCarrier && (
            <a
              href={orderStatusService.getTrackingUrl(status.trackingCarrier, status.trackingNumber) || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-yappr-500 hover:underline mt-1 inline-block"
            >
              Track Package
            </a>
          )}
        </div>
      )}

      {status?.message && (
        <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {status.message}
          </p>
        </div>
      )}

      {canReview && expanded && (
        <div className="mt-3">
          <Button
            onClick={(e) => {
              e.stopPropagation()
              onLeaveReview?.()
            }}
            variant="outline"
            size="sm"
          >
            <StarIcon className="h-4 w-4 mr-1.5" />
            Leave Review
          </Button>
        </div>
      )}
    </motion.div>
  )
}
