'use client'

import { useState, useEffect, useMemo, Suspense, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  ShoppingCartIcon,
  BuildingStorefrontIcon
} from '@heroicons/react/24/outline'
import { CheckIcon } from '@heroicons/react/24/solid'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { ImageGallery, QuantityControl } from '@/components/store'
import { formatPrice } from '@/lib/utils/format'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeService } from '@/lib/services/store-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { cartService } from '@/lib/services/cart-service'
import type { Store, StoreItem } from '@/lib/types'

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yappr-500" />
        </main>
      </div>
      <RightSidebar />
    </div>
  )
}

export default function ItemDetailPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ItemDetailContent />
    </Suspense>
  )
}

function ItemDetailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const itemId = searchParams.get('id')
  useAuth() // For optional auth context
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [item, setItem] = useState<StoreItem | null>(null)
  const [store, setStore] = useState<Store | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [quantity, setQuantity] = useState(1)
  const [variantSelections, setVariantSelections] = useState<Record<string, string>>({})
  const [addedToCart, setAddedToCart] = useState(false)
  const [cartItemCount, setCartItemCount] = useState(0)
  const addedToCartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (addedToCartTimeoutRef.current) {
        clearTimeout(addedToCartTimeoutRef.current)
      }
    }
  }, [])

  // Subscribe to cart changes
  useEffect(() => {
    const unsubscribe = cartService.subscribe(() => {
      setCartItemCount(cartService.getItemCount())
    })
    return unsubscribe
  }, [])

  // Load item data
  useEffect(() => {
    if (!sdkReady) return
    if (!itemId) {
      setIsLoading(false)
      return
    }

    const loadItem = async () => {
      try {
        setIsLoading(true)
        const itemData = await storeItemService.get(itemId)
        setItem(itemData)

        if (itemData) {
          const storeData = await storeService.getById(itemData.storeId)
          setStore(storeData)

          // Initialize variant selections with first available option
          if (itemData.variants?.axes) {
            const initialSelections: Record<string, string> = {}
            for (const axis of itemData.variants.axes) {
              if (axis.options.length > 0) {
                initialSelections[axis.name] = axis.options[0]
              }
            }
            setVariantSelections(initialSelections)
          }
        }
      } catch (error) {
        console.error('Failed to load item:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadItem().catch(console.error)
  }, [sdkReady, itemId])

  // Get available options for each axis based on selections
  const axes = useMemo(() => {
    if (!item?.variants?.axes) return []

    return item.variants.axes.map((axis, index) => {
      // For first axis, all options are available
      // For subsequent axes, filter based on prior selections
      const priorSelections: Record<string, string> = {}
      for (let i = 0; i < index; i++) {
        const priorAxis = item.variants!.axes[i]
        if (variantSelections[priorAxis.name]) {
          priorSelections[priorAxis.name] = variantSelections[priorAxis.name]
        }
      }

      const availableOptions = storeItemService.getAxisOptions(item, axis.name, priorSelections)

      return {
        ...axis,
        availableOptions
      }
    })
  }, [item, variantSelections])

  // Build current variant key
  const variantKey = useMemo(() => {
    if (!item?.variants?.axes) return undefined
    return storeItemService.buildVariantKey(variantSelections, item.variants.axes)
  }, [item, variantSelections])

  // Get current combination
  const currentCombination = useMemo(() => {
    if (!item || !variantKey) return null
    return storeItemService.getCombination(item, variantKey)
  }, [item, variantKey])

  // Get current price and stock
  const currentPrice = useMemo(() => {
    if (!item) return 0
    return storeItemService.getPrice(item, variantKey)
  }, [item, variantKey])

  const currentStock = useMemo(() => {
    if (!item) return 0
    return storeItemService.getStock(item, variantKey)
  }, [item, variantKey])

  const hasInventoryTracking = useMemo(() => {
    if (!item) return false
    return storeItemService.hasInventoryTracking(item, variantKey)
  }, [item, variantKey])

  // Get current image (variant-specific or default)
  const images = useMemo(() => {
    if (!item) return []
    const baseImages = item.imageUrls || []

    // If variant has specific image, add it first
    if (currentCombination?.imageUrl) {
      return [currentCombination.imageUrl, ...baseImages.filter(url => url !== currentCombination.imageUrl)]
    }

    return baseImages
  }, [item, currentCombination])

  const handleVariantSelect = (axisName: string, value: string) => {
    setVariantSelections(prev => {
      const newSelections = { ...prev, [axisName]: value }

      // Reset subsequent axis selections if they're no longer valid
      if (item?.variants?.axes) {
        const axisIndex = item.variants.axes.findIndex(a => a.name === axisName)
        for (let i = axisIndex + 1; i < item.variants.axes.length; i++) {
          const nextAxis = item.variants.axes[i]
          const availableOptions = storeItemService.getAxisOptions(item, nextAxis.name, newSelections)
          if (!availableOptions.includes(newSelections[nextAxis.name])) {
            newSelections[nextAxis.name] = availableOptions[0] || ''
          }
        }
      }

      return newSelections
    })
  }

  const handleAddToCart = () => {
    if (!item) return

    cartService.addStoreItem(item, variantKey, quantity)
    setAddedToCart(true)

    // Clear any existing timeout before setting a new one
    if (addedToCartTimeoutRef.current) {
      clearTimeout(addedToCartTimeoutRef.current)
    }
    // Reset after animation
    addedToCartTimeoutRef.current = setTimeout(() => setAddedToCart(false), 2000)
  }

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yappr-500" />
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center p-8">
            <BuildingStorefrontIcon className="h-16 w-16 text-gray-300 mb-4" />
            <p className="text-gray-500 font-medium">Item not found</p>
            <Button className="mt-4" onClick={() => router.push('/store')}>
              Browse Stores
            </Button>
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  const isOutOfStock = hasInventoryTracking && currentStock === 0

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          {/* Header */}
          <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center justify-between p-4">
              <button
                onClick={() => router.back()}
                aria-label="Go back"
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                onClick={() => router.push('/cart')}
                aria-label="View cart"
                className="relative p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <ShoppingCartIcon className="h-6 w-6" aria-hidden="true" />
                {cartItemCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-yappr-500 text-white text-xs rounded-full flex items-center justify-center">
                    {cartItemCount}
                  </span>
                )}
              </button>
            </div>
          </header>

          {/* Image Gallery */}
          <ImageGallery images={images} alt={item.title} />

          {/* Item Info */}
          <div className="p-4 space-y-4">
            {/* Store Link */}
            {store && (
              <button
                onClick={() => router.push(`/store/view?id=${store.id}`)}
                className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
              >
                <BuildingStorefrontIcon className="h-4 w-4" />
                {store.name}
              </button>
            )}

            <h1 className="text-2xl font-bold">{item.title}</h1>

            <p className="text-2xl font-bold text-yappr-600">
              {formatPrice(currentPrice, item.currency)}
            </p>

            {/* Category */}
            {(item.section || item.category) && (
              <div className="text-sm text-gray-500">
                {[item.section, item.category, item.subcategory].filter(Boolean).join(' > ')}
              </div>
            )}

            {/* Variant Selectors */}
            {axes.length > 0 && (
              <div className="space-y-4">
                {axes.map((axis) => (
                  <div key={axis.name}>
                    <label className="block text-sm font-medium mb-2">
                      {axis.name}: <span className="font-normal">{variantSelections[axis.name]}</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {axis.options.map((option) => {
                        const isSelected = variantSelections[axis.name] === option
                        const isAvailable = axis.availableOptions.includes(option)

                        return (
                          <button
                            key={option}
                            onClick={() => isAvailable && handleVariantSelect(axis.name, option)}
                            disabled={!isAvailable}
                            className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                              isSelected
                                ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-900/20 text-yappr-600'
                                : isAvailable
                                  ? 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                                  : 'border-gray-200 dark:border-gray-700 opacity-40 cursor-not-allowed line-through'
                            }`}
                          >
                            {option}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Stock Status */}
            {hasInventoryTracking && (
              <div className={`text-sm ${isOutOfStock ? 'text-red-500' : 'text-green-600'}`}>
                {isOutOfStock ? 'Out of stock' : `${currentStock} in stock`}
              </div>
            )}

            {/* Quantity */}
            {!isOutOfStock && (
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium">Quantity</span>
                <QuantityControl
                  value={quantity}
                  onChange={setQuantity}
                  min={1}
                  max={hasInventoryTracking ? currentStock : 99}
                />
              </div>
            )}

            {/* Add to Cart */}
            <Button
              className="w-full"
              size="lg"
              disabled={isOutOfStock}
              onClick={handleAddToCart}
            >
              {addedToCart ? (
                <motion.span
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex items-center gap-2"
                >
                  <CheckIcon className="h-5 w-5" />
                  Added to Cart
                </motion.span>
              ) : isOutOfStock ? (
                'Out of Stock'
              ) : (
                <>
                  <ShoppingCartIcon className="h-5 w-5 mr-2" />
                  Add to Cart
                </>
              )}
            </Button>

            {/* Description */}
            {item.description && (
              <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
                <h3 className="font-medium mb-2">Description</h3>
                <p className="text-gray-600 dark:text-gray-400 whitespace-pre-wrap">
                  {item.description}
                </p>
              </div>
            )}

            {/* Tags */}
            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-4">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-sm text-gray-600 dark:text-gray-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}
