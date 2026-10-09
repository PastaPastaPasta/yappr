'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useMemo, Suspense, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  ShoppingCartIcon,
  BuildingStorefrontIcon,
  CloudArrowDownIcon
} from '@heroicons/react/24/outline'
import { CheckIcon } from '@heroicons/react/24/solid'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ImageGallery, QuantityControl, MobileCartFab, RatingStars, ItemReviewList, BlockedOwnerBanner } from '@/components/store'
import { formatPrice } from '@/lib/utils/format'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { storeService } from '@/lib/services/store-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { cartService } from '@/lib/services/cart-service'
import { storeStatsService } from '@/lib/services/store-stats-service'
import { storefrontIsV2 } from '@/lib/constants'
import { OWN_STORE_ORDER_MESSAGE, isOwnStore } from '@/lib/storefront/storefront-contract'
import { combinationForSelection, combinationImageUrl, isInStock, selectableOptionIds } from '@/lib/storefront/variant-codec'
import type { Store, StoreItem, ItemRatingSummary, ItemVariants } from '@/lib/types'

/**
 * Why `item` cannot be bought, or null when it can: the viewer's own store, a
 * sold-out, paused or deleted listing, or a store that is not open.
 */
function unavailableReasonFor(item: StoreItem, store: Store | null, viewerId: string | undefined): string | null {
  if (isOwnStore(store, viewerId)) return OWN_STORE_ORDER_MESSAGE
  if (item.status === 'sold_out') return 'This item is sold out'
  if (item.status !== 'active') return 'This item is no longer available'
  if (store && store.status !== 'active') return `This store is ${store.status === 'closed' ? 'closed' : 'paused'} and is not accepting orders`
  return null
}

/** The picker's starting choice, one entry per axis: an axis with a single option starts on it. */
function initialSelection(variants: ItemVariants | undefined): Array<number | undefined> {
  return variants?.axes.map((axis) => (axis.options.length === 1 ? axis.options[0].id : undefined)) ?? []
}

/** One price, or the lowest and highest when they differ. */
function formatPriceRange({ min, max }: { min: number; max: number }, currency: string | undefined): string {
  return min === max ? formatPrice(min, currency) : `${formatPrice(min, currency)} – ${formatPrice(max, currency)}`
}

