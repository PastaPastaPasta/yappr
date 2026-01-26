'use client'

import { forwardRef } from 'react'
import { motion } from 'framer-motion'
import { TrashIcon, BuildingStorefrontIcon } from '@heroicons/react/24/outline'
import { QuantityControl } from './quantity-control'
import { formatPrice } from '@/lib/utils/format'
import { cartService } from '@/lib/services/cart-service'
import type { CartItem } from '@/lib/types'

interface CartItemRowProps {
  item: CartItem
  onQuantityChange: (quantity: number) => void
  onRemove: () => void
}

export const CartItemRow = forwardRef<HTMLDivElement, CartItemRowProps>(
  function CartItemRow({ item, onQuantityChange, onRemove }, ref) {
    const handleQuantityChange = (newQuantity: number) => {
      if (newQuantity <= 0) {
        onRemove()
      } else {
        onQuantityChange(newQuantity)
      }
    }

    return (
      <motion.div
        ref={ref}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="p-4 flex gap-4"
    >
      {/* Image */}
      <div className="w-20 h-20 bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden flex-shrink-0">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <BuildingStorefrontIcon className="h-8 w-8 text-gray-300" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-medium truncate">{item.title}</h3>
        {item.variantKey && (
          <p className="text-sm text-gray-500">
            {cartService.getVariantDisplay(item.variantKey)}
          </p>
        )}
        <p className="text-yappr-600 font-medium mt-1">
          {formatPrice(item.unitPrice, item.currency)}
        </p>

        {/* Quantity Controls */}
        <div className="flex items-center gap-2 mt-2">
          <QuantityControl
            value={item.quantity}
            onChange={handleQuantityChange}
            min={0}
            size="sm"
          />
          <button
            onClick={onRemove}
            className="p-1 ml-2 text-red-500 hover:text-red-600"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Line Total */}
      <div className="text-right">
        <p className="font-medium">
          {formatPrice(item.unitPrice * item.quantity, item.currency)}
        </p>
      </div>
    </motion.div>
    )
  }
)
