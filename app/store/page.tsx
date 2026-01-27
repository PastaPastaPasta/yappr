'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  MagnifyingGlassIcon,
  BuildingStorefrontIcon,
  PlusIcon,
  StarIcon,
  ClipboardDocumentListIcon
} from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { MobileCartFab } from '@/components/store/mobile-cart-fab'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeService } from '@/lib/services/store-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import type { Store, StoreRatingSummary } from '@/lib/types'

export default function StoreBrowsePage() {
  const router = useRouter()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [stores, setStores] = useState<Store[]>([])
  const [storeRatings, setStoreRatings] = useState<Map<string, StoreRatingSummary>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [hasStore, setHasStore] = useState(false)

  // Check if user has a store
  useEffect(() => {
    if (!sdkReady) return
    const checkUserStore = async () => {
      if (!user?.identityId) {
        setHasStore(false)
        return
      }
      const exists = await storeService.hasStore(user.identityId)
      setHasStore(exists)
    }
    checkUserStore().catch(console.error)
  }, [sdkReady, user?.identityId])

  // Load active stores
  useEffect(() => {
    if (!sdkReady) return
    const loadStores = async () => {
      try {
        setIsLoading(true)
        const { stores: activeStores } = await storeService.getActiveStores({ limit: 50 })
        setStores(activeStores)

        // Load ratings for each store
        const ratingsMap = new Map<string, StoreRatingSummary>()
        await Promise.all(
          activeStores.map(async (store) => {
            try {
              const summary = await storeReviewService.calculateRatingSummary(store.id)
              ratingsMap.set(store.id, summary)
            } catch (e) {
              // Ignore rating fetch errors
            }
          })
        )
        setStoreRatings(ratingsMap)
      } catch (error) {
        console.error('Failed to load stores:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadStores().catch(console.error)
  }, [sdkReady])

  // Filter stores by search query
  const filteredStores = searchQuery
    ? stores.filter(store =>
        store.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        store.description?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : stores

  const handleStoreClick = (storeId: string) => {
    router.push(`/store/view?id=${storeId}`)
  }

  const renderStars = (rating: number) => {
    const stars = []
    for (let i = 1; i <= 5; i++) {
      if (i <= rating) {
        stars.push(<StarIconSolid key={i} className="h-4 w-4 text-yellow-400" />)
      } else if (i - 0.5 <= rating) {
        stars.push(<StarIconSolid key={i} className="h-4 w-4 text-yellow-400 opacity-50" />)
      } else {
        stars.push(<StarIcon key={i} className="h-4 w-4 text-gray-300" />)
      }
    }
    return stars
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center justify-between p-4">
              <h1 className="text-xl font-bold flex items-center gap-2">
                <BuildingStorefrontIcon className="h-6 w-6 text-yappr-500" />
                Stores
              </h1>
              {user && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push('/orders')}
                    className="flex items-center gap-1"
                  >
                    <ClipboardDocumentListIcon className="h-4 w-4" />
                    My Orders
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => router.push(hasStore ? '/store/manage' : '/store/create')}
                    className="flex items-center gap-1"
                  >
                    {hasStore ? (
                      <>Manage Store</>
                    ) : (
                      <>
                        <PlusIcon className="h-4 w-4" />
                        Create Store
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>

            {/* Search */}
            <div className="px-4 pb-4">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search stores"
                  className="w-full h-11 pl-12 pr-4 bg-gray-100 dark:bg-gray-900 rounded-full focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:bg-transparent dark:focus:bg-transparent"
                />
              </div>
            </div>
          </header>

          {/* Store List */}
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {isLoading ? (
              <div className="p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yappr-500 mx-auto mb-4" />
                <p className="text-gray-500">Loading stores...</p>
              </div>
            ) : filteredStores.length === 0 ? (
              <div className="p-8 text-center">
                <BuildingStorefrontIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 font-medium">
                  {searchQuery ? 'No stores match your search' : 'No stores yet'}
                </p>
                <p className="text-sm text-gray-400 mt-1">
                  {searchQuery ? 'Try a different search term' : 'Be the first to create a store!'}
                </p>
                {!searchQuery && user && !hasStore && (
                  <Button
                    className="mt-4"
                    onClick={() => router.push('/store/create')}
                  >
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Create Store
                  </Button>
                )}
              </div>
            ) : (
              filteredStores.map((store, index) => {
                const rating = storeRatings.get(store.id)
                return (
                  <motion.div
                    key={store.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    onClick={() => handleStoreClick(store.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleStoreClick(store.id)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    className="p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:ring-inset"
                  >
                    <div className="flex gap-4">
                      {/* Store Logo */}
                      <div className="flex-shrink-0 w-16 h-16 rounded-lg bg-gray-200 dark:bg-gray-800 overflow-hidden">
                        {store.logoUrl ? (
                          <img
                            src={store.logoUrl}
                            alt={store.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <BuildingStorefrontIcon className="h-8 w-8 text-gray-400" />
                          </div>
                        )}
                      </div>

                      {/* Store Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-semibold text-gray-900 dark:text-white truncate">
                            {store.name}
                          </h3>
                          {rating && rating.reviewCount > 0 && (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <div className="flex">
                                {renderStars(rating.averageRating)}
                              </div>
                              <span className="text-sm text-gray-500">
                                ({rating.reviewCount})
                              </span>
                            </div>
                          )}
                        </div>

                        {store.description && (
                          <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                            {store.description}
                          </p>
                        )}

                        {store.location && (
                          <p className="text-xs text-gray-400 mt-1">
                            {store.location}
                          </p>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )
              })
            )}
          </div>
        </main>
      </div>

      <RightSidebar />

      {/* Mobile floating cart button */}
      <MobileCartFab />
    </div>
  )
}
