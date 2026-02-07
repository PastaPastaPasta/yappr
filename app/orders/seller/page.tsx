'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  ShoppingBagIcon,
  ChevronDownIcon,
  ChevronUpIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { OrderStatusBadge } from '@/components/store'
import { OrderItemsList, StatusUpdateForm } from '@/components/orders'
import { formatDate, formatOrderId } from '@/lib/utils/format'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeOrderService } from '@/lib/services/store-order-service'
import { orderStatusService } from '@/lib/services/order-status-service'
import { dpnsService } from '@/lib/services'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import toast from 'react-hot-toast'
import { ClipboardIcon } from '@heroicons/react/24/outline'
import type { StoreOrder, OrderStatusUpdate, OrderStatus, OrderPayload } from '@/lib/types'

/**
 * Decrypt order payload using seller's encryption private key.
 * Uses standard ECIES decryption (seller path).
 */
async function decryptSellerOrderPayload(
  order: StoreOrder,
  sellerPrivateKey: Uint8Array | null
): Promise<OrderPayload | null> {
  if (!sellerPrivateKey) {
    // No private key - try plain JSON fallback
    try {
      const decoder = new TextDecoder()
      const jsonStr = decoder.decode(order.encryptedPayload)
      return JSON.parse(jsonStr) as OrderPayload
    } catch (e) {
      console.error('Failed to decode order payload:', e)
      return null
    }
  }

  try {
    return await storeOrderService.decryptOrderPayload(
      order.encryptedPayload,
      order.nonce,
      order.storeId,
      sellerPrivateKey,
      null, // No seller pubkey needed for seller decryption
      false // isBuyer = false (seller)
    )
  } catch (e) {
    console.error('Failed to decrypt order payload:', e)
    return null
  }
}

