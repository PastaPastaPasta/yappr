'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  BuildingStorefrontIcon,
  ChatBubbleLeftIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  ShoppingCartIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ReviewCard, PoliciesDisplay, MobileCartFab, RatingStars, PriceRangeDisplay } from '@/components/store'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeService } from '@/lib/services/store-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { cartService } from '@/lib/services/cart-service'
import { parseStorePolicies } from '@/lib/utils/policies'
import { saveStoreViewCache, loadStoreViewCache } from '@/lib/caches/store-view-cache'
import type { Store, StoreItem, StoreReview, StoreRatingSummary, StorePolicy } from '@/lib/types'

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex items-center justify-center">
          <Spinner />
        </main>
      </div>
      <RightSidebar />
    </div>
  )
}

export default function StoreDetailPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <StoreDetailContent />
    </Suspense>
  )
}

function StoreDetailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('id')
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [store, setStore] = useState<Store | null>(null)
  const [items, setItems] = useState<StoreItem[]>([])
  const [reviews, setReviews] = useState<StoreReview[]>([])
  const [ratingSummary, setRatingSummary] = useState<StoreRatingSummary | null>(null)
  const [storePolicies, setStorePolicies] = useState<StorePolicy[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMoreItems, setHasMoreItems] = useState(false)
  const [lastCursor, setLastCursor] = useState<string | undefined>()
  const [activeTab, setActiveTab] = useState<'items' | 'reviews' | 'policies'>('items')
  const [cartItemCount, setCartItemCount] = useState(0)
  const [ownerDisplayName, setOwnerDisplayName] = useState<string | null>(null)
  const [ownerUsername, setOwnerUsername] = useState<string | null>(null)

  // Search, filter, sort state
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<'newest' | 'title' | 'price'>('newest')

  // Cache restoration tracking
  const restoredFromCache = useRef(false)
  const pendingScrollY = useRef<number | null>(null)

  // Subscribe to cart changes
  useEffect(() => {
    const unsubscribe = cartService.subscribe(() => {
      setCartItemCount(cartService.getItemCount())
    })
    return unsubscribe
  }, [])

  // Load store data (with cache restoration for back-button navigation)
  useEffect(() => {
    if (!sdkReady || !storeId) return

    // Check for cached data first (back-button navigation)
    const cached = loadStoreViewCache(storeId)
    if (cached) {
      setStore(cached.store)
      setItems(cached.items)
      setReviews(cached.reviews)
      setRatingSummary(cached.ratingSummary)
      setStorePolicies(cached.storePolicies)
      setHasMoreItems(cached.hasMoreItems)
      setLastCursor(cached.lastCursor)
      setOwnerDisplayName(cached.ownerDisplayName)
      setOwnerUsername(cached.ownerUsername)
      setActiveTab(cached.activeTab)
      setSearchQuery(cached.searchQuery)
      setCategoryFilter(cached.categoryFilter)
      setSortField(cached.sortField)
      restoredFromCache.current = true
      pendingScrollY.current = cached.scrollY
      setIsLoading(false)
      return
    }

    const loadStore = async () => {
      try {
        setIsLoading(true)

        const [storeData, itemsData, reviewsData, ratingData] = await Promise.all([
          storeService.getById(storeId),
          storeItemService.getByStore(storeId, { limit: 100 }),
          storeReviewService.getStoreReviews(storeId, { limit: 20 }),
          storeReviewService.calculateRatingSummary(storeId)
        ])

        setStore(storeData)
        setItems(itemsData.items.filter(i => i.status === 'active'))
        setHasMoreItems(itemsData.items.length >= 100)
        if (itemsData.items.length > 0) {
          setLastCursor(itemsData.items[itemsData.items.length - 1].id)
        }
        setReviews(reviewsData.reviews)
        setRatingSummary(ratingData)

        // Parse store policies
        if (storeData) {
          setStorePolicies(parseStorePolicies(storeData.policies))

          // Fetch owner profile and username
          try {
            const { unifiedProfileService } = await import('@/lib/services')
            const { dpnsService } = await import('@/lib/services/dpns-service')

            const [ownerProfile, ownerUname] = await Promise.all([
              unifiedProfileService.getProfile(storeData.ownerId).catch(() => null),
              dpnsService.resolveUsername(storeData.ownerId).catch(() => null)
            ])

            if (ownerProfile?.displayName) {
              setOwnerDisplayName(ownerProfile.displayName)
            }
            if (ownerUname) {
              setOwnerUsername(ownerUname)
            }
          } catch (ownerErr) {
            logger.error('Failed to load store owner info:', ownerErr)
          }
        }
      } catch (error) {
        logger.error('Failed to load store:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadStore().catch((error) => logger.error(error))
  }, [sdkReady, storeId])

  // Restore scroll position after cache-restored items render
  useEffect(() => {
    if (pendingScrollY.current === null || isLoading || items.length === 0) return

    const scrollTarget = pendingScrollY.current
    pendingScrollY.current = null

    requestAnimationFrame(() => {
      window.scrollTo(0, scrollTarget)
    })
  }, [isLoading, items.length])

  const handleLoadMoreItems = useCallback(async () => {
    if (!storeId || isLoadingMore || !hasMoreItems) return

    setIsLoadingMore(true)
    try {
      const moreData = await storeItemService.getByStore(storeId, {
        limit: 100,
        startAfter: lastCursor
      })
      const activeItems = moreData.items.filter(i => i.status === 'active')
      setItems(prev => [...prev, ...activeItems])
      setHasMoreItems(moreData.items.length >= 100)
      if (moreData.items.length > 0) {
        setLastCursor(moreData.items[moreData.items.length - 1].id)
      }
    } catch (error) {
      logger.error('Failed to load more items:', error)
    } finally {
      setIsLoadingMore(false)
    }
  }, [storeId, isLoadingMore, hasMoreItems, lastCursor])

  const handleItemClick = (itemId: string) => {
    // Save current state to cache for back-button restoration
    if (storeId && store) {
      saveStoreViewCache(storeId, {
        store,
        items,
        reviews,
        ratingSummary,
        storePolicies,
        hasMoreItems,
        lastCursor,
        ownerDisplayName,
        ownerUsername,
        scrollY: window.scrollY,
        activeTab,
        searchQuery,
        categoryFilter,
        sortField,
        timestamp: Date.now()
      })
    }
    router.push(`/item?id=${itemId}`)
  }

  // Compute available categories from loaded items
  const availableCategories = useMemo(() => {
    const categories = new Set<string>()
    for (const item of items) {
      if (item.section) categories.add(item.section)
      if (item.category) categories.add(item.category)
    }
    return Array.from(categories).sort()
  }, [items])

  // Compute filtered and sorted items
  const filteredItems = useMemo(() => {
    let filtered = items

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(item =>
        item.title.toLowerCase().includes(query) ||
        item.description?.toLowerCase().includes(query) ||
        item.section?.toLowerCase().includes(query) ||
        item.category?.toLowerCase().includes(query) ||
        item.subcategory?.toLowerCase().includes(query) ||
        item.tags?.some(tag => tag.toLowerCase().includes(query))
      )
    }

    if (categoryFilter !== 'all') {
      filtered = filtered.filter(item =>
        item.section === categoryFilter || item.category === categoryFilter
      )
    }

    return [...filtered].sort((a, b) => {
      switch (sortField) {
        case 'title':
          return a.title.localeCompare(b.title)
        case 'price':
          return (a.basePrice ?? 0) - (b.basePrice ?? 0)
        case 'newest':
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
    })
  }, [items, searchQuery, categoryFilter, sortField])

  // Whether animations should be skipped (cache-restored items should appear instantly)
  const skipAnimations = restoredFromCache.current

  // Clear the flag after first render so future items (e.g. load more) animate normally
  useEffect(() => {
    if (restoredFromCache.current && !isLoading) {
      restoredFromCache.current = false
    }
  }, [isLoading])

  // Product count label
  const productCountLabel = useMemo(() => {
    const totalLabel = `${items.length}${hasMoreItems ? '+' : ''}`
    if (filteredItems.length !== items.length) {
      return `${filteredItems.length}/${totalLabel}`
    }
    return totalLabel
  }, [items.length, filteredItems.length, hasMoreItems])

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex items-center justify-center">
            <Spinner />
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  if (!store) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center p-8">
            <BuildingStorefrontIcon className="h-16 w-16 text-gray-300 mb-4" />
            <p className="text-gray-500 font-medium">Store not found</p>
            <Button className="mt-4" onClick={() => router.push('/store')}>
              Browse Stores
            </Button>
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  const isOwner = user?.identityId === store.ownerId

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          {/* Header */}
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.back()}
                  className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
                <h1 className="text-xl font-bold truncate">{store.name}</h1>
              </div>

              <div className="flex items-center gap-2">
                {isOwner ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push(`/store/manage?id=${storeId}`)}
                  >
                    Manage
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/messages?startConversation=${store.ownerId}`)}
                    >
                      <ChatBubbleLeftIcon className="h-4 w-4 mr-1.5" />
                      Message
                    </Button>
                    {user && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => router.push('/orders')}
                      >
                        My Orders
                      </Button>
                    )}
                  </>
                )}
                <button
                  onClick={() => router.push('/cart')}
                  className="relative p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <ShoppingCartIcon className="h-6 w-6" />
                  {cartItemCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-5 h-5 bg-yappr-500 text-white text-xs rounded-full flex items-center justify-center">
                      {cartItemCount}
                    </span>
                  )}
                </button>
              </div>
            </div>
          </header>

          {/* Store Banner & Info */}
          <div>
            {store.bannerUrl ? (
              <div className="h-32 bg-gray-200 dark:bg-gray-800">
                <img src={store.bannerUrl} alt="" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="h-32 bg-gradient-to-r from-yappr-400 to-yappr-600" />
            )}

            <div className="px-4 pb-4 -mt-8">
              <div className="flex gap-4">
                <div className="w-24 h-24 rounded-xl bg-white dark:bg-gray-900 border-4 border-white dark:border-gray-900 overflow-hidden flex-shrink-0">
                  {store.logoUrl ? (
                    <img src={store.logoUrl} alt={store.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center">
                      <BuildingStorefrontIcon className="h-10 w-10 text-gray-400" />
                    </div>
                  )}
                </div>

                <div className="pt-10 flex-1 min-w-0">
                  <h2 className="text-xl font-bold truncate">{store.name}</h2>
                  {ratingSummary && ratingSummary.reviewCount > 0 && (
                    <div className="flex items-center gap-2 mt-1">
                      <RatingStars rating={ratingSummary.averageRating} size="lg" />
                      <span className="text-sm text-gray-500">
                        {ratingSummary.averageRating.toFixed(1)} ({ratingSummary.reviewCount} reviews)
                      </span>
                    </div>
                  )}
                  {store.location && (
                    <div className="flex items-center gap-1 mt-1 text-sm text-gray-500">
                      <MapPinIcon className="h-4 w-4" />
                      {store.location}
                    </div>
                  )}
                  {/* Store Owner */}
                  <button
                    onClick={() => router.push(`/user?id=${store.ownerId}`)}
                    className="mt-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                  >
                    by{' '}
                    <span className="font-medium text-gray-700 dark:text-gray-200">
                      {ownerUsername ? `@${ownerUsername}` : ownerDisplayName || `User ${store.ownerId.slice(-6)}`}
                    </span>
                  </button>
                </div>
              </div>

              {store.description && (
                <p className="mt-4 text-gray-600 dark:text-gray-400">{store.description}</p>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-200 dark:border-gray-800">
            <button
              onClick={() => setActiveTab('items')}
              className={`flex-1 py-3 text-center font-medium transition-colors relative ${
                activeTab === 'items'
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Products ({productCountLabel})
              {activeTab === 'items' && (
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-yappr-500 rounded-full" />
              )}
            </button>
            <button
              onClick={() => setActiveTab('reviews')}
              className={`flex-1 py-3 text-center font-medium transition-colors relative ${
                activeTab === 'reviews'
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Reviews ({reviews.length})
              {activeTab === 'reviews' && (
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-yappr-500 rounded-full" />
              )}
            </button>
            <button
              onClick={() => setActiveTab('policies')}
              className={`flex-1 py-3 text-center font-medium transition-colors relative ${
                activeTab === 'policies'
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Policies
              {activeTab === 'policies' && (
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-yappr-500 rounded-full" />
              )}
            </button>
          </div>

          {/* Content */}
          {activeTab === 'items' ? (
            <>
              {/* Search, filter, and sort controls */}
              {items.length > 0 && (
                <div className="px-4 pt-4 space-y-3">
                  <div className="relative">
                    <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search products..."
                      className="w-full pl-9 pr-9 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700"
                      >
                        <XMarkIcon className="h-4 w-4 text-gray-400" />
                      </button>
                    )}
                  </div>

                  <div className="flex gap-2">
                    {availableCategories.length > 0 && (
                      <select
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        className="flex-1 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm border-none focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      >
                        <option value="all">All Categories</option>
                        {availableCategories.map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                    )}
                    <select
                      value={sortField}
                      onChange={(e) => setSortField(e.target.value as 'newest' | 'title' | 'price')}
                      className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm border-none focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    >
                      <option value="newest">Newest</option>
                      <option value="title">Name</option>
                      <option value="price">Price</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 p-4">
                {items.length === 0 ? (
                  <div className="col-span-2 py-12 text-center">
                    <p className="text-gray-500">No products listed yet</p>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="col-span-2 py-12 text-center">
                    <p className="text-gray-500">No matching products</p>
                    <button
                      onClick={() => { setSearchQuery(''); setCategoryFilter('all') }}
                      className="mt-2 text-sm text-yappr-500 hover:text-yappr-600"
                    >
                      Clear filters
                    </button>
                  </div>
                ) : (
                  <>
                    {filteredItems.map((item, index) => {
                      const priceRange = storeItemService.getPriceRange(item)
                      const isOutOfStock = storeItemService.isOutOfStock(item)

                      return (
                        <motion.div
                          key={item.id}
                          initial={skipAnimations ? false : { opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={skipAnimations ? { duration: 0 } : { delay: Math.min(index, 20) * 0.05 }}
                          onClick={() => handleItemClick(item.id)}
                          className="cursor-pointer group"
                        >
                          <div className="relative aspect-square bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden">
                            {item.imageUrls?.[0] ? (
                              <img
                                src={item.imageUrls[0]}
                                alt={item.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <BuildingStorefrontIcon className="h-12 w-12 text-gray-300" />
                              </div>
                            )}
                            {isOutOfStock && (
                              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                                <span className="text-white font-medium">Out of Stock</span>
                              </div>
                            )}
                          </div>
                          <div className="mt-2">
                            <h3 className="font-medium truncate">{item.title}</h3>
                            <PriceRangeDisplay
                              minPrice={priceRange.min}
                              maxPrice={priceRange.max}
                              currency={item.currency}
                              size="sm"
                            />
                          </div>
                        </motion.div>
                      )
                    })}
                    {hasMoreItems && (
                      <div className="col-span-2 py-4 text-center">
                        <Button
                          variant="outline"
                          onClick={handleLoadMoreItems}
                          disabled={isLoadingMore}
                        >
                          {isLoadingMore ? 'Loading...' : 'Load More Products'}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          ) : activeTab === 'reviews' ? (
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {reviews.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-gray-500">No reviews yet</p>
                </div>
              ) : (
                reviews.map((review, index) => (
                  <ReviewCard key={review.id} review={review} index={index} />
                ))
              )}
            </div>
          ) : (
            <PoliciesDisplay policies={storePolicies} />
          )}
        </main>
      </div>

      <RightSidebar />

      {/* Mobile floating cart button */}
      <MobileCartFab />
    </div>
  )
}
