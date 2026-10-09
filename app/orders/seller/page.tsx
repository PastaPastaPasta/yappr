'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  ShoppingBagIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloudArrowDownIcon
} from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { OrderStatusBadge, DigitalBadge } from '@/components/store'
import { OrderItemsList, StatusUpdateForm, DeliverDigitalModal } from '@/components/orders'
import { DeliveryContents } from '@/components/digital'
import { storefrontSupportsDigital } from '@/lib/constants'
import { orderDeliveryService } from '@/lib/services/order-delivery-service'
import { itemDeliverableService, type SellerKit } from '@/lib/services/item-deliverable-service'
import { fulfillOrder, FulfillmentError, KeyRecoveryError, kitsOf, loggableFulfillmentError, newerKits, toKitPayloads, type FulfillOrderResult } from '@/lib/services/digital-fulfillment'
import { digitalLines, digitalOrders, hasDigitalLines, isDigitalOnly, isReadyForBulkDelivery, planDelivery, withHeldDeliveries, type ItemListing } from '@/lib/services/digital-delivery-plan'
import { storeItemService } from '@/lib/services/store-item-service'
import { formatDate, formatOrderId } from '@/lib/utils/format'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { storeOrderService } from '@/lib/services/store-order-service'
import { orderStatusService } from '@/lib/services/order-status-service'
import { getPaymentVerificationUrl } from '@/lib/services/insight-api-service'
import { dpnsService } from '@/lib/services'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import toast from 'react-hot-toast'
import { ClipboardIcon } from '@heroicons/react/24/outline'
import type { StoreOrder, OrderStatusUpdate, OrderStatus, OrderPayload, OrderDelivery } from '@/lib/types'

const ORDERS_PAGE_SIZE = 50

interface DigitalState {
  deliveries: Map<string, OrderDelivery[]>
  kits: Map<string, SellerKit>
  /**
   * The seller's current listing of each item the page's digital orders name.
   * Order lines are buyer-written; only these say an item is digital, and in
   * which store.
   */
  listings: Map<string, ItemListing>
  /**
   * Orders whose deliveries could not be read. A failed read must never pass
   * for "nothing delivered yet", or "Deliver all" would send them again.
   */
  uncertain: Set<string>
  /** Orders whose deliveries WERE read (with or without any): no longer uncertain. */
  checked: Set<string>
}

/**
 * The seller's current listing of each item, read from Platform (never the
 * cache): these decide which kits an order may draw from.
 */
async function readListings(itemIds: string[]): Promise<Map<string, ItemListing>> {
  const items = await storeItemService.getManyFresh(itemIds)
  return new Map(items.map(({ id, storeId, fulfillment, title, basePrice, currency, variants, unreadableVariants, status, stockQuantity }): [string, ItemListing] =>
    [id, { storeId, fulfillment, title, basePrice, currency, variants, unreadableVariants, status, stockQuantity }]))
}

interface CurrentOrderState {
  status: OrderStatusUpdate | undefined
  delivered: boolean
  listings: Map<string, ItemListing>
  /** The kits of the order's items that were read and decrypted just now. */
  kits: Map<string, SellerKit>
}

/**
 * An order as it stands on Platform just before a bulk delivery: its latest
 * status, whether anything was delivered for it, and the current listing and
 * kit of each item it names. Null when any read fails.
 */
async function currentOrderState(orderId: string, itemIds: string[], sellerPrivateKey: Uint8Array): Promise<CurrentOrderState | null> {
  try {
    const [statuses, deliveries, listings, kits] = await Promise.all([
      orderStatusService.getLatestStatuses([orderId]),
      orderDeliveryService.getForOrders([orderId]),
      readListings(itemIds),
      itemDeliverableService.loadKits(itemIds, sellerPrivateKey),
    ])
    return { status: statuses.get(orderId), delivered: (deliveries.get(orderId)?.length ?? 0) > 0, listings, kits }
  } catch (error) {
    logger.error(`Could not re-read order ${orderId} before delivering it:`, error)
    return null
  }
}

/**
 * Deliveries already sent for the page's digital orders (decrypted, so the
 * seller can see what went out), and the seller's kits and listings for the
 * items in them.
 * Empty below storefront v6 and for pages with no digital order.
 */
