'use client'

import { forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useRouter } from 'next/navigation'
import { BuildingStorefrontIcon } from '@heroicons/react/24/outline'
import { CartItemRow } from './cart-item-row'
import { Button } from '@/components/ui/button'
import { formatPrice } from '@/lib/utils/format'
import { cartService, type CartItemAvailability } from '@/lib/services/cart-service'
import type { CartItem, Store } from '@/lib/types'

interface CartStoreSectionProps {
  storeId: string
  store?: Store
  items: CartItem[]
  availability: CartItemAvailability[]
  isCheckingAvailability: boolean
  onRefreshAvailability: () => void
  onRemoveAll: () => void
}

export const CartStoreSection = forwardRef<HTMLDivElement, CartStoreSectionProps>(
  function CartStoreSection({ storeId, store, items, availability, isCheckingAvailability, onRefreshAvailability, onRemoveAll }, ref) {
    const router = useRouter()

    const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
    const currency = items[0]?.currency || 'USD'
    const hasAvailabilityIssue = availability.some(result => result.reason)

    const handleQuantityChange = (item: CartItem, newQuantity: number) => {
      cartService.updateQuantity(item.itemId, item.variantKey, newQuantity)
    }

    const handleRemoveItem = (item: CartItem) => {
      cartService.removeItem(item.itemId, item.variantKey)
    }

    const handleCheckout = () => {
      router.push(`/checkout?storeId=${storeId}`)
    }

    return (
      <motion.div
        ref={ref}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="pb-4"
    >
      {/* Store Header */}
      <div className="p-4 bg-gray-50 dark:bg-gray-950 flex items-center justify-between">
        <button
          onClick={() => router.push(`/store/view?id=${storeId}`)}
          className="flex items-center gap-2 hover:text-yappr-500"
        >
          {store?.logoUrl ? (
            <img
              src={store.logoUrl}
              alt={store.name}
              className="w-8 h-8 rounded-lg object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded-lg bg-gray-200 dark:bg-gray-800 flex items-center justify-center">
              <BuildingStorefrontIcon className="h-4 w-4 text-gray-400" />
            </div>
          )}
          <span className="font-medium">{store?.name || 'Unknown Store'}</span>
        </button>
        <button
          onClick={onRemoveAll}
          className="text-sm text-red-500 hover:text-red-600"
        >
          Remove all
        </button>
      </div>

      {/* Items */}
      <div className="divide-y divide-gray-100 dark:divide-gray-900">
        <AnimatePresence mode="popLayout">
          {items.map((item) => (
            <CartItemRow
              key={`${item.itemId}-${item.variantKey || ''}`}
              item={item}
              isCheckingAvailability={isCheckingAvailability}
              availability={availability.find(result => result.item.itemId === item.itemId && result.item.variantKey === item.variantKey)}
              onQuantityChange={(qty) => handleQuantityChange(item, qty)}
              onRemove={() => handleRemoveItem(item)}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Store Subtotal & Checkout */}
      <div className="px-4 pt-4 border-t border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between mb-4">
          <span className="font-medium">Subtotal</span>
          <span className="font-bold text-lg">
            {formatPrice(subtotal, currency)}
          </span>
        </div>
        {isCheckingAvailability ? (
          <p role="status" className="mb-4 text-sm text-gray-500">Checking availability...</p>
        ) : hasAvailabilityIssue && (
          <div className="mb-4 text-sm">
            <p role="alert" className="text-red-600">Review item availability before checkout.</p>
            <button className="mt-2 text-yappr-600 underline" onClick={onRefreshAvailability}>Check availability again</button>
          </div>
        )}
        <Button className="w-full" onClick={handleCheckout} disabled={isCheckingAvailability || hasAvailabilityIssue}>
          Checkout from {store?.name || 'Store'}
        </Button>
      </div>
    </motion.div>
    )
  }
)
