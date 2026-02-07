'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeftIcon,
  ShoppingBagIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { OrderCard, ReviewModal } from '@/components/orders'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeOrderService } from '@/lib/services/store-order-service'
import { orderStatusService } from '@/lib/services/order-status-service'
import { storeService } from '@/lib/services/store-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { identityService } from '@/lib/services/identity-service'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import type { StoreOrder, OrderStatusUpdate, Store, OrderPayload } from '@/lib/types'

/**
 * Normalize key data from various formats to Uint8Array
 */
function normalizeKeyData(data: unknown): Uint8Array | null {
  if (!data) return null
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return new Uint8Array(data)
  if (typeof data === 'string') {
    try {
      const binaryString = atob(data)
      return Uint8Array.from(binaryString, (c) => c.charCodeAt(0))
    } catch {
      return null
    }
  }
  return null
}

function OrdersPage() {
  const router = useRouter()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [orders, setOrders] = useState<StoreOrder[]>([])
  const [orderPayloads, setOrderPayloads] = useState<Map<string, OrderPayload>>(new Map())
  const [orderStatuses, setOrderStatuses] = useState<Map<string, OrderStatusUpdate>>(new Map())
  const [stores, setStores] = useState<Map<string, Store>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null)
  const [reviewedOrders, setReviewedOrders] = useState<Set<string>>(new Set())
  const [reviewModalData, setReviewModalData] = useState<{ order: StoreOrder; store: Store } | null>(null)

  // Refresh just the order statuses (lightweight refresh)
  // Merges new statuses into existing map to preserve data on transient failures
  const refreshStatuses = useCallback(async (orderList: StoreOrder[]) => {
    if (orderList.length === 0) return

    const updates: Array<{ orderId: string; status: OrderStatusUpdate }> = []
    await Promise.all(
      orderList.map(async (order) => {
        try {
          const status = await orderStatusService.getLatestStatus(order.id)
          if (status) {
            updates.push({ orderId: order.id, status })
          }
        } catch (e) {
          // Ignore errors - preserve existing status for this order
        }
      })
    )
    // Merge updates into existing map
    setOrderStatuses(prev => {
      const merged = new Map(prev)
      for (const { orderId, status } of updates) {
        merged.set(orderId, status)
      }
      return merged
    })
  }, [])

  // Load orders
  useEffect(() => {
    if (!sdkReady || !user?.identityId) return

    const loadOrders = async () => {
      try {
        setIsLoading(true)
        const { orders: userOrders } = await storeOrderService.getBuyerOrders(user.identityId, { limit: 50 })
        setOrders(userOrders)

        // Get buyer's encryption private key for decryption
        const buyerPrivKey = getEncryptionKeyBytes(user.identityId)

        // Load latest status for each order, decrypt payloads, and check if reviewed
        const payloadMap = new Map<string, OrderPayload>()
        const statusMap = new Map<string, OrderStatusUpdate>()
        const storeMap = new Map<string, Store>()
        const reviewedSet = new Set<string>()

        await Promise.all(
          userOrders.map(async (order) => {
            try {
              const [status, store, existingReview] = await Promise.all([
                orderStatusService.getLatestStatus(order.id),
                storeService.getById(order.storeId),
                storeReviewService.getOrderReview(order.id)
              ])

              if (status) {
                statusMap.set(order.id, status)
              }
              if (store) {
                storeMap.set(order.storeId, store)
              }
              if (existingReview) {
                reviewedSet.add(order.id)
              }

              // Decrypt order payload if we have the private key
              if (buyerPrivKey) {
                try {
                  // Fetch seller's public key for decryption
                  const sellerIdentity = await identityService.getIdentity(order.sellerId)
                  const sellerEncryptionKey = sellerIdentity?.publicKeys.find(
                    (k) => k.purpose === 1 && k.type === 0 && !k.disabledAt
                  )
                  const sellerPubKey = sellerEncryptionKey?.data
                    ? normalizeKeyData(sellerEncryptionKey.data)
                    : null

                  // Skip decryption if seller public key is missing
                  if (!sellerPubKey) {
                    console.warn(`Skipping order ${order.id} decryption: seller public key not found`)
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
                  console.warn(`Failed to decrypt order ${order.id}:`, decryptError)
                }
              }
            } catch (e) {
              // Ignore errors for status/store/review fetching
            }
          })
        )

        setOrderPayloads(payloadMap)
        setOrderStatuses(statusMap)
        setStores(storeMap)
        setReviewedOrders(reviewedSet)
      } catch (error) {
        console.error('Failed to load orders:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadOrders().catch(console.error)
  }, [sdkReady, user?.identityId])

  // Refresh statuses when page becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && orders.length > 0) {
        refreshStatuses(orders)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [orders, refreshStatuses])

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
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
          </header>

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
                const canReview = !reviewedOrders.has(order.id)

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
        </main>
      </div>

      <RightSidebar />

      {reviewModalData && (
        <ReviewModal
          isOpen={!!reviewModalData}
          onClose={() => setReviewModalData(null)}
          order={reviewModalData.order}
          store={reviewModalData.store}
          onSuccess={() => {
            setReviewedOrders((prev) => {
              const next = new Set(prev)
              next.add(reviewModalData.order.id)
              return next
            })
          }}
        />
      )}
    </div>
  )
}

export default withAuth(OrdersPage)
