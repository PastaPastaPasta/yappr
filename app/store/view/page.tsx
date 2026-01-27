'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  BuildingStorefrontIcon,
  ChatBubbleLeftIcon,
  MapPinIcon,
  ShoppingCartIcon,
  StarIcon
} from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { ReviewCard, PoliciesDisplay } from '@/components/store'
import { formatPrice } from '@/lib/utils/format'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeService } from '@/lib/services/store-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { cartService } from '@/lib/services/cart-service'
import { parseStorePolicies } from '@/lib/utils/policies'
import type { Store, StoreItem, StoreReview, StoreRatingSummary, StorePolicy } from '@/lib/types'

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
  const [activeTab, setActiveTab] = useState<'items' | 'reviews' | 'policies'>('items')
  const [cartItemCount, setCartItemCount] = useState(0)
  const [ownerDisplayName, setOwnerDisplayName] = useState<string | null>(null)
  const [ownerUsername, setOwnerUsername] = useState<string | null>(null)

  // Subscribe to cart changes
  useEffect(() => {
    const unsubscribe = cartService.subscribe(() => {
      setCartItemCount(cartService.getItemCount())
    })
    return unsubscribe
  }, [])

  // Load store data
  useEffect(() => {
    if (!sdkReady || !storeId) return

    const loadStore = async () => {
      try {
        setIsLoading(true)

        const [storeData, itemsData, reviewsData, ratingData] = await Promise.all([
          storeService.getById(storeId),
          storeItemService.getByStore(storeId, { limit: 50 }),
          storeReviewService.getStoreReviews(storeId, { limit: 20 }),
          storeReviewService.calculateRatingSummary(storeId)
        ])

        setStore(storeData)
        setItems(itemsData.items.filter(i => i.status === 'active'))
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
            console.error('Failed to load store owner info:', ownerErr)
          }
        }
      } catch (error) {
        console.error('Failed to load store:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadStore().catch(console.error)
  }, [sdkReady, storeId])

  const handleItemClick = (itemId: string) => {
    router.push(`/item?id=${itemId}`)
  }

  const renderStars = (rating: number) => {
    const stars = []
    for (let i = 1; i <= 5; i++) {
      if (i <= rating) {
        stars.push(<StarIconSolid key={i} className="h-5 w-5 text-yellow-400" />)
      } else {
        stars.push(<StarIcon key={i} className="h-5 w-5 text-gray-300" />)
      }
    }
    return stars
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
                      <div className="flex">{renderStars(ratingSummary.averageRating)}</div>
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
              Products ({items.length})
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
            <div className="grid grid-cols-2 gap-4 p-4">
              {items.length === 0 ? (
                <div className="col-span-2 py-12 text-center">
                  <p className="text-gray-500">No products listed yet</p>
                </div>
              ) : (
                items.map((item, index) => {
                  const priceRange = storeItemService.getPriceRange(item)
                  const isOutOfStock = storeItemService.isOutOfStock(item)

                  return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
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
                        <p className="text-sm text-yappr-600 font-medium">
                          {priceRange.min === priceRange.max
                            ? formatPrice(priceRange.min, item.currency)
                            : `${formatPrice(priceRange.min, item.currency)} - ${formatPrice(priceRange.max, item.currency)}`
                          }
                        </p>
                      </div>
                    </motion.div>
                  )
                })
              )}
            </div>
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
    </div>
  )
}
