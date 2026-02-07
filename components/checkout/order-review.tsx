'use client'

import { LockClosedIcon, BuildingStorefrontIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { formatPrice } from '@/lib/utils/format'
import { cartService } from '@/lib/services/cart-service'
import type { CartItem, ShippingAddress, Store } from '@/lib/types'

interface OrderReviewProps {
  store: Store | null
  items: CartItem[]
  shippingAddress: ShippingAddress
  shippingCost: number
  subtotal: number
  total: number
  currency: string
  notes: string
  onNotesChange: (notes: string) => void
  refundAddress: string
  onRefundAddressChange: (addr: string) => void
  paymentScheme?: string
  onSubmit: () => void
  isSubmitting: boolean
}

export function OrderReview({
  store,
  items,
  shippingAddress,
  shippingCost,
  subtotal,
  total,
  currency,
  notes,
  onNotesChange,
  refundAddress,
  onRefundAddressChange,
  paymentScheme,
  onSubmit,
  isSubmitting
}: OrderReviewProps) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 text-lg font-medium">
        <LockClosedIcon className="h-5 w-5 text-yappr-500" />
        Review Order
      </div>

      {/* Store */}
      <div className="p-4 bg-surface-1 dark:bg-surface-2 rounded-lg flex items-center gap-3">
        {store?.logoUrl ? (
          <img src={store.logoUrl} alt={store.name} className="w-10 h-10 rounded-lg object-cover" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-gray-200 dark:bg-gray-800 flex items-center justify-center">
            <BuildingStorefrontIcon className="h-5 w-5 text-gray-400" />
          </div>
        )}
        <span className="font-medium">{store?.name}</span>
      </div>

      {/* Items */}
      <div className="border border-border rounded-lg divide-y divide-border">
        {items.map((item) => (
          <div key={`${item.itemId}-${item.variantKey}`} className="p-3 flex items-center gap-3">
            <div className="w-12 h-12 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
              {item.imageUrl ? (
                <img src={item.imageUrl} alt={item.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <BuildingStorefrontIcon className="h-6 w-6 text-gray-300" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{item.title}</p>
              {item.variantKey && (
                <p className="text-sm text-gray-500">{cartService.getVariantDisplay(item.variantKey)}</p>
              )}
            </div>
            <div className="text-right">
              <p className="font-medium">{formatPrice(item.unitPrice * item.quantity, currency)}</p>
              <p className="text-sm text-gray-500">x{item.quantity}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Shipping Address */}
      <div className="p-4 border border-border rounded-lg">
        <p className="text-sm font-medium text-gray-500 mb-1">Ship to:</p>
        <p>{shippingAddress.name}</p>
        <p>{shippingAddress.street}</p>
        <p>{shippingAddress.city}, {shippingAddress.state} {shippingAddress.postalCode}</p>
        <p>{shippingAddress.country}</p>
      </div>

      {/* Totals */}
      <div className="space-y-2 pt-4">
        <div className="flex justify-between">
          <span className="text-gray-500">Subtotal</span>
          <span>{formatPrice(subtotal, currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Shipping</span>
          <span>{formatPrice(shippingCost, currency)}</span>
        </div>
        <div className="flex justify-between text-lg font-bold pt-2 border-t border-border">
          <span>Total</span>
          <span>{formatPrice(total, currency)}</span>
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="block text-sm font-medium mb-1">Order Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Any special instructions for the seller"
          rows={2}
          className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
        />
      </div>

      {/* Refund Address */}
      <div>
        <label className="block text-sm font-medium mb-1">
          Refund Address (optional){paymentScheme && <span className="text-gray-500 font-normal"> - {paymentScheme}</span>}
        </label>
        <input
          type="text"
          value={refundAddress}
          onChange={(e) => onRefundAddressChange(e.target.value)}
          placeholder={`Your ${paymentScheme || 'crypto'} address for refunds`}
          className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 font-mono text-sm"
        />
      </div>

      <Button
        className="w-full"
        onClick={onSubmit}
        disabled={isSubmitting}
      >
        {isSubmitting ? 'Placing Order...' : 'Place Order'}
      </Button>

      <p className="text-xs text-center text-gray-500">
        Your order details will be encrypted and sent securely to the seller.
      </p>
    </div>
  )
}
