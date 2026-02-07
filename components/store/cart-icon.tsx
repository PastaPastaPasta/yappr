'use client'

import { useRouter } from 'next/navigation'
import { ShoppingCartIcon } from '@heroicons/react/24/outline'
import { useCartCount } from '@/hooks/use-cart-count'

interface CartIconProps {
  className?: string
}

export function CartIcon({ className }: CartIconProps) {
  const router = useRouter()
  const { count: itemCount } = useCartCount()

  return (
    <button
      onClick={() => router.push('/cart')}
      className={`relative p-2 rounded-full hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors ${className || ''}`}
      aria-label={`Shopping cart with ${itemCount} items`}
    >
      <ShoppingCartIcon className="h-6 w-6" />
      {itemCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 bg-yappr-500 text-white text-xs font-medium rounded-full flex items-center justify-center">
          {itemCount > 99 ? '99+' : itemCount}
        </span>
      )}
    </button>
  )
}
