'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  MagnifyingGlassIcon,
  BuildingStorefrontIcon,
  PlusIcon,
  ClipboardDocumentListIcon
} from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { BetaPill } from '@/components/ui/beta-pill'
import { MobileCartFab } from '@/components/store/mobile-cart-fab'
import { RatingStars } from '@/components/store/rating-stars'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { storeService } from '@/lib/services/store-service'
import { storeStatsService, type RankedEntry } from '@/lib/services/store-stats-service'
import { DISCOVERY_SCAN_LIMIT } from '@/lib/services/pagination-utils'
import { storefrontIsV2, storefrontIsV6 } from '@/lib/constants'
import { storeCategoryLabel } from '@/lib/storefront/storefront-contract'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { useTabKeyboard } from '@/hooks/use-tab-keyboard'
import type { Store, StoreRatingSummary } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { ModerationClosedBanner } from '@/components/moderation/moderation-closed-notice'

type StoreSort = 'newest' | 'topRated' | 'mostOrdered'
const SORT_OPTIONS: ReadonlyArray<[StoreSort, string]> = [['newest', 'Newest'], ['topRated', 'Top rated'], ['mostOrdered', 'Most ordered']]

export default function StoreBrowsePage() {
  const router = useRouter()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const [stores, setStores] = useState<Store[]>([])
  const [storeRatings, setStoreRatings] = useState<Map<string, StoreRatingSummary>>(new Map())
  // Blocked store owners, tagged with the (viewer, store set) they were resolved for
  const [blockCheck, setBlockCheck] = useState<{ key: string; blocked: Map<string, boolean> } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [hasStore, setHasStore] = useState(false)
  const [sort, setSort] = useState<StoreSort>('newest')
  // v6: the newest active stores in one category ('' = every category), and
  // the categories with the most active stores, for the picker.
  const [category, setCategory] = useState('')
  const [categories, setCategories] = useState<RankedEntry[]>([])
  // `newest` sorted only the first DISCOVERY_SCAN_LIMIT stores read.
  const [scanIncomplete, setScanIncomplete] = useState(false)
  const [rankingUnavailable, setRankingUnavailable] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const selectSort = (key: StoreSort) => {
    setSort(key)
    // A category lists its newest stores; the rankings span every category.
    if (key !== 'newest') setCategory('')
  }
  const sortTabs = useTabKeyboard({ keys: SORT_OPTIONS.map(([key]) => key), active: sort, onSelect: selectSort })

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

  // v6: one proved ranked count of active stores per category.
  useEffect(() => {
    if (!sdkReady || !storefrontIsV6()) return
    let active = true
    storeStatsService.topStoreCategories(20)
      .then((ranked) => { if (active) setCategories(ranked) })
      .catch((error) => logger.error('Failed to load store categories:', error))
    return () => { active = false }
  }, [sdkReady])

  // Load active stores
  useEffect(() => {
    if (!sdkReady) return
    let active = true
    const loadStores = async () => {
      try {
        setIsLoading(true)
        setLoadFailed(false)
        let activeStores: Store[]
        let complete = true
        let fallback = false
        if (category) {
          // v6 `byCategory`: only active stores in the category, newest first.
          activeStores = await storeService.getNewestActiveStoresInCategory(category, 50)
        } else {
          ({ stores: activeStores, complete, rankingUnavailable: fallback } = await storeService.getDiscoveryStores(sort, 50))
        }
        // Proved averages (v2 only): one average-tree read per store, no review scans.
        const ratings = storefrontIsV2()
          ? await storeStatsService.getStoreRatingSummaries(activeStores.map((store) => store.id))
          : new Map<string, StoreRatingSummary>()
        if (!active) return
        setStores(activeStores)
        setStoreRatings(ratings)
        setScanIncomplete(!complete)
        setRankingUnavailable(fallback)
      } catch (error) {
        logger.error('Failed to load stores:', error)
        if (active) {
          setStores([])
          setStoreRatings(new Map())
          setScanIncomplete(false)
          setRankingUnavailable(false)
          setLoadFailed(true)
        }
      } finally {
        if (active) setIsLoading(false)
      }
    }
    loadStores().catch((error) => logger.error(error))
    return () => { active = false }
  }, [sdkReady, sort, category])

  const viewerId = user?.identityId
  const blockCheckKey = viewerId && stores.length > 0
    ? `${viewerId}:${stores.map(store => store.id).join(',')}`
    : ''

  // Resolve which store owners the viewer blocks (own or via followed lists)
  useEffect(() => {
    // Drop any earlier result first, so a result for the same key from before
    // a logout/login cannot vouch for this check while it is in flight.
    setBlockCheck(null)
    if (!viewerId || !blockCheckKey) return

    let cancelled = false
    const key = blockCheckKey
    checkBlockedForAuthors(viewerId, stores.map(store => store.ownerId))
      .then((blocked) => {
        if (!cancelled) setBlockCheck({ key, blocked })
      })
      .catch((error) => {
        // checkBlockedForAuthors already fails open; this only guards against
        // the list staying on its spinner if that ever changes.
        logger.error('Failed to check blocked store owners:', error)
        if (!cancelled) setBlockCheck({ key, blocked: new Map() })
      })
    return () => { cancelled = true }
  }, [viewerId, stores, blockCheckKey])

  // Keep the list loading until block status is known for this viewer and
  // store set, so blocked stores never flash as clickable. Guests skip this.
  const isBlockCheckPending = blockCheckKey !== '' && blockCheck?.key !== blockCheckKey

  // Hide stores whose owner is blocked, then filter by search query
  const filteredStores = useMemo(() => {
    const blocked = blockCheck?.key === blockCheckKey ? blockCheck.blocked : null
    const query = searchQuery.toLowerCase()
    return stores.filter(store =>
      !blocked?.get(store.ownerId) &&
      (!query ||
        store.name.toLowerCase().includes(query) ||
        store.description?.toLowerCase().includes(query))
    )
  }, [stores, blockCheck, blockCheckKey, searchQuery])

  // Every loaded store is hidden because its owner is blocked, so "No stores
  // yet" would be wrong.
  const allStoresHidden = !searchQuery && stores.length > 0 && filteredStores.length === 0

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
                <BetaPill product="store" />
              </h1>
              {user && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push('/orders')}
                    aria-label="My Orders"
                    className="flex items-center gap-1"
                  >
                    <ClipboardDocumentListIcon className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">My Orders</span>
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
            <div ref={sortTabs.listRef} onKeyDown={sortTabs.onKeyDown} className="flex gap-2 px-4 pb-3" role="tablist" aria-label="Sort stores">
              {SORT_OPTIONS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={sort === key}
                  tabIndex={sort === key ? 0 : -1}
                  onClick={() => selectSort(key)}
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
            <div className="flex gap-2 px-4 pb-4">
              <div className="relative min-w-0 flex-1">
                <MagnifyingGlassIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search stores"
                  className="w-full h-11 pl-12 pr-4 bg-gray-100 dark:bg-gray-900 rounded-full focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:bg-transparent dark:focus:bg-transparent"
                />
              </div>
              {/* Shown from the start (filled in when the counts land) so the search box keeps its width. */}
              {storefrontIsV6() && (
                <select
                  aria-label="Category"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value)
                    if (e.target.value) setSort('newest')
                  }}
                  className="h-11 max-w-[45%] shrink-0 rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
                >
                  <option value="">All categories</option>
                  {categories.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {storeCategoryLabel(entry.id)} ({entry.value})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </PageHeader>

          <ModerationClosedBanner product="storefront" docType="store" className="m-4" />

          {/* Store List */}
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {!isLoading && !isBlockCheckPending && rankingUnavailable && (
              <p className="px-4 py-2 text-center text-sm text-gray-500" role="status">
                Rankings are unavailable right now. Showing newest stores.
              </p>
            )}
            {isLoading || isBlockCheckPending ? (
              // Sized like a store row (logo, name, two description lines, location) so the list does not jump.
              <>
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex gap-4 p-4 animate-pulse" aria-hidden="true">
                    <div className="h-16 w-16 flex-shrink-0 rounded-lg bg-gray-200 dark:bg-gray-800" />
                    <div className="flex-1">
                      <div className="flex h-6 items-center"><div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-800" /></div>
                      <div className="mt-1 flex h-5 items-center"><div className="h-3.5 w-full rounded bg-gray-200 dark:bg-gray-800" /></div>
                      <div className="flex h-5 items-center"><div className="h-3.5 w-2/3 rounded bg-gray-200 dark:bg-gray-800" /></div>
                      <div className="mt-1 flex h-4 items-center"><div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-800" /></div>
                    </div>
                  </div>
                ))}
                <span className="sr-only" role="status">Loading stores</span>
              </>
            ) : loadFailed ? (
              <p className="p-8 text-center text-sm text-gray-500" role="status">
                Stores are unavailable right now. Please try again.
              </p>
            ) : filteredStores.length === 0 ? (
              <div className="p-8 text-center">
                <BuildingStorefrontIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 font-medium">
                  {searchQuery ? 'No stores match your search' : allStoresHidden ? 'No stores to show' : category ? 'No open stores in this category' : 'No stores yet'}
                </p>
                <p className="text-sm text-gray-400 mt-1">
                  {searchQuery
                    ? 'Try a different search term'
                    : allStoresHidden
                      ? 'Stores from accounts you block are hidden'
                      : 'Be the first to open one.'}
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
              <>
              {scanIncomplete && (
                <p className="px-4 py-2 text-center text-xs text-gray-500">
                  Newest among the first {DISCOVERY_SCAN_LIMIT.toLocaleString()} stores found; there are more.
                </p>
              )}
              {filteredStores.map((store, index) => {
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
                        <IpfsImage
                          src={store.logoUrl ?? ''}
                          size="avatar"
                          alt={store.name}
                          className="w-full h-full object-cover"
                          fallback={
                            <div className="w-full h-full flex items-center justify-center">
                              <BuildingStorefrontIcon className="h-8 w-8 text-gray-400" />
                            </div>
                          }
                        />
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
              })}
              </>
            )}
          </div>
    </PageShell>

      {/* Mobile floating cart button */}
      <MobileCartFab />
    </>
  )
}
