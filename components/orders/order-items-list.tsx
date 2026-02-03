'use client'

import { formatPrice } from '@/lib/utils/format'
import type { OrderPayload } from '@/lib/types'

interface OrderItemsListProps {
  items: OrderPayload['items']
  currency: string
  subtotal: number
  shippingCost: number
  total: number
  showShipping?: boolean
}

export function OrderItemsList({ items, currency, subtotal, shippingCost, total, showShipping = true }: OrderItemsListProps) {
  return (
    <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
      <p className="text-sm font-medium mb-2">Items</p>
      <div className="space-y-1">
        {items.map((item, idx) => (
          <div key={idx} className="flex justify-between text-sm">
            <span>
              {item.itemTitle}
              {item.variantKey && <span className="text-gray-500"> ({item.variantKey.replace(/\|/g, ' / ')})</span>}
              <span className="text-gray-500"> x{item.quantity}</span>
            </span>
            <span>{formatPrice(item.unitPrice * item.quantity, currency)}</span>
          </div>
        ))}
      </div>
      <div className="border-t border-gray-200 dark:border-gray-700 mt-2 pt-2">
        <div className="flex justify-between text-sm">
          <span>Subtotal</span>
          <span>{formatPrice(subtotal, currency)}</span>
        </div>
        {showShipping && (
          <div className="flex justify-between text-sm">
            <span>Shipping</span>
            <span>{formatPrice(shippingCost, currency)}</span>
          </div>
        )}
        <div className="flex justify-between font-medium mt-1">
          <span>Total</span>
          <span>{formatPrice(total, currency)}</span>
        </div>
      </div>
    </div>
  )
}