function SellerOrdersPage() {
  const router = useRouter()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [orders, setOrders] = useState<StoreOrder[]>([])
  const [orderPayloads, setOrderPayloads] = useState<Map<string, OrderPayload>>(new Map())
  const [orderStatuses, setOrderStatuses] = useState<Map<string, OrderStatusUpdate>>(new Map())
  const [buyerUsernames, setBuyerUsernames] = useState<Map<string, string>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null)

  // Status update form
  const [updateOrderId, setUpdateOrderId] = useState<string | null>(null)
  const [newStatus, setNewStatus] = useState<OrderStatus>('pending')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [trackingCarrier, setTrackingCarrier] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Load seller orders
  useEffect(() => {
    if (!sdkReady || !user?.identityId) return

    const loadOrders = async () => {
      try {
        setIsLoading(true)
        const { orders: sellerOrders } = await storeOrderService.getSellerOrders(user.identityId, { limit: 50 })
        setOrders(sellerOrders)

        // Get seller's encryption private key for decryption
        const sellerPrivateKey = getEncryptionKeyBytes(user.identityId)

        // Decrypt order payloads
        const payloadMap = new Map<string, OrderPayload>()
        await Promise.all(
          sellerOrders.map(async (order) => {
            const payload = await decryptSellerOrderPayload(order, sellerPrivateKey)
            if (payload) {
              payloadMap.set(order.id, payload)
            }
          })
        )
        setOrderPayloads(payloadMap)

        // Load latest status for each order and resolve buyer usernames
        const statusMap = new Map<string, OrderStatusUpdate>()
        const usernameMap = new Map<string, string>()

        await Promise.all(
          sellerOrders.map(async (order) => {
            try {
              const [status, username] = await Promise.all([
                orderStatusService.getLatestStatus(order.id),
                dpnsService.resolveUsername(order.buyerId)
              ])
              if (status) {
                statusMap.set(order.id, status)
              }
              if (username) {
                usernameMap.set(order.buyerId, username)
              }
            } catch (e) {
              // Ignore errors
            }
          })
        )

        setOrderStatuses(statusMap)
        setBuyerUsernames(usernameMap)
      } catch (error) {
        console.error('Failed to load seller orders:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadOrders().catch(console.error)
  }, [sdkReady, user?.identityId])

  const handleUpdateStatus = async (orderId: string) => {
    if (!user?.identityId) return

    setIsSubmitting(true)
    try {
      const update = await orderStatusService.createStatusUpdate(user.identityId, orderId, {
        status: newStatus,
        trackingNumber: trackingNumber || undefined,
        trackingCarrier: trackingCarrier || undefined,
        message: statusMessage || undefined
      })

      setOrderStatuses(prev => new Map(prev).set(orderId, update))
      setUpdateOrderId(null)
      setNewStatus('pending')
      setTrackingNumber('')
      setTrackingCarrier('')
      setStatusMessage('')
    } catch (error) {
      console.error('Failed to update status:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-surface-200 dark:border-surface-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-surface-950/70 border-b border-surface-200 dark:border-surface-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.back()}
                  className="p-2 -ml-2 rounded-full hover:bg-surface-100 dark:hover:bg-surface-800"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
                <h1 className="text-xl font-display font-bold flex items-center gap-2">
                  <ShoppingBagIcon className="h-6 w-6" />
                  Seller Orders
                </h1>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/orders')}
              >
                My Orders
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
              <p className="text-gray-500 font-medium">No orders received yet</p>
              <p className="text-sm text-gray-400 mt-1">Orders from buyers will appear here</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {orders.map((order, index) => {
                const status = orderStatuses.get(order.id)
                const payload = orderPayloads.get(order.id)
                const isExpanded = expandedOrder === order.id
                const isUpdating = updateOrderId === order.id

                return (
                  <motion.div
                    key={order.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className="p-4"
                  >
                    {/* Order Header */}
                    <div
                      onClick={() => setExpandedOrder(isExpanded ? null : order.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpandedOrder(isExpanded ? null : order.id)
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      className="w-full flex items-center justify-between cursor-pointer focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:ring-inset rounded"
                    >
                      <div className="flex items-center gap-3">
                        <OrderStatusBadge status={status?.status} showLabel={false} />
                        <div className="text-left">
                          <h3 className="font-medium">
                            Order from{' '}
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                router.push(`/user?id=${order.buyerId}`)
                              }}
                              className="text-yappr-500 hover:underline"
                            >
                              @{buyerUsernames.get(order.buyerId) || formatOrderId(order.buyerId)}
                            </button>
                          </h3>
                          <p className="text-sm text-gray-500">
                            {formatDate(order.createdAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-sm font-medium ${orderStatusService.getStatusColor(status?.status || 'pending')}`}>
                          {orderStatusService.getStatusLabel(status?.status || 'pending')}
                        </span>
                        {isExpanded ? (
                          <ChevronUpIcon className="h-5 w-5 text-gray-400" />
                        ) : (
                          <ChevronDownIcon className="h-5 w-5 text-gray-400" />
                        )}
                      </div>
                    </div>

                    {/* Expanded Details */}
                    {isExpanded && (
                      <div className="mt-4 space-y-4">
                        {/* Order ID */}
                        <div className="p-3 bg-surface-50 dark:bg-surface-950 rounded-lg">
                          <p className="text-sm font-medium mb-1">Order ID</p>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard.writeText(order.id)
                                .then(() => toast.success('Order ID copied'))
                                .catch(() => toast.error('Failed to copy'))
                            }}
                            className="flex items-center gap-2 text-sm font-mono text-surface-500 dark:text-surface-400 hover:text-yappr-500 transition-colors"
                          >
                            <span className="break-all">{order.id}</span>
                            <ClipboardIcon className="h-4 w-4 flex-shrink-0" />
                          </button>
                        </div>

                        {/* Order Payload Details */}
                        {payload ? (
                          <>
                            {/* Items */}
                            <OrderItemsList
                              items={payload.items}
                              currency={payload.currency}
                              subtotal={payload.subtotal}
                              shippingCost={payload.shippingCost}
                              total={payload.total}
                            />

                            {/* Shipping Address */}
                            <div className="p-3 bg-surface-50 dark:bg-surface-950 rounded-lg">
                              <p className="text-sm font-medium mb-2">Shipping Address</p>
                              <p className="text-sm">{payload.shippingAddress.name}</p>
                              <p className="text-sm text-surface-500 dark:text-surface-400">{payload.shippingAddress.street}</p>
                              <p className="text-sm text-surface-500 dark:text-surface-400">
                                {payload.shippingAddress.city}{payload.shippingAddress.state ? `, ${payload.shippingAddress.state}` : ''} {payload.shippingAddress.postalCode}
                              </p>
                              <p className="text-sm text-surface-500 dark:text-surface-400">{payload.shippingAddress.country}</p>
                            </div>

                            {/* Contact Info */}
                            {(payload.buyerContact.email || payload.buyerContact.phone) && (
                              <div className="p-3 bg-surface-50 dark:bg-surface-950 rounded-lg">
                                <p className="text-sm font-medium mb-2">Buyer Contact</p>
                                {payload.buyerContact.email && (
                                  <p className="text-sm">{payload.buyerContact.email}</p>
                                )}
                                {payload.buyerContact.phone && (
                                  <p className="text-sm">{payload.buyerContact.phone}</p>
                                )}
                              </div>
                            )}

                            {/* Payment Info */}
                            <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                              <p className="text-sm font-medium mb-2">Payment</p>
                              <p className="text-sm font-mono break-all">{payload.paymentUri}</p>
                              {payload.txid && (
                                <p className="text-sm mt-1">
                                  <span className="text-gray-500">TXID: </span>
                                  <a
                                    href={storeOrderService.getPaymentVerificationUrl(payload.txid)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-yappr-600 hover:underline font-mono"
                                  >
                                    {payload.txid.slice(0, 16)}...
                                  </a>
                                </p>
                              )}
                            </div>

                            {/* Notes */}
                            {payload.notes && (
                              <div className="p-3 bg-surface-50 dark:bg-surface-950 rounded-lg">
                                <p className="text-sm font-medium mb-1">Notes from Buyer</p>
                                <p className="text-sm text-surface-500 dark:text-surface-400">{payload.notes}</p>
                              </div>
                            )}

                            {/* Refund Address */}
                            {payload.refundAddress && (
                              <div className="p-3 bg-surface-50 dark:bg-surface-950 rounded-lg">
                                <p className="text-sm font-medium mb-1">Refund Address</p>
                                <p className="text-sm font-mono break-all text-surface-500 dark:text-surface-400">
                                  {payload.refundAddress}
                                </p>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                            <p className="text-sm text-yellow-700 dark:text-yellow-300">
                              Unable to decode order details.
                            </p>
                          </div>
                        )}

                        {/* Current Status */}
                        {status && (
                          <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                            <p className="text-sm text-gray-500 mb-1">Current Status:</p>
                            <p className="font-medium text-blue-700 dark:text-blue-300">
                              {orderStatusService.getStatusLabel(status.status)}
                            </p>
                            {status.trackingNumber && (
                              <p className="text-sm mt-1">
                                Tracking: {status.trackingCarrier} - {status.trackingNumber}
                              </p>
                            )}
                            {status.message && (
                              <p className="text-sm mt-1 italic">{status.message}</p>
                            )}
                          </div>
                        )}

                        {/* Update Status Button */}
                        {!isUpdating && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setUpdateOrderId(order.id)
                              setNewStatus(status?.status || 'pending')
                              setTrackingNumber('')
                              setTrackingCarrier('')
                              setStatusMessage('')
                            }}
                          >
                            Update Status
                          </Button>
                        )}

                        {/* Status Update Form */}
                        {isUpdating && (
                          <StatusUpdateForm
                            currentStatus={newStatus}
                            onStatusChange={setNewStatus}
                            trackingNumber={trackingNumber}
                            onTrackingNumberChange={setTrackingNumber}
                            trackingCarrier={trackingCarrier}
                            onTrackingCarrierChange={setTrackingCarrier}
                            message={statusMessage}
                            onMessageChange={setStatusMessage}
                            onSubmit={() => handleUpdateStatus(order.id)}
                            onCancel={() => {
                              setUpdateOrderId(null)
                              setNewStatus('pending')
                              setTrackingNumber('')
                              setTrackingCarrier('')
                              setStatusMessage('')
                            }}
                            isSubmitting={isSubmitting}
                          />
                        )}
                      </div>
                    )}
                  </motion.div>
                )
              })}
            </div>
          )}
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

export default withAuth(SellerOrdersPage)
