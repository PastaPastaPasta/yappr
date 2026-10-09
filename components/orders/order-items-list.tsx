'use client'

import { DigitalBadge } from '@/components/store/digital-badge'
import { isDigitalOnly } from '@/lib/services/digital-delivery-plan'
import { formatPrice } from '@/lib/utils/format'
import { orderLineSku, orderLineVariantLabel } from '@/lib/storefront/variant-codec'
import type { OrderPayload } from '@/lib/types'

interface OrderItemsListProps {
  items: OrderPayload['items']
  currency: string
  subtotal: number
  shippingCost: number
  total: number
  /** The seller's view: each line's SKU, when the order recorded one. */
  showSku?: boolean
}

export function OrderItemsList({ items, currency, subtotal, shippingCost, total, showSku = false }: OrderItemsListProps) {
  return (
    <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
      <p className="text-sm font-medium mb-2">Items</p>
      <div className="space-y-1">
        {items.map((item, idx) => {
          const variantLabel = orderLineVariantLabel(item)
          const sku = showSku ? orderLineSku(item) : undefined
          return (
          <div key={idx} className="flex justify-between text-sm">
            <span>
              {item.itemTitle}
              {variantLabel && <span className="text-gray-500"> ({variantLabel})</span>}
              <span className="text-gray-500"> x{item.quantity}</span>
              {item.fulfillment === 'digital' && <DigitalBadge className="ml-2 align-middle" />}
              {sku && <span className="block text-xs text-gray-400">SKU {sku}</span>}
            </span>
            <span>{formatPrice(item.unitPrice * item.quantity, currency)}</span>
          </div>
          )
        })}
      </div>
      <div className="border-t border-gray-200 dark:border-gray-700 mt-2 pt-2">
        <div className="flex justify-between text-sm">
          <span>Subtotal</span>
          <span>{formatPrice(subtotal, currency)}</span>
        </div>
        {!(isDigitalOnly(items) && shippingCost === 0) && (
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
