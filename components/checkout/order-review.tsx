import { LockClosedIcon, BuildingStorefrontIcon } from '@heroicons/react/24/outline'
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
}

export function OrderReview({
  store,
  items,
  shippingAddress,
  shippingCost,
  subtotal,
  total,
  currency
}: OrderReviewProps) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 text-lg font-medium">
        <LockClosedIcon className="h-5 w-5 text-yappr-500" />
        Review Order
      </div>

      {/* Store */}
      <div className="p-4 bg-gray-50 dark:bg-gray-950 rounded-lg flex items-center gap-3">
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
      <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
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
      <div className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg">
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
        <div className="flex justify-between text-lg font-bold pt-2 border-t border-gray-200 dark:border-gray-800">
          <span>Total</span>
          <span>{formatPrice(total, currency)}</span>
        </div>
      </div>

    </div>
  )
}
