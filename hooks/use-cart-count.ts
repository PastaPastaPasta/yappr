import { useState, useEffect, useRef } from 'react'
import { cartService } from '@/lib/services/cart-service'

interface UseCartCountOptions {
  animateOnIncrease?: boolean
}

interface UseCartCountResult {
  count: number
  isAnimating: boolean
}

/**
 * Hook to subscribe to cart item count changes.
 * Optionally provides animation state when count increases.
 */
export function useCartCount(options: UseCartCountOptions = {}): UseCartCountResult {
  const { animateOnIncrease = false } = options
  const [count, setCount] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const prevCountRef = useRef(0)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Initialize from current cart state
    const initialCount = cartService.getItemCount()
    prevCountRef.current = initialCount
    setCount(initialCount)

    const unsubscribe = cartService.subscribe(() => {
      const newCount = cartService.getItemCount()

      if (animateOnIncrease && newCount > prevCountRef.current) {
        // Clear any existing animation timer
        if (animationTimerRef.current) {
          clearTimeout(animationTimerRef.current)
        }
        setIsAnimating(true)
        animationTimerRef.current = setTimeout(() => setIsAnimating(false), 300)
      }

      prevCountRef.current = newCount
      setCount(newCount)
    })

    return () => {
      unsubscribe()
      // Clear animation timer on cleanup
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current)
      }
    }
  }, [animateOnIncrease])

  return { count, isAnimating }
}
