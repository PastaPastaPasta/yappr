'use client'

import { useRouter } from 'next/navigation'
import { ShoppingCartIcon } from '@heroicons/react/24/outline'
import { useCartCount } from '@/hooks/use-cart-count'
import { cn } from '@/lib/utils'

interface MobileCartFabProps {
  className?: string
}

export function MobileCartFab({ className }: MobileCartFabProps) {
  const router = useRouter()
  const { count: itemCount, isAnimating } = useCartCount({ animateOnIncrease: true })

  // Don't render if cart is empty
  if (itemCount === 0) {
    return null
  }

  return (
    <button
      onClick={() => router.push('/cart')}
      className={cn(
        "fixed bottom-20 right-4 z-30 md:hidden",
        "flex items-center gap-2 px-4 py-3 rounded-full",
        "bg-yappr-500 text-white shadow-lg",
        "active:scale-95 transition-all duration-200",
        isAnimating && "scale-110",
        className
      )}
      aria-label={`View cart with ${itemCount} items`}
    >
      <ShoppingCartIcon className="h-5 w-5" />
      <span className="font-medium text-sm">
        {itemCount} {itemCount === 1 ? 'item' : 'items'}
      </span>
    </button>
  )
}