async function loadDigitalState(
  pageOrders: StoreOrder[],
  payloads: ReadonlyMap<string, OrderPayload>,
  sellerPrivateKey: Uint8Array | null
): Promise<DigitalState> {
  const orders = storefrontSupportsDigital() ? digitalOrders(pageOrders, payloads) : []
  const uncertain = new Set<string>()
  if (orders.length === 0) return { deliveries: new Map(), kits: new Map(), listings: new Map(), uncertain, checked: new Set() }

  const itemIds = orders.flatMap((order) => {
    const payload = payloads.get(order.id)
    return payload ? digitalLines(payload).map((line) => line.itemId) : []
  })
  const [deliveries, kits, listings] = await Promise.all([
    orderDeliveryService.loadDecrypted(orders, (delivery, order) => {
      if (!sellerPrivateKey) throw new Error('No key on this device to decrypt the delivery')
      return orderDeliveryService.decryptAsSeller(delivery, order, sellerPrivateKey)
    }).catch((e) => {
      logger.error('Failed to load order deliveries:', e)
      for (const order of orders) uncertain.add(order.id)
      return new Map<string, OrderDelivery[]>()
    }),
    sellerPrivateKey
      ? itemDeliverableService.loadKits(itemIds, sellerPrivateKey).catch((e) => {
          logger.error('Failed to load delivery kits:', e)
          return new Map<string, SellerKit>()
        })
      : Promise.resolve(new Map<string, SellerKit>()),
    // An item that cannot be read has no listing, so it is never delivered in bulk.
    readListings(itemIds)
      .catch((e) => {
        logger.error('Failed to load listings for digital orders:', e)
        return new Map<string, ItemListing>()
      }),
  ])

  const checked = new Set(orders.map((order) => order.id).filter((orderId) => !uncertain.has(orderId)))
  return { deliveries, kits, listings, uncertain, checked }
}

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
      logger.error('Failed to decode order payload:', e)
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
    logger.error('Failed to decrypt order payload:', e)
    return null
  }
}

