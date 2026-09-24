'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeftIcon,
  ShoppingBagIcon
} from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { OrderCard, ReviewModal } from '@/components/orders'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { storeOrderService } from '@/lib/services/store-order-service'
import { orderStatusService } from '@/lib/services/order-status-service'
import { storeService } from '@/lib/services/store-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { storeStatsService } from '@/lib/services/store-stats-service'
import { storefrontIsV2 } from '@/lib/constants'
import { identityService } from '@/lib/services/identity-service'
import { findEncryptionKey } from '@/lib/crypto/encryption-key-lookup'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import type { StoreOrder, OrderStatusUpdate, Store, OrderPayload } from '@/lib/types'
import { normalizeBytes } from '@/lib/bytes'

function OrdersPage() {
  const router = useRouter()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()

  const [orders, setOrders] = useState<StoreOrder[]>([])
  const [orderPayloads, setOrderPayloads] = useState<Map<string, OrderPayload>>(new Map())
  const [orderStatuses, setOrderStatuses] = useState<Map<string, OrderStatusUpdate>>(new Map())
  const [stores, setStores] = useState<Map<string, Store>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null)
  const [reviewedOrders, setReviewedOrders] = useState<Set<string>>(new Set())
  const [reviewModalData, setReviewModalData] = useState<{ order: StoreOrder; store: Store } | null>(null)

  // Refresh just the order statuses (one `in` query per 100 orders).
  // Merges new statuses into the existing map to preserve data on transient failures.
  const refreshStatuses = useCallback(async (orderList: StoreOrder[]) => {
    if (orderList.length === 0) return
    try {
      const latest = await orderStatusService.getLatestStatuses(orderList.map((order) => order.id))
      setOrderStatuses(prev => {
        const merged = new Map(prev)
        for (const [orderId, status] of latest) merged.set(orderId, status)
        return merged
      })
    } catch (e) {
      logger.warn('Failed to refresh order statuses:', e)
    }
  }, [])

  // Load orders
  useEffect(() => {
    if (!sdkReady || !user?.identityId) return

    const loadOrders = async () => {
      try {
        setIsLoading(true)
        // One composite proof: orders + store joins + review-exists + status
        // history. Falls back to batched `in` queries when the composite is
        // unavailable (older networks).
        // The by-id store join needs v2's refersTo; v1 takes the batched path.
        const composite = storefrontIsV2() ? await storeStatsService.loadBuyerOrdersComposite(user.identityId, 50) : null
        const userOrders = composite
          ? composite.orders.map((doc) => storeOrderService.fromDocument(doc))
          : (await storeOrderService.getBuyerOrders(user.identityId, { limit: 50 })).orders
        setOrders(userOrders)

        // Get buyer's encryption private key for decryption
        const buyerPrivKey = getEncryptionKeyBytes(user.identityId)

        const payloadMap = new Map<string, OrderPayload>()
        let stores: Store[]
        let reviewedOrderIds: string[]
        let statusMap: Map<string, OrderStatusUpdate>

        if (composite) {
          stores = composite.stores.map((doc) => storeService.fromDocument(doc))
          reviewedOrderIds = composite.reviews.map((doc) => storeReviewService.fromDocument(doc).orderId)
          statusMap = orderStatusService.latestPerOrder(composite.statuses.map((doc) => orderStatusService.fromDocument(doc)))
        } else {
          const orderIds = userOrders.map((order) => order.id)
          const [fetchedStores, reviews, statuses] = await Promise.all([
            storeService.getMany([...new Set(userOrders.map((order) => order.storeId))]),
            storeReviewService.getOrderReviews(orderIds),
            orderStatusService.getLatestStatuses(orderIds),
          ])
          stores = fetchedStores
          reviewedOrderIds = [...reviews.keys()]
          statusMap = statuses
        }
        const storeMap = new Map(stores.map((store) => [store.id, store]))
        // A join sub-result should cover every order; backfill any it missed
        // so the store name and the review button never silently vanish.
        const missingStoreIds = [...new Set(userOrders.map((order) => order.storeId))].filter((id) => !storeMap.has(id))
        for (const store of await storeService.getMany(missingStoreIds)) storeMap.set(store.id, store)
        const reviewedSet = new Set(reviewedOrderIds)

        await Promise.all(
          userOrders.map(async (order) => {
            try {
              // Decrypt order payload if we have the private key
              if (buyerPrivKey) {
                try {
                  // Fetch seller's public key for decryption
                  const sellerIdentity = await identityService.getIdentity(order.sellerId)
                  const sellerEncryptionKey = sellerIdentity ? findEncryptionKey(sellerIdentity.publicKeys) : undefined
                  const sellerPubKey = sellerEncryptionKey?.data
                    ? normalizeBytes(sellerEncryptionKey.data)
                    : null

                  // Skip decryption if seller public key is missing
                  if (!sellerPubKey) {
                    logger.warn(`Skipping order ${order.id} decryption: seller public key not found`)
                  } else {
                    const payload = await storeOrderService.decryptOrderPayload(
                      order.encryptedPayload,
                      order.nonce,
                      order.storeId,
                      buyerPrivKey,
                      sellerPubKey,
                      true // isBuyer
                    )

                    if (payload) {
                      payloadMap.set(order.id, payload)
                    }
                  }
                } catch (decryptError) {
                  logger.warn(`Failed to decrypt order ${order.id}:`, decryptError)
                }
              }
            } catch (e) {
              // Ignore decryption errors for one order
            }
          })
        )

        setOrderPayloads(payloadMap)
        setOrderStatuses(statusMap)
        setStores(storeMap)
        setReviewedOrders(reviewedSet)
      } catch (error) {
        logger.error('Failed to load orders:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadOrders().catch((error) => logger.error(error))
  }, [sdkReady, user?.identityId])

  // Refresh statuses when page becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && orders.length > 0) {
        refreshStatuses(orders).catch((err) => logger.error('Failed to refresh order statuses:', err))
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [orders, refreshStatuses])

  return (
    <>
    <PageShell>
          <PageHeader>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.back()}
                  className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
                <h1 className="text-xl font-bold flex items-center gap-2">
                  <ShoppingBagIcon className="h-6 w-6" />
                  My Orders
                </h1>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/orders/seller')}
              >
                Seller Orders
              </Button>
            </div>
          </PageHeader>

          {isLoading ? (
            <div className="p-8 text-center">
              <Spinner size="md" className="mx-auto mb-4" />
              <p className="text-gray-500">Loading orders...</p>
            </div>
          ) : orders.length === 0 ? (
            <div className="p-8 text-center">
              <ShoppingBagIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500 font-medium">No orders yet</p>
              <p className="text-sm text-gray-400 mt-1">Your order history will appear here</p>
              <Button className="mt-4" onClick={() => router.push('/store')}>
                Browse Stores
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {orders.map((order, index) => {
                const status = orderStatuses.get(order.id)
                const store = stores.get(order.storeId)
                // A seller who ordered from their own store cannot rate it
                // (storefront v4 refuses it in consensus, sellerId distinctFrom $ownerId).
                const canReview = !reviewedOrders.has(order.id) && order.sellerId !== user?.identityId

                return (
                  <OrderCard
                    key={order.id}
                    order={order}
                    payload={orderPayloads.get(order.id)}
                    status={status}
                    store={store}
                    expanded={expandedOrder === order.id}
                    onToggle={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}
                    index={index}
                    canReview={canReview}
                    onLeaveReview={() => {
                      if (store) {
                        setReviewModalData({ order, store })
                      }
                    }}
                  />
                )
              })}
            </div>
          )}
    </PageShell>

      {reviewModalData && (
        <ReviewModal
          isOpen={!!reviewModalData}
          onClose={() => setReviewModalData(null)}
          order={reviewModalData.order}
          store={reviewModalData.store}
          payload={orderPayloads.get(reviewModalData.order.id)}
          onSuccess={() => {
            setReviewedOrders((prev) => {
              const next = new Set(prev)
              next.add(reviewModalData.order.id)
              return next
            })
          }}
        />
      )}
    </>
  )
}

export default withAuth(OrdersPage)