function LoadingFallback() {
  return (
    <PageShell mainClassName="flex items-center justify-center">
          <Spinner size="md" />
    </PageShell>
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
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()

  const [item, setItem] = useState<StoreItem | null>(null)
  const [store, setStore] = useState<Store | null>(null)
  const [rating, setRating] = useState<ItemRatingSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [quantity, setQuantity] = useState(1)
  // One option id per axis of item.variants, in axis order; undefined where nothing is chosen.
  const [selection, setSelection] = useState<Array<number | undefined>>([])
  const [addedToCart, setAddedToCart] = useState(false)
  const [cartError, setCartError] = useState<string | null>(null)
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

  // Subscribe to cart changes and initialize count
  useEffect(() => {
    // Initialize with current count immediately
    setCartItemCount(cartService.getItemCount())
    // Then subscribe to future changes
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
        setSelection(initialSelection(itemData?.variants))

        if (itemData) {
          const [storeData, ratingData] = await Promise.all([
            storeService.getById(itemData.storeId),
            // Proved from the item's average tree (v2; v6 pins its store); one request.
            storefrontIsV2()
              ? storeStatsService.getItemRatingSummary(itemData.id, itemData.storeId).catch((error) => {
                  logger.warn('Failed to load item rating:', error)
                  return null
                })
              : Promise.resolve(null),
          ])
          setStore(storeData)
          setRating(ratingData)
        }
      } catch (error) {
        logger.error('Failed to load item:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadItem().catch((error) => logger.error(error))
  }, [sdkReady, itemId])

  const variants = item?.variants

  // The combination every axis's choice makes; undefined until all are chosen
  // or when the seller does not offer that combination.
  const combination = useMemo(
    () => (variants ? combinationForSelection(variants, selection) : undefined),
    [variants, selection]
  )
  const variantId = combination?.id
  const isFullySelected = Boolean(variants) && variants?.axes.length === selection.length && selection.every((optionId) => optionId !== undefined)

  // Each axis with the options a buyer can pick given the choices on the others.
  const axes = useMemo(
    () => variants?.axes.map((axis, axisIndex) => ({ ...axis, selectable: selectableOptionIds(variants, axisIndex, selection) })) ?? [],
    [variants, selection]
  )

  const currentStock = item ? storeItemService.getStock(item, variantId) : 0
  const hasInventoryTracking = item
    ? (variants ? combination?.stock !== undefined : storeItemService.hasInventoryTracking(item))
    : false

  const quantityInCart = cartService.getItems().find(
    cartItem => cartItem.itemId === item?.id && cartItem.variantId === variantId
  )?.quantity ?? 0
  const remainingStock = Math.max(0, currentStock - quantityInCart)

  useEffect(() => {
    setQuantity(value => Math.max(1, Math.min(value, remainingStock)))
    setCartError(null)
  }, [remainingStock, variantId])

  // The chosen combination's image first, then the rest of the item's.
  const images = useMemo(() => {
    const baseImages = item?.imageUrls ?? []
    const shown = combination && combinationImageUrl(baseImages, combination)
    return shown ? [shown, ...baseImages.filter(url => url !== shown)] : baseImages
  }, [item, combination])

  // Choosing the selected option again clears it, so another choice on a
  // different axis can open up.
  const handleVariantSelect = (axisIndex: number, optionId: number) => {
    setSelection(previous => {
      const next = variants?.axes.map((axis, index) => previous[index]) ?? []
      next[axisIndex] = previous[axisIndex] === optionId ? undefined : optionId
      return next
    })
  }

  const handleAddToCart = () => {
    if (!item) return

    try {
      cartService.addStoreItem(item, variantId, quantity)
      setCartError(null)
      setAddedToCart(true)
    } catch (err) {
      setCartError(err instanceof Error ? err.message : 'Could not add item to cart')
      return
    }

    // Clear any existing timeout before setting a new one
    if (addedToCartTimeoutRef.current) {
      clearTimeout(addedToCartTimeoutRef.current)
    }
    // Reset after animation
    addedToCartTimeoutRef.current = setTimeout(() => setAddedToCart(false), 2000)
  }

  if (isLoading) {
    return (
      <PageShell mainClassName="flex items-center justify-center">
            <Spinner size="md" />
      </PageShell>
    )
  }

  if (!item) {
    return (
      <PageShell mainClassName="flex flex-col items-center justify-center p-8">
            <BuildingStorefrontIcon className="h-16 w-16 text-gray-300 mb-4" />
            <p className="text-gray-500 font-medium">Item not found</p>
            <Button className="mt-4" onClick={() => router.push('/store')}>
              Browse Stores
            </Button>
      </PageShell>
    )
  }

  const isOutOfStock = variants
    ? (combination ? !isInStock(combination) : storeItemService.isOutOfStock(item))
    : hasInventoryTracking && currentStock === 0
  const unavailableReason = unavailableReasonFor(item, store, user?.identityId)
  const unchosenAxis = axes.find((axis, index) => selection[index] === undefined)
  // Every axis chosen, but the seller does not offer that combination.
  const combinationMissing = isFullySelected && !combination
  const needsChoice = Boolean(variants) && !combination

  return (
    <>
    <PageShell>
          {/* Header */}
          <PageHeader>
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
          </PageHeader>

          {/* Image Gallery */}
          <ImageGallery images={images} alt={item.title} />

          <BlockedOwnerBanner ownerId={store?.ownerId} className="mx-4 mt-4" />

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

            {rating && rating.reviewCount > 0 && (
              <div className="flex items-center gap-2">
                <RatingStars rating={rating.averageRating} size="md" />
                <span className="text-sm text-gray-500">
                  {rating.averageRating.toFixed(1)} ({rating.reviewCount} {rating.reviewCount === 1 ? 'review' : 'reviews'})
                </span>
              </div>
            )}

            <div>
              <p className="text-2xl font-bold text-yappr-600">
                {combination
                  ? formatPrice(combination.price, item.currency)
                  : variants
                    ? formatPriceRange(storeItemService.getPriceRange(item), item.currency)
                    : formatPrice(storeItemService.getPrice(item), item.currency)}
              </p>
              {combination?.sku && <p className="text-xs text-gray-400 mt-1">SKU {combination.sku}</p>}
            </div>

            {item.fulfillment === 'digital' && (
              <div className="flex items-start gap-2 p-3 bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800 rounded-lg text-sm text-sky-800 dark:text-sky-200">
                <CloudArrowDownIcon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-medium">Digital product.</span> Nothing ships: the seller delivers it encrypted to you on Dash Platform, and it appears under My Orders → Library.
                </span>
              </div>
            )}

            {/* Category */}
            {(item.section || item.category) && (
              <div className="text-sm text-gray-500">
                {[item.section, item.category, item.subcategory].filter(Boolean).join(' > ')}
              </div>
            )}

            {/* Variant Selectors: one choice per option type */}
            {axes.length > 0 && (
              <div className="space-y-4">
                {axes.map((axis, axisIndex) => {
                  const chosen = axis.options.find((option) => option.id === selection[axisIndex])
                  const labelId = `variant-axis-${axisIndex}`
                  return (
                    <div key={axisIndex}>
                      <p id={labelId} className="block text-sm font-medium mb-2">
                        {axis.name}{chosen && <>: <span className="font-normal">{chosen.name}</span></>}
                      </p>
                      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
                        {axis.options.map((option) => {
                          const isSelected = chosen?.id === option.id
                          const isSelectable = axis.selectable.has(option.id)

                          return (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => handleVariantSelect(axisIndex, option.id)}
                              disabled={!isSelectable && !isSelected}
                              aria-pressed={isSelected}
                              className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                isSelected
                                  ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-900/20 text-yappr-600'
                                  : isSelectable
                                    ? 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                                    : 'border-gray-200 dark:border-gray-700 opacity-40 cursor-not-allowed line-through'
                              }`}
                            >
                              {option.name}
                              {!isSelectable && <span className="sr-only"> (unavailable)</span>}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {combinationMissing && (
              <p role="status" className="text-sm text-red-600">This combination is not available. Try a different option.</p>
            )}

            {/* Stock Status */}
            {(hasInventoryTracking || isOutOfStock) && (
              <div className={`text-sm ${isOutOfStock ? 'text-red-500' : 'text-green-600'}`}>
                {isOutOfStock ? 'Out of stock' : `${currentStock} in stock`}
                {quantityInCart > 0 && ` · ${quantityInCart} in your cart`}
              </div>
            )}

            {unavailableReason && <p role="status" className="text-sm text-red-600">{unavailableReason}</p>}

            {/* Quantity */}
            {!isOutOfStock && !unavailableReason && !needsChoice && (
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium">Quantity</span>
                <QuantityControl
                  value={quantity}
                  onChange={setQuantity}
                  min={1}
                  max={hasInventoryTracking ? remainingStock : 99}
                />
              </div>
            )}

            {cartError && <p role="alert" className="text-sm text-red-600">{cartError}</p>}

            {/* Add to Cart */}
            <Button
              className="w-full"
              size="lg"
              disabled={Boolean(unavailableReason) || isOutOfStock || needsChoice || remainingStock === 0}
              onClick={handleAddToCart}
            >
              {unavailableReason ? (
                'Unavailable'
              ) : addedToCart ? (
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
              ) : combinationMissing ? (
                'Unavailable'
              ) : needsChoice ? (
                unchosenAxis ? `Choose ${unchosenAxis.name}` : 'Choose options'
              ) : remainingStock === 0 ? (
                'Maximum quantity in cart'
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

            {/* Reviews of this item */}
            {rating && rating.reviewCount > 0 && (
              <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
                <h3 className="font-medium mb-2">Reviews</h3>
                <ItemReviewList itemId={item.id} />
              </div>
            )}
          </div>
    </PageShell>

      {/* Mobile floating cart button */}
      <MobileCartFab />
    </>
  )
}