function SellerOrdersPage() {
  const router = useRouter()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()

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

  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasSellerKey, setHasSellerKey] = useState(true)
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()

  // Digital delivery (storefront v6)
  const supportsDigital = storefrontSupportsDigital()
  const [deliveries, setDeliveries] = useState<Map<string, OrderDelivery[]>>(new Map())
  const [kits, setKits] = useState<Map<string, SellerKit>>(new Map())
  const [listings, setListings] = useState<Map<string, ItemListing>>(new Map())
  const [deliverContext, setDeliverContext] = useState<{ orderId: string; sellerPrivateKey: Uint8Array } | null>(null)
  // The order whose receipts are being re-read before its delivery form opens.
  const [openingOrderId, setOpeningOrderId] = useState<string | null>(null)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)

  // Orders whose delivery or status read failed: kept out of "Deliver all".
  const [uncertainOrders, setUncertainOrders] = useState<Set<string>>(new Set())

  /**
   * Fold loaded deliveries and kits into the page (`replace` for a fresh first
   * page). Of two copies of a kit the newer revision wins: one in memory may
   * hold a pool this session advanced that a lagging read has not caught up
   * with, and a fresh read may show one another tab advanced.
   */
  const mergeDigitalState = useCallback((digital: DigitalState, replace = false) => {
    setDeliveries(prev => replace ? digital.deliveries : new Map([...prev, ...digital.deliveries]))
    setKits(prev => replace ? digital.kits : newerKits(prev, digital.kits))
    setListings(prev => replace ? digital.listings : new Map([...prev, ...digital.listings]))
    setUncertainOrders(prev => {
      const next = replace ? new Set<string>() : new Set(prev)
      for (const orderId of digital.checked) next.delete(orderId)
      for (const orderId of digital.uncertain) next.add(orderId)
      return next
    })
  }, [])

  /** Fetch one page (newest first), decrypt it, and resolve its statuses and buyer names. */
  const loadOrdersPage = useCallback(async (sellerId: string, startAfter?: string) => {
    const { orders: pageOrders, nextCursor: cursor } = await storeOrderService.getSellerOrders(sellerId, { limit: ORDERS_PAGE_SIZE, startAfter })

    // Get seller's encryption private key for decryption
    const sellerPrivateKey = getEncryptionKeyBytes(sellerId)
    setHasSellerKey(sellerPrivateKey !== null)

    // Decrypt order payloads
    const payloadMap = new Map<string, OrderPayload>()
    await Promise.all(
      pageOrders.map(async (order) => {
        const payload = await decryptSellerOrderPayload(order, sellerPrivateKey)
        if (payload) {
          payloadMap.set(order.id, payload)
        }
      })
    )

    // Latest genuine status per order: one `in` query per 100 orders
    // (v2 gates the writer against the order's sellerId, so every update here is the seller's own).
    let statusesFailed = false
    const [statusMap, usernameMap, digital] = await Promise.all([
      orderStatusService.getLatestStatuses(pageOrders.map((order) => order.id)).catch((e) => {
        logger.error('Failed to load order statuses:', e)
        statusesFailed = true
        return new Map<string, OrderStatusUpdate>()
      }),
      dpnsService.resolveUsernamesBatch([...new Set(pageOrders.map((order) => order.buyerId))]).catch((e) => {
        logger.error('Failed to resolve buyer usernames:', e)
        return new Map<string, string | null>()
      }),
      loadDigitalState(pageOrders, payloadMap, sellerPrivateKey),
    ])

    setOrders(prev => startAfter ? [...prev, ...pageOrders] : pageOrders)
    setOrderPayloads(prev => startAfter ? new Map([...prev, ...payloadMap]) : payloadMap)
    setOrderStatuses(prev => startAfter ? new Map([...prev, ...statusMap]) : statusMap)
    const names = [...usernameMap].filter((entry): entry is [string, string] => entry[1] !== null)
    setBuyerUsernames(prev => startAfter ? new Map([...prev, ...names]) : new Map(names))
    // Without statuses a cancelled or refunded order looks open: hold the page back from bulk delivery.
    if (statusesFailed) for (const order of pageOrders) digital.uncertain.add(order.id)
    mergeDigitalState(digital, !startAfter)
    setNextCursor(cursor)
    setHasMore(pageOrders.length === ORDERS_PAGE_SIZE)
  }, [mergeDigitalState])

  // Load seller orders
  useEffect(() => {
    if (!sdkReady || !user?.identityId) return

    const loadOrders = async () => {
      try {
        setIsLoading(true)
        await loadOrdersPage(user.identityId)
      } catch (error) {
        logger.error('Failed to load seller orders:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadOrders().catch((error) => logger.error(error))
  }, [sdkReady, user?.identityId, loadOrdersPage])

  const handleLoadMore = async () => {
    if (!user?.identityId || !nextCursor || isLoadingMore) return
    setIsLoadingMore(true)
    try {
      await loadOrdersPage(user.identityId, nextCursor)
    } catch (error) {
      logger.error('Failed to load more seller orders:', error)
      toast.error('Failed to load more orders. Please try again.')
    } finally {
      setIsLoadingMore(false)
    }
  }

  /** Once the key is stored, decrypt the orders already on the page. */
  const handleAddEncryptionKey = () => {
    openEncryptionKeyModal('read_orders', () => {
      const sellerPrivateKey = user?.identityId ? getEncryptionKeyBytes(user.identityId) : null
      if (!sellerPrivateKey) return
      setHasSellerKey(true)
      Promise.all(orders.map(async (order) => [order.id, await decryptSellerOrderPayload(order, sellerPrivateKey)] as const))
        .then(async (entries) => {
          const decrypted = entries.filter((entry): entry is readonly [string, OrderPayload] => entry[1] !== null)
          setOrderPayloads(prev => new Map([...prev, ...decrypted]))
          mergeDigitalState(await loadDigitalState(orders, new Map(decrypted), sellerPrivateKey))
        })
        .catch((error) => logger.error('Failed to decrypt seller orders:', error))
    })
  }

  const kitPayloads = useMemo(() => toKitPayloads(kits), [kits])
  const readyOrders = useMemo(() => supportsDigital
    ? orders.filter((order) => {
        const payload = orderPayloads.get(order.id)
        return payload !== undefined && !uncertainOrders.has(order.id) &&
          isReadyForBulkDelivery({
            payload,
            storeId: order.storeId,
            latestStatus: orderStatuses.get(order.id)?.status,
            alreadyDelivered: (deliveries.get(order.id)?.length ?? 0) > 0,
            kits: kitPayloads,
            listings,
          })
      })
    : [], [supportsDigital, orders, orderPayloads, orderStatuses, deliveries, kitPayloads, listings, uncertainOrders])

  /** Fold a fulfilment into the page: its delivery, its status, and the kits it drew on. */
  const applyFulfillment = useCallback((orderId: string, result: FulfillOrderResult) => {
    const { delivery, status, updatedKits } = result
    setDeliveries(prev => new Map(prev).set(orderId, [...(prev.get(orderId) ?? []), delivery]))
    if (status) setOrderStatuses(prev => new Map(prev).set(orderId, status))
    if (updatedKits.size > 0) setKits(prev => newerKits(prev, updatedKits))
    // Which codes a pending delivery holds is recorded nowhere else once the page reloads.
    if (result.pendingRecoveryText) toast.error(`Order ${formatOrderId(orderId)}: ${result.pendingRecoveryText}`, { duration: Infinity })
  }, [])

  /** Pools a failed fulfilment wrote (reserved, or restored) are newer than the page's copies. */
  const applyFailedFulfillment = useCallback((error: unknown) => {
    if (error instanceof FulfillmentError && error.updatedKits.size > 0) setKits(prev => newerKits(prev, error.updatedKits))
  }, [])

  /**
   * Re-read one order's receipts from the chain and fold them into the page,
   * keeping any already held that the read does not show yet (pending, or a
   * lagging node). Throws when the read fails: delivery waits for a
   * successful one.
   */
  const refreshOrderDeliveries = useCallback(async (order: StoreOrder, sellerPrivateKey: Uint8Array): Promise<OrderDelivery[]> => {
    const read = await orderDeliveryService.loadDecrypted([order], (delivery, owner) => orderDeliveryService.decryptAsSeller(delivery, owner, sellerPrivateKey))
    const fresh = read.get(order.id) ?? []
    setDeliveries(prev => new Map(prev).set(order.id, withHeldDeliveries(fresh, prev.get(order.id) ?? [])))
    return fresh
  }, [])

  /**
   * Open the delivery form on the order's receipts as they stand now: the
   * page's copy may predate a delivery made on another device, and a code
   * line would default to codes it was already sent.
   */
  const openDelivery = (order: StoreOrder, sellerPrivateKey: Uint8Array) => {
    setOpeningOrderId(order.id)
    refreshOrderDeliveries(order, sellerPrivateKey)
      .then(() => setDeliverContext({ orderId: order.id, sellerPrivateKey }))
      .catch((error) => {
        logger.error(`Could not re-read order ${order.id}'s deliveries:`, error)
        toast.error('Could not check what was already delivered for this order. Try again.')
      })
      .finally(() => setOpeningOrderId(null))
  }

  /** The seller key is needed to read kits and to key the delivery; ask for it if this device lacks it. */
  const withSellerKey = (then: (sellerPrivateKey: Uint8Array) => void) => {
    const sellerPrivateKey = user?.identityId ? getEncryptionKeyBytes(user.identityId) : null
    if (sellerPrivateKey) {
      then(sellerPrivateKey)
      return
    }
    openEncryptionKeyModal('sell_digital', () => {
      const key = user?.identityId ? getEncryptionKeyBytes(user.identityId) : null
      if (!key) return
      setHasSellerKey(true)
      loadDigitalState(orders, orderPayloads, key)
        .then((digital) => {
          mergeDigitalState(digital)
          then(key)
        })
        .catch((error) => logger.error('Failed to load digital delivery state:', error))
    })
  }

  /**
   * Deliver every order that is ready (see isReadyForBulkDelivery), one at a
   * time so each draws license keys from the pool the previous one left.
   */
  const handleDeliverReady = async (sellerPrivateKey: Uint8Array) => {
    // A status write in flight could close an order this batch is about to send.
    // Nor while a delivery form is opening: it and the batch could each miss the other's receipts.
    if (!user?.identityId || bulkProgress || isSubmitting || openingOrderId) return
    const batch = readyOrders
    let currentKits = new Map(kits)
    let delivered = 0
    const skipped: string[] = []
    let firstFailure: string | null = null
    setBulkProgress({ done: 0, total: batch.length })
    try {
      for (const [index, order] of batch.entries()) {
        const payload = orderPayloads.get(order.id)
        // Re-check the order as it stands NOW, not as the page loaded it: its
        // status, deliveries, listings and kits may all have changed on
        // another device since (cancelled, delivered, switched to shipped, a
        // kit's timing changed). Any read that fails holds the order.
        const now = payload ? await currentOrderState(order.id, digitalLines(payload).map((line) => line.itemId), sellerPrivateKey) : null
        if (now?.status) setOrderStatuses(prev => new Map(prev).set(order.id, now.status as OrderStatusUpdate))
        if (now) {
          setListings(prev => new Map([...prev, ...now.listings]))
          // A pool this batch reserved may be newer than a lagging read: keep the newer.
          currentKits = newerKits(currentKits, now.kits)
          setKits(prev => newerKits(prev, now.kits))
        }
        // Every line's kit must have been read just now; a stale copy never stands in.
        const kitsNow = now && payload ? kitsOf(digitalLines(payload).map((line) => line.itemId), currentKits, now.kits) : null
        const stillReady = payload && now && kitsNow && isReadyForBulkDelivery({
          payload,
          storeId: order.storeId,
          latestStatus: now.status?.status,
          alreadyDelivered: now.delivered,
          kits: toKitPayloads(kitsNow),
          listings: now.listings,
        })
        const plan = payload && stillReady ? planDelivery(payload, toKitPayloads(currentKits), now.listings) : null
        if (!payload || !plan) {
          skipped.push(formatOrderId(order.id))
        } else {
          try {
            const result = await fulfillOrder({
              sellerId: user.identityId,
              order,
              delivery: plan.delivery,
              consumedKeys: plan.consumedKeys,
              kits: currentKits,
              markDelivered: isDigitalOnly(payload.items),
              sellerPrivateKey,
            })
            currentKits = newerKits(currentKits, result.updatedKits)
            applyFulfillment(order.id, result)
            for (const warning of result.warnings) toast.error(warning, { duration: 10_000 })
            delivered++
          } catch (error) {
            if (error instanceof FulfillmentError) currentKits = newerKits(currentKits, error.updatedKits)
            applyFailedFulfillment(error)
            // Recovery details carry plaintext license keys: shown to the seller, never logged.
            logger.error(`Bulk delivery failed for order ${order.id}:`, loggableFulfillmentError(error))
            skipped.push(formatOrderId(order.id))
            firstFailure ??= error instanceof Error ? error.message : 'unknown error'
            if (error instanceof KeyRecoveryError) toast.error(`Order ${formatOrderId(order.id)}: ${error.recoveryText()}`, { duration: Infinity })
          }
        }
        setBulkProgress({ done: index + 1, total: batch.length })
      }
    } finally {
      setBulkProgress(null)
    }
    if (delivered > 0) toast.success(`Delivered ${delivered} order${delivered === 1 ? '' : 's'}`)
    if (skipped.length > 0) toast.error(`Not delivered: ${skipped.join(', ')}.${firstFailure ? ` ${firstFailure}` : ''} Open each order to deliver it.`, { duration: 15_000 })
  }

  const handleUpdateStatus = async (orderId: string) => {
    // "Deliver all" decides from each order's status: no status change while it runs.
    if (!user?.identityId || bulkProgress) return

    setIsSubmitting(true)
    try {
      const order = orders.find((candidate) => candidate.id === orderId)
      if (!order) throw new Error('Order not found')
      const update = await orderStatusService.createStatusUpdate(user.identityId, orderId, {
        status: newStatus,
        trackingNumber: trackingNumber || undefined,
        trackingCarrier: trackingCarrier || undefined,
        message: statusMessage || undefined,
        buyerId: order.buyerId
      })

      setOrderStatuses(prev => new Map(prev).set(orderId, update))
      setUpdateOrderId(null)
      setNewStatus('pending')
      setTrackingNumber('')
      setTrackingCarrier('')
      setStatusMessage('')
    } catch (error) {
      logger.error('Failed to update status:', error)
      toast.error('Failed to update order status. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const deliverOrder = deliverContext ? orders.find((candidate) => candidate.id === deliverContext.orderId) : undefined
  const deliverPayload = deliverOrder ? orderPayloads.get(deliverOrder.id) : undefined

  return (
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
          </PageHeader>

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
            <>
            {!hasSellerKey && orders.some(order => !orderPayloads.has(order.id)) && (
              <div role="alert" className="m-4 p-4 border border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg space-y-3">
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  Order details are encrypted to your store&apos;s encryption key. Add it on this device to read them.
                </p>
                <Button size="sm" onClick={handleAddEncryptionKey}>Add Encryption Key</Button>
              </div>
            )}
            {(readyOrders.length > 0 || bulkProgress) && (
              <div className="m-4 p-4 border border-sky-200 bg-sky-50 dark:bg-sky-900/20 dark:border-sky-800 rounded-lg flex items-center justify-between gap-4">
                <p className="text-sm text-sky-800 dark:text-sky-200 flex items-center gap-2">
                  <CloudArrowDownIcon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                  {bulkProgress
                    ? `Delivering ${Math.min(bulkProgress.done + 1, bulkProgress.total)} of ${bulkProgress.total}…`
                    : `${readyOrders.length} digital order${readyOrders.length === 1 ? ' is' : 's are'} ready to deliver.`}
                </p>
                <Button
                  size="sm"
                  disabled={bulkProgress !== null || isSubmitting || openingOrderId !== null}
                  onClick={() => withSellerKey((key) => { handleDeliverReady(key).catch((error) => logger.error(error)) })}
                >
                  Deliver all
                </Button>
              </div>
            )}
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {orders.map((order, index) => {
                const status = orderStatuses.get(order.id)
                const payload = orderPayloads.get(order.id)
                const paymentVerificationUrl = payload?.txid
                  ? getPaymentVerificationUrl(payload.txid, payload.paymentUri)
                  : null
                const isExpanded = expandedOrder === order.id
                const isUpdating = updateOrderId === order.id
                const isDigitalOrder = supportsDigital && hasDigitalLines(payload)
                const orderDeliveries = deliveries.get(order.id) ?? []
                const lastDelivery = orderDeliveries[orderDeliveries.length - 1]
                const missingKits = isDigitalOrder && payload ? planDelivery(payload, kitPayloads, listings).missingKits : []

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
                          <p className="text-sm text-gray-500 flex items-center gap-2">
                            {formatDate(order.createdAt)}
                            {isDigitalOrder && <DigitalBadge />}
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
                        <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
                          <p className="text-sm font-medium mb-1">Order ID</p>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard.writeText(order.id)
                                .then(() => toast.success('Order ID copied'))
                                .catch(() => toast.error('Failed to copy'))
                            }}
                            className="flex items-center gap-2 text-sm font-mono text-gray-600 dark:text-gray-400 hover:text-yappr-500 transition-colors"
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
                              showSku
                            />

                            {/* Shipping Address */}
                            {payload.shippingAddress && (
                              <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
                                <p className="text-sm font-medium mb-2">Shipping Address</p>
                                <p className="text-sm">{payload.shippingAddress.name}</p>
                                <p className="text-sm text-gray-600 dark:text-gray-400">{payload.shippingAddress.street}</p>
                                <p className="text-sm text-gray-600 dark:text-gray-400">
                                  {payload.shippingAddress.city}{payload.shippingAddress.state ? `, ${payload.shippingAddress.state}` : ''} {payload.shippingAddress.postalCode}
                                </p>
                                <p className="text-sm text-gray-600 dark:text-gray-400">{payload.shippingAddress.country}</p>
                              </div>
                            )}

                            {/* Contact Info */}
                            {(payload.buyerContact.email || payload.buyerContact.phone) && (
                              <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
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
                                  {paymentVerificationUrl ? (
                                    <a
                                      href={paymentVerificationUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-yappr-600 hover:underline font-mono"
                                    >
                                      {payload.txid.slice(0, 16)}...
                                    </a>
                                  ) : (
                                    <span className="font-mono break-all">{payload.txid}</span>
                                  )}
                                </p>
                              )}
                            </div>

                            {/* Notes */}
                            {payload.notes && (
                              <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
                                <p className="text-sm font-medium mb-1">Notes from Buyer</p>
                                <p className="text-sm text-gray-600 dark:text-gray-400">{payload.notes}</p>
                              </div>
                            )}

                            {/* Refund Address */}
                            {payload.refundAddress && (
                              <div className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
                                <p className="text-sm font-medium mb-1">Refund Address</p>
                                <p className="text-sm font-mono break-all text-gray-600 dark:text-gray-400">
                                  {payload.refundAddress}
                                </p>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                            <p className="text-sm text-yellow-700 dark:text-yellow-300">
                              {hasSellerKey ? 'Unable to decode order details.' : 'Add your encryption key to read this order.'}
                            </p>
                          </div>
                        )}

                        {/* Digital delivery */}
                        {isDigitalOrder && (
                          <div className="p-3 bg-sky-50 dark:bg-sky-900/20 rounded-lg space-y-2">
                            <p className="text-sm font-medium flex items-center gap-2">
                              <CloudArrowDownIcon className="h-4 w-4" aria-hidden="true" />
                              Digital delivery
                            </p>
                            {lastDelivery ? (
                              <>
                                <p className={`text-sm ${lastDelivery.unconfirmed ? 'text-yellow-700 dark:text-yellow-300' : 'text-green-700 dark:text-green-300'}`}>
                                  {lastDelivery.unconfirmed ? 'Sent, awaiting confirmation. Check before sending again.' : `Delivered ${formatDate(lastDelivery.createdAt)}`}
                                  {orderDeliveries.length > 1 && ` (${orderDeliveries.length} deliveries)`}
                                </p>
                                <details>
                                  <summary className="text-sm text-gray-600 dark:text-gray-400 cursor-pointer">What was sent</summary>
                                  <div className="mt-2">
                                    <DeliveryContents deliveries={orderDeliveries} />
                                  </div>
                                </details>
                              </>
                            ) : (
                              <p className="text-sm text-gray-600 dark:text-gray-400">
                                {uncertainOrders.has(order.id) ? 'Could not load this order\'s delivery state. Reload before delivering it.' : 'Not delivered yet.'}
                                {missingKits.length > 0 && ` No saved delivery content for ${missingKits.join(', ')}: attach files or links when you deliver.`}
                              </p>
                            )}
                            <Button
                              size="sm"
                              variant={lastDelivery ? 'outline' : 'default'}
                              // Unknown delivery state must not read as "not delivered": it would take new codes.
                              disabled={bulkProgress !== null || uncertainOrders.has(order.id) || openingOrderId !== null}
                              onClick={() => withSellerKey((sellerPrivateKey) => openDelivery(order, sellerPrivateKey))}
                            >
                              {openingOrderId === order.id ? 'Checking…' : lastDelivery ? 'Send again' : 'Deliver now'}
                            </Button>
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
                            disabled={bulkProgress !== null}
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
                            isSubmitting={isSubmitting || bulkProgress !== null}
                          />
                        )}
                      </div>
                    )}
                  </motion.div>
                )
              })}
            </div>
            {hasMore && (
              <div className="p-4 flex justify-center">
                <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingMore}>
                  {isLoadingMore ? 'Loading...' : 'Load more orders'}
                </Button>
              </div>
            )}
            </>
          )}
          {deliverOrder && deliverPayload && deliverContext && user?.identityId && (
            <DeliverDigitalModal
              key={deliverOrder.id}
              isOpen
              onClose={() => setDeliverContext(null)}
              order={deliverOrder}
              payload={deliverPayload}
              kits={kits}
              listings={listings}
              sellerId={user.identityId}
              sellerPrivateKey={deliverContext.sellerPrivateKey}
              previousDeliveries={deliveries.get(deliverOrder.id) ?? []}
              refreshDeliveries={() => refreshOrderDeliveries(deliverOrder, deliverContext.sellerPrivateKey)}
              onDelivered={(result) => applyFulfillment(deliverOrder.id, result)}
              onFailed={applyFailedFulfillment}
            />
          )}
    </PageShell>
  )
}

export default withAuth(SellerOrdersPage)
