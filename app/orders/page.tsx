'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeftIcon,
  ShoppingBagIcon,
  CloudArrowDownIcon
} from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { OrderCard, ReviewModal } from '@/components/orders'
import { DeliveryContents } from '@/components/digital'
import { orderDeliveryService } from '@/lib/services/order-delivery-service'
import { digitalOrders } from '@/lib/services/digital-delivery-plan'
import { formatDate } from '@/lib/utils/format'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { storeOrderService } from '@/lib/services/store-order-service'
import { orderStatusService } from '@/lib/services/order-status-service'
import { storeService } from '@/lib/services/store-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { storeStatsService } from '@/lib/services/store-stats-service'
import { storefrontIsV2, storefrontSupportsDigital } from '@/lib/constants'
import { identityService } from '@/lib/services/identity-service'
import { findEncryptionKey } from '@/lib/crypto/encryption-key-lookup'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import type { StoreOrder, OrderStatusUpdate, Store, OrderPayload, OrderDelivery } from '@/lib/types'
import { normalizeBytes } from '@/lib/bytes'

/** A seller's encryption public key, which both order and delivery decryption need. */
async function sellerEncryptionPublicKey(sellerId: string): Promise<Uint8Array | null> {
  const sellerIdentity = await identityService.getIdentity(sellerId)
  const sellerEncryptionKey = sellerIdentity ? findEncryptionKey(sellerIdentity.publicKeys) : undefined
  return sellerEncryptionKey?.data ? normalizeBytes(sellerEncryptionKey.data) : null
}

/**
 * Everything delivered to this buyer, read from the `buyerDeliveries` index
 * (not just the loaded order page), each delivery decrypted with the key both
 * parties derive from its order (lib/crypto/digital-delivery.ts). Orders
 * outside `knownOrders` are fetched, since decryption needs them. A delivery
 * that does not decrypt is kept without a payload, so the reader can say so.
 */
