'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { AnimatePresence } from 'framer-motion'
import {
  ArrowLeftIcon,
  ShoppingCartIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { CartStoreSection } from '@/components/store'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { cartService } from '@/lib/services/cart-service'
import { storeService } from '@/lib/services/store-service'
import type { Cart, Store } from '@/lib/types'

export default function CartPage() {
  const router = useRouter()
  useAuth() // For route protection
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [cart, setCart] = useState<Cart>({ items: [], updatedAt: new Date() })
  const [stores, setStores] = useState<Map<string, Store>>(new Map())
  const [isLoading, setIsLoading] = useState(true)

  // Subscribe to cart changes
  useEffect(() => {
    const unsubscribe = cartService.subscribe((newCart) => {
      setCart(newCart)
    })
    return unsubscribe
  }, [])

  // Load store info for cart items
  useEffect(() => {
    if (!sdkReady) return
    const loadStores = async () => {
      setIsLoading(true)
      const storeIds = cartService.getStoreIds()
      const storeMap = new Map<string, Store>()

      await Promise.all(
        storeIds.map(async (storeId) => {
          try {
            const store = await storeService.getById(storeId)
            if (store) {
              storeMap.set(storeId, store)
            }
          } catch (e) {
            // Ignore errors
          }
        })
      )

      setStores(storeMap)
      setIsLoading(false)
    }

    loadStores().catch(console.error)
  }, [sdkReady, cart.items.length])

  // Group items by store
  const itemsByStore = new Map<string, typeof cart.items>()
  for (const item of cart.items) {
    const existing = itemsByStore.get(item.storeId) || []
    itemsByStore.set(item.storeId, [...existing, item])
  }

  const isEmpty = cart.items.length === 0

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center gap-4 p-4">
              <button
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-bold flex items-center gap-2">
                <ShoppingCartIcon className="h-6 w-6" />
                Cart ({cartService.getItemCount()})
              </h1>
            </div>
          </header>

          {isLoading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yappr-500 mx-auto mb-4" />
              <p className="text-gray-500">Loading cart...</p>
            </div>
          ) : isEmpty ? (
            <div className="p-8 text-center">
              <ShoppingCartIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500 font-medium">Your cart is empty</p>
              <p className="text-sm text-gray-400 mt-1">Add some items to get started</p>
              <Button className="mt-4" onClick={() => router.push('/store')}>
                Browse Stores
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              <AnimatePresence mode="popLayout">
                {Array.from(itemsByStore.entries()).map(([storeId, storeItems]) => (
                  <CartStoreSection
                    key={storeId}
                    storeId={storeId}
                    store={stores.get(storeId)}
                    items={storeItems}
                    onRemoveAll={() => cartService.removeStoreItems(storeId)}
                  />
                ))}
              </AnimatePresence>

              {/* Clear All */}
              {cart.items.length > 0 && (
                <div className="p-4">
                  <button
                    onClick={() => cartService.clearCart()}
                    className="w-full py-2 text-center text-red-500 hover:text-red-600 text-sm"
                  >
                    Clear entire cart
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}
