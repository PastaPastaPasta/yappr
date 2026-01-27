'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ShoppingCartIcon } from '@heroicons/react/24/outline'
import { cartService } from '@/lib/services/cart-service'
import { cn } from '@/lib/utils'

interface MobileCartFabProps {
  className?: string
}

export function MobileCartFab({ className }: MobileCartFabProps) {
  const router = useRouter()
  const [itemCount, setItemCount] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const [prevCount, setPrevCount] = useState(0)

  useEffect(() => {
    setItemCount(cartService.getItemCount())

    const unsubscribe = cartService.subscribe(() => {
      const newCount = cartService.getItemCount()
      if (newCount > prevCount) {
        setIsAnimating(true)
        setTimeout(() => setIsAnimating(false), 300)
      }
      setPrevCount(newCount)
      setItemCount(newCount)
    })

    return unsubscribe
  }, [prevCount])

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
