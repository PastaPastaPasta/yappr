'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  MagnifyingGlassIcon,
  BuildingStorefrontIcon,
  PlusIcon,
  ClipboardDocumentListIcon
} from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { MobileCartFab } from '@/components/store/mobile-cart-fab'
import { RatingStars } from '@/components/store/rating-stars'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { storeService } from '@/lib/services/store-service'
import { storeStatsService } from '@/lib/services/store-stats-service'
import { storefrontIsV2 } from '@/lib/constants'
import type { Store, StoreRatingSummary } from '@/lib/types'

type StoreSort = 'newest' | 'topRated' | 'mostOrdered'
const SORT_OPTIONS: ReadonlyArray<[StoreSort, string]> = [['newest', 'Newest'], ['topRated', 'Top rated'], ['mostOrdered', 'Most ordered']]

export default function StoreBrowsePage() {
  const router = useRouter()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const [stores, setStores] = useState<Store[]>([])
  const [storeRatings, setStoreRatings] = useState<Map<string, StoreRatingSummary>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [hasStore, setHasStore] = useState(false)
  const [sort, setSort] = useState<StoreSort>('newest')

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
    checkUserStore().catch((error) => logger.error(error))
  }, [sdkReady, user?.identityId])

  // Load active stores
  useEffect(() => {
    if (!sdkReady) return
    let active = true
    const loadStores = async () => {
      try {
        setIsLoading(true)
        let activeStores: Store[]
        if (sort === 'newest') {
          activeStores = (await storeService.getActiveStores({ limit: 50 })).stores
        } else {
          // One proved ranked page (top rated by average, or most ordered),
          // then the stores by id.
          const ranked = sort === 'topRated'
            ? await storeStatsService.topRatedStores(50)
            : await storeStatsService.mostOrderedStores(50)
          const byId = new Map((await storeService.getMany(ranked.map((entry) => entry.id))).map((store) => [store.id, store]))
          activeStores = ranked
            .map((entry) => byId.get(entry.id))
            .filter((store): store is Store => store !== undefined && store.status === 'active')
        }
        // Proved averages (v2 only): one average-tree read per store, no review scans.
        const ratings = storefrontIsV2()
          ? await storeStatsService.getStoreRatingSummaries(activeStores.map((store) => store.id))
          : new Map<string, StoreRatingSummary>()
        if (!active) return
        setStores(activeStores)
        setStoreRatings(ratings)
      } catch (error) {
        logger.error('Failed to load stores:', error)
      } finally {
        if (active) setIsLoading(false)
      }
    }
    loadStores().catch((error) => logger.error(error))
    return () => { active = false }
  }, [sdkReady, sort])

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

  return (
    <>
    <PageShell>
          <PageHeader>
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

            {/* Sort (ranked tabs need the v2 contract's ranking trees) */}
            {storefrontIsV2() && (
            <div className="flex gap-2 px-4 pb-3" role="tablist" aria-label="Sort stores">
              {SORT_OPTIONS.map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={sort === key}
                  onClick={() => setSort(key)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                    sort === key
                      ? 'bg-yappr-500 text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            )}

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
          </PageHeader>

          {/* Store List */}
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {isLoading ? (
              <div className="p-8 text-center">
                <Spinner className="mx-auto mb-4" />
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
                            <RatingStars
                              rating={rating.averageRating}
                              reviewCount={rating.reviewCount}
                              size="sm"
                            />
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
    </PageShell>

      {/* Mobile floating cart button */}
      <MobileCartFab />
    </>
  )
}