async function loadBuyerLibrary(
  buyerId: string,
  knownOrders: readonly StoreOrder[],
  buyerPrivateKey: Uint8Array | null,
  sellerKeys: Map<string, Uint8Array>
): Promise<{ deliveries: Map<string, OrderDelivery[]>; orders: StoreOrder[] }> {
  const byOrder = await orderDeliveryService.getForBuyer(buyerId)
  const ordersById = new Map(knownOrders.map((order) => [order.id, order]))
  const missing = [...byOrder.keys()].filter((orderId) => !ordersById.has(orderId))
  for (const order of await storeOrderService.getMany(missing)) ordersById.set(order.id, order)

  const sellerIds = new Set([...byOrder.keys()].flatMap((orderId) => ordersById.get(orderId)?.sellerId ?? []))
  for (const sellerId of sellerIds) {
    if (sellerKeys.has(sellerId)) continue
    const key = await sellerEncryptionPublicKey(sellerId).catch(() => null)
    if (key) sellerKeys.set(sellerId, key)
  }

  const deliveries = new Map<string, OrderDelivery[]>()
  const orders: StoreOrder[] = []
  for (const [orderId, list] of byOrder) {
    const order = ordersById.get(orderId)
    if (!order) continue
    orders.push(order)
    const sellerKey = sellerKeys.get(order.sellerId)
    deliveries.set(orderId, list.map((delivery) => {
      try {
        if (!buyerPrivateKey || !sellerKey) throw new Error('No key on this device to decrypt the delivery')
        return { ...delivery, payload: orderDeliveryService.decryptAsBuyer(delivery, order, buyerPrivateKey, sellerKey) }
      } catch (error) {
        logger.warn(`Could not decrypt delivery ${delivery.id}:`, error instanceof Error ? error.message : 'unknown error')
        return delivery
      }
    }))
  }
  orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return { deliveries, orders }
}

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

  // Digital delivery (storefront v6)
  const supportsDigital = storefrontSupportsDigital()
  const [deliveries, setDeliveries] = useState<Map<string, OrderDelivery[]>>(new Map())
  // Every order with a delivery, including ones older than the loaded order page.
  const [libraryOrders, setLibraryOrders] = useState<StoreOrder[]>([])
  const [tab, setTab] = useState<'orders' | 'library'>('orders')
  // Seller encryption keys fetched while decrypting orders; reused to decrypt deliveries.
  const sellerKeysRef = useRef<Map<string, Uint8Array>>(new Map())

  const refreshDeliveries = useCallback(async (orderList: StoreOrder[]) => {
    if (!supportsDigital || !user?.identityId) return
    try {
      const library = await loadBuyerLibrary(user.identityId, orderList, getEncryptionKeyBytes(user.identityId), sellerKeysRef.current)
      setDeliveries(prev => new Map([...prev, ...library.deliveries]))
      setLibraryOrders(library.orders)
      // Store names for library orders outside the loaded page.
      const storeIds = [...new Set(library.orders.map((order) => order.storeId))]
      const fetched = await storeService.getMany(storeIds.filter((id) => !orderList.some((order) => order.storeId === id)))
      if (fetched.length > 0) setStores(prev => new Map([...prev, ...fetched.map((store): [string, Store] => [store.id, store])]))
    } catch (e) {
      logger.warn('Failed to refresh deliveries:', e)
    }
  }, [supportsDigital, user?.identityId])

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
                  const sellerPubKey = await sellerEncryptionPublicKey(order.sellerId)

                  // Skip decryption if seller public key is missing
                  if (!sellerPubKey) {
                    logger.warn(`Skipping order ${order.id} decryption: seller public key not found`)
                  } else {
                    sellerKeysRef.current.set(order.sellerId, sellerPubKey)
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
        await refreshDeliveries(userOrders)
      } catch (error) {
        logger.error('Failed to load orders:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadOrders().catch((error) => logger.error(error))
  }, [sdkReady, user?.identityId, refreshDeliveries])

  // Refresh statuses (and deliveries) when page becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && orders.length > 0) {
        refreshStatuses(orders).catch((err) => logger.error('Failed to refresh order statuses:', err))
        refreshDeliveries(orders).catch((err) => logger.error('Failed to refresh deliveries:', err))
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [orders, refreshStatuses, refreshDeliveries])

  const hasDigitalOrders = supportsDigital && (digitalOrders(orders, orderPayloads).length > 0 || libraryOrders.length > 0)

  return (
    <>
    <PageShell>
          <PageHeader>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-4">
                <button
                  aria-label="Back"
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
            {hasDigitalOrders && (
              <div role="tablist" aria-label="Orders view" className="flex border-b border-gray-200 dark:border-gray-800">
                {([['orders', 'Orders'], ['library', 'Library']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={tab === value}
                    onClick={() => setTab(value)}
                    className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
                      tab === value
                        ? 'border-yappr-500 text-yappr-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
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
          ) : tab === 'library' && hasDigitalOrders ? (
            libraryOrders.length === 0 ? (
              <div className="p-8 text-center">
                <CloudArrowDownIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 font-medium">Nothing delivered yet</p>
                <p className="text-sm text-gray-400 mt-1">Digital items appear here once the seller delivers them</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-200 dark:divide-gray-800">
                {libraryOrders.map((order) => (
                  <section key={order.id} className="p-4 space-y-3" aria-label={`Delivery from ${stores.get(order.storeId)?.name ?? 'store'}`}>
                    <div>
                      <button
                        onClick={() => router.push(`/store/view?id=${order.storeId}`)}
                        className="font-medium hover:text-yappr-500 transition-colors text-left"
                      >
                        {stores.get(order.storeId)?.name || 'Unknown Store'}
                      </button>
                      <p className="text-xs text-gray-400">Ordered {formatDate(order.createdAt)}</p>
                    </div>
                    <DeliveryContents deliveries={deliveries.get(order.id) ?? []} />
                  </section>
                ))}
              </div>
            )
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
                    deliveries={supportsDigital ? deliveries.get(order.id) ?? [] : undefined}
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
