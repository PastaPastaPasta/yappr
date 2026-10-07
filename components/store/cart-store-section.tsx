'use client'

import { forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useRouter } from 'next/navigation'
import { BuildingStorefrontIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { CartItemRow } from './cart-item-row'
import { Button } from '@/components/ui/button'
import { formatPrice } from '@/lib/utils/format'
import { cartService, getCartCurrency, type CartItemAvailability } from '@/lib/services/cart-service'
import { OWN_STORE_ORDER_MESSAGE, isOwnStore } from '@/lib/storefront/storefront-contract'
import { useAuth } from '@/contexts/auth-context'
import type { BlockSource } from '@/lib/services/block-service'
import type { CartItem, Store } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'

interface CartStoreSectionProps {
  storeId: string
  store?: Store
  /** Set when the viewer blocks the store owner, and by whom. */
  ownerBlock?: BlockSource
  items: CartItem[]
  availability: CartItemAvailability[]
  isCheckingAvailability: boolean
  onRefreshAvailability: () => void
  onRemoveAll: () => void
}

export const CartStoreSection = forwardRef<HTMLDivElement, CartStoreSectionProps>(
  function CartStoreSection({ storeId, store, ownerBlock, items, availability, isCheckingAvailability, onRefreshAvailability, onRemoveAll }, ref) {
    const router = useRouter()
    const { user } = useAuth()

    const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
    // null when this store's lines are priced in different currencies: no single subtotal exists.
    const currency = getCartCurrency(items)
    // A seller never checks out from their own store (storefront v6 refuses it
    // on chain), and a store that is not open takes no orders.
    let checkoutBlocker: string | null = null
    if (isOwnStore(store, user?.identityId)) checkoutBlocker = OWN_STORE_ORDER_MESSAGE
    else if (store !== undefined && store.status !== 'active') checkoutBlocker = 'This store is not accepting orders right now.'
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
            <IpfsImage
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

      {ownerBlock && (
        <div role="alert" className="mx-4 mt-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-center gap-2">
            <ExclamationTriangleIcon className="h-5 w-5 text-amber-500 flex-shrink-0" aria-hidden="true" />
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {ownerBlock === 'own'
                ? 'You have blocked this store owner. Consider removing these items.'
                : 'This store owner is blocked by a block list you follow. Consider removing these items.'}
            </p>
          </div>
        </div>
      )}

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
            {currency ? formatPrice(subtotal, currency) : '—'}
          </span>
        </div>
        {checkoutBlocker && (
          <p role="alert" className="mb-4 text-sm text-red-600">
            {checkoutBlocker}
          </p>
        )}
        {!currency && (
          <p role="alert" className="mb-4 text-sm text-red-600">
            These items are priced in different currencies and cannot be checked out together. Remove the items in one currency to continue.
          </p>
        )}
        {isCheckingAvailability ? (
          <p role="status" className="mb-4 text-sm text-gray-500">Checking availability...</p>
        ) : hasAvailabilityIssue && (
          <div className="mb-4 text-sm">
            <p role="alert" className="text-red-600">Review item availability before checkout.</p>
            <button className="mt-2 text-yappr-600 underline" onClick={onRefreshAvailability}>Check availability again</button>
          </div>
        )}
        <Button className="w-full" onClick={handleCheckout} disabled={isCheckingAvailability || hasAvailabilityIssue || !currency || checkoutBlocker !== null}>
          Checkout from {store?.name || 'Store'}
        </Button>
      </div>
    </motion.div>
    )
  }
)
