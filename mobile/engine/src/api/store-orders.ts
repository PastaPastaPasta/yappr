import { logger } from '@/lib/logger'
import { STOREFRONT_DOCUMENT_TYPES, storefrontStatusIsSealed, storefrontSupportsDigital } from '@/lib/constants'
import { sellerOrderDeliveryKey } from '@/lib/crypto/digital-delivery'
import { cartLineKey, cartService } from '@/lib/services/cart-service'
import {
  deliveredFor, deliveryCompletesOrder, digitalLines, hasDigitalLines, isDigitalOnly, isReadyForBulkDelivery, kitDeliveryFitError,
  lineCoverage, lineProblems, MAX_DELIVERY_MESSAGE_LENGTH, planBlockers, planDelivery, wholeOrderProblems, withHeldDeliveries, type ItemListing,
} from '@/lib/services/digital-delivery-plan'
import { fulfillOrder, FulfillmentError, KeyRecoveryError, kitsOf, newerKits, toKitPayloads } from '@/lib/services/digital-fulfillment'
import { getPaymentVerificationUrl } from '@/lib/services/insight-api-service'
import { itemDeliverableService, KitWriteUncertainError, type SellerKit } from '@/lib/services/item-deliverable-service'
import { orderDeliveryService } from '@/lib/services/order-delivery-service'
import { openStatusNotesAsBuyer, openStatusNotesAsSeller, orderStatusService, StatusNoteError } from '@/lib/services/order-status-service'
import { checkShipping, finalShippingCheck, shippingZoneService, type ShippingCheck } from '@/lib/services/shipping-zone-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { storeOrderService } from '@/lib/services/store-order-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { storeService } from '@/lib/services/store-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { formatPrice } from '@/lib/utils/format'
import type {
  BuyerContact, DigitalAsset, ItemDeliverablePayload, OrderDelivery, OrderItem, OrderPayload, OrderStatus,
  OrderStatusUpdate, ShippingAddress, Store, StoreOrder,
} from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import { badRequest, readFailure, requireViewer } from '../dto/hydrate'
import { decodeCursor, encodeCursor } from '../dto/cursor'
import type { Page } from './dto'
import { NotSentError, type TicketStore } from '../writes/tickets'
import { signer } from '../writes/handler-kit'
import { wasConfirmed } from '../writes/lib-results'
import type { TicketDocument, WriteTicket } from '../writes/types'
import { checkoutBlockerMessage, checkoutReadiness, cleanAddress, cleanContact, sellerEncryptionKey, storefrontDoc } from './store-shared'

const ORDERS_PAGE = 20
const ORDER_STATUSES: readonly OrderStatus[] = ['pending', 'payment_received', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'disputed']
const CART_CHANGED_MESSAGE = 'Your cart changed since you reviewed this order. Review it again before continuing.'
const FULFILLMENT_CHANGED_MESSAGE = 'The seller changed how one of these products is delivered (shipped or digital). Review your order and shipping again before continuing.'

/** An order's latest status as the app shows it; tracking and message opened where they were sealed. */
export interface OrderStatusDTO {
  status: OrderStatus
  label: string
  createdAt: Date
  trackingNumber?: string
  trackingCarrier?: string
  trackingUrl?: string
  message?: string
}

export type DeliveredAssetDTO =
  | { kind: 'link'; label: string; url: string; code?: string }
  | { kind: 'code'; label: string; code: string }
  | { kind: 'file'; name: string; size: number; mime?: string }

export interface DeliveredItemDTO {
  itemTitle: string
  variantLabel?: string
  instructions?: string
  licenseKeys?: string[]
  assets: DeliveredAssetDTO[]
}

/** One delivery receipt. `readable` false: this device cannot decrypt it (no key, or not for this account). */
export interface DeliveryDTO {
  id: string
  createdAt: Date
  /** Seller side: sent this session but not yet seen on chain. */
  unconfirmed: boolean
  readable: boolean
  message?: string
  items: DeliveredItemDTO[]
}

interface OrderBaseDTO {
  id: string
  storeId: string
  sellerId: string
  buyerId: string
  createdAt: Date
  /** The decrypted order; null when this device has no key for it (`locked`) or it could not be read. */
  payload: OrderPayload | null
  locked: boolean
  status: OrderStatusDTO | null
  /** The order has digital lines. */
  digital: boolean
  deliveries: DeliveryDTO[]
}

export interface BuyerOrderDTO extends OrderBaseDTO {
  storeName: string | null
  /** The buyer reviewed this order already. */
  reviewed: boolean
}

export interface SellerOrderDTO extends OrderBaseDTO {
  buyerName: string | null
  /** A link to the payment on a block explorer, for a Dash txid. */
  paymentUrl: string | null
  /** The order's deliveries or status could not be read: never deliver it in bulk. */
  uncertain: boolean
  /** Digital lines with no saved delivery content. */
  missingKits: string[]
  /** "Deliver all" would deliver it (web `isReadyForBulkDelivery`). */
  readyToDeliver: boolean
}

export interface PlaceOrderInput {
  storeId: string
  /** Null: no shipping (an all-digital order, or the buyer asked for none). */
  shipTo?: ShippingAddress | null
  contact?: BuyerContact | null
  paymentUri: string
  txid?: string
  notes?: string
  refundAddress?: string
  /** What the buyer reviewed: each line's key, quantity and whether it is digital, and the shipping cost. */
  reviewed: { lines: { key: string; quantity: number; digital: boolean }[]; shippingCost: number }
}

export interface StatusUpdateInput {
  orderId: string
  status: OrderStatus
  trackingNumber?: string
  trackingCarrier?: string
  message?: string
}

export interface DeliveryLineDTO {
  index: number
  /** Extras for this order (`DeliverInput.extras`) are keyed by it. */
  itemId: string
  itemTitle: string
  variantLabel?: string
  quantity: number
  /** Some earlier receipt may hold it already. */
  sentBefore: boolean
  /** Its product sells unique codes (license keys). */
  sellsCodes: boolean
  /** Codes it is still owed (never one that may already be out). */
  codesOwed: number
  /** What its kit sends: asset labels, codes and instructions. */
  contents: string[]
}

/** What delivering now would send (web `DeliverDigitalModal`), worked out from the receipts as just read. */
export interface DeliveryPlanDTO {
  orderId: string
  lines: DeliveryLineDTO[]
  /** The lines delivered by default: those still owed something (every line when none is). */
  selected: number[]
  /** Reasons nothing can be sent as it stands. */
  blockers: string[]
  /** Lines that disagree with the listing (title, variant, price): the seller must check them first. */
  warnings: string[]
  /** It finishes the order, so it is marked Delivered (web's default for an all-digital order). */
  marksDelivered: boolean
  previousDeliveries: number
}

export interface DeliverInput {
  orderId: string
  /** Line indexes to deliver; the plan's `selected` by default. */
  lines?: number[]
  message?: string
  /** Links or codes for this order only, by item id, added to each item's kit. */
  extras?: Record<string, ({ kind: 'link'; label: string; url: string; code?: string } | { kind: 'code'; label: string; code: string })[]>
  /** The seller checked the plan's warnings. */
  acknowledged?: boolean
}

export interface DeliverResultDTO {
  /** Sent but not yet seen on chain: it shows in the buyer's library once it lands. */
  pending: boolean
  warnings: string[]
  /**
   * Shown to the seller, never logged: for a pending delivery holding unique
   * codes, which codes are out of their pools.
   */
  recoveryText: string | null
}

export interface BulkDeliveryDTO {
  delivered: number
  /** Order ids not delivered. */
  skipped: string[]
  firstFailure: string | null
  warnings: string[]
  /** Codes out of their pools (see DeliverResultDTO.recoveryText), per order; never logged. */
  recoveryTexts: string[]
}

/** The seller's editable delivery content for one digital product (web `DigitalKitEditor`). */
export interface KitDTO {
  instructions: string
  /** Files stay as uploaded on yap.pr; the app keeps them in the kit unchanged. */
  files: { name: string; size: number }[]
  links: { label: string; url: string; code?: string }[]
  codes: { label: string; code: string }[]
  /** Null when the product sells no unique codes. */
  licenseKeys: string[] | null
  deliverWhen: 'payment_confirmed' | 'on_order'
}

export type KitReadDTO = { locked: true } | { locked: false; kit: KitDTO | null }

/** Encryption keys of sellers, fetched once per engine. */
const sellerKeys = new Map<string, Uint8Array>()

async function cachedSellerKey(sellerId: string): Promise<Uint8Array | null> {
  const known = sellerKeys.get(sellerId)
  if (known) return known
  const key = await sellerEncryptionKey(sellerId).catch(() => null)
  if (key) sellerKeys.set(sellerId, key)
  return key
}

function statusDTO(update: OrderStatusUpdate | undefined): OrderStatusDTO | null {
  if (!update) return null
  const trackingUrl = update.trackingCarrier && update.trackingNumber ? orderStatusService.getTrackingUrl(update.trackingCarrier, update.trackingNumber) : null
  return {
    status: update.status,
    label: orderStatusService.getStatusLabel(update.status),
    createdAt: update.createdAt,
    ...(update.trackingNumber ? { trackingNumber: update.trackingNumber } : {}),
    ...(update.trackingCarrier ? { trackingCarrier: update.trackingCarrier } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
    ...(update.message ? { message: update.message } : {}),
  }
}

function assetDTO(asset: DigitalAsset): DeliveredAssetDTO {
  switch (asset.kind) {
    case 'link': return { kind: 'link', label: asset.label, url: asset.url, ...(asset.code ? { code: asset.code } : {}) }
    case 'code': return { kind: 'code', label: asset.label, code: asset.code }
    case 'file': return { kind: 'file', name: asset.name, size: asset.size, ...(asset.mime ? { mime: asset.mime } : {}) }
  }
}

function deliveryDTO(delivery: OrderDelivery): DeliveryDTO {
  const payload = delivery.payload
  return {
    id: delivery.id,
    createdAt: delivery.createdAt,
    unconfirmed: delivery.unconfirmed === true,
    readable: payload !== undefined,
    ...(payload?.message ? { message: payload.message } : {}),
    items: (payload?.items ?? []).map(item => ({
      itemTitle: item.itemTitle,
      ...(item.variantLabel ? { variantLabel: item.variantLabel } : {}),
      ...(item.instructions ? { instructions: item.instructions } : {}),
      ...(item.licenseKeys?.length ? { licenseKeys: item.licenseKeys } : {}),
      assets: item.assets.map(assetDTO),
    })),
  }
}

function pageOf<T extends { id: string }>(items: T[], kind: string, full: boolean): Page<T> {
  const last = items[items.length - 1]
  return { items, cursor: full && last ? encodeCursor(kind, { after: last.id }) : null, hasMore: full && last !== undefined }
}

const afterOf = (cursor: string | null | undefined, kind: string) => decodeCursor<{ after: string }>(cursor, kind)?.after

/** The seller's current listing of each item (never the cache): these decide which kits an order may draw from. */
async function readListings(itemIds: string[]): Promise<Map<string, ItemListing>> {
  const items = await storeItemService.getManyFresh(itemIds)
  return new Map(items.map(({ id, storeId, fulfillment, title, basePrice, currency, variants, unreadableVariants, status, stockQuantity }): [string, ItemListing] =>
    [id, { storeId, fulfillment, title, basePrice, currency, variants, unreadableVariants, status, stockQuantity }]))
}

/** One order of the viewer's, as buyer or seller; BAD_REQUEST when it is neither's. */
async function readOrder(orderId: string): Promise<StoreOrder> {
  let order: StoreOrder | null
  try {
    order = await storeOrderService.get(orderId)
  } catch (error) {
    throw readFailure(error)
  }
  if (!order) throw new RpcError('This order could not be found', 'TARGET_GONE')
  return order
}

/** The seller's view of a page of orders (web `/orders/seller` `loadOrdersPage`). */
async function sellerOrders(seller: string, orders: StoreOrder[]): Promise<SellerOrderDTO[]> {
  const key = getEncryptionKeyBytes(seller)
  const payloads = new Map<string, OrderPayload>()
  await Promise.all(orders.map(async order => {
    if (!key) return
    try {
      payloads.set(order.id, await storeOrderService.decryptOrderPayload(order.encryptedPayload, order.nonce, order.storeId, key, null, false))
    } catch {
      // Shown as "could not be read".
    }
  }))
  let statusesFailed = false
  const [statusMap, names] = await Promise.all([
    orderStatusService.getLatestStatuses(orders.map(order => order.id)).catch(() => {
      statusesFailed = true
      return new Map<string, OrderStatusUpdate>()
    }),
    dpnsService.resolveUsernamesBatch([...new Set(orders.map(order => order.buyerId))]).catch(() => new Map<string, string | null>()),
  ])
  const statuses = storefrontStatusIsSealed() && key ? openStatusNotesAsSeller(statusMap, orders, key) : statusMap

  const digitalOrders = storefrontSupportsDigital() ? orders.filter(order => hasDigitalLines(payloads.get(order.id))) : []
  const itemIds = [...new Set(digitalOrders.flatMap(order => digitalLines(payloads.get(order.id) as OrderPayload).map(line => line.itemId)))]
  let deliveriesFailed = false
  const [deliveries, kits, listings] = digitalOrders.length === 0
    ? [new Map<string, OrderDelivery[]>(), new Map<string, SellerKit>(), new Map<string, ItemListing>()]
    : await Promise.all([
        orderDeliveryService.loadDecrypted(digitalOrders, (delivery, order) => {
          if (!key) throw new Error('No key on this device to decrypt the delivery')
          return orderDeliveryService.decryptAsSeller(delivery, order, key)
        }).catch((error: unknown) => {
          logger.error('Failed to load order deliveries:', error)
          deliveriesFailed = true
          return new Map<string, OrderDelivery[]>()
        }),
        key ? itemDeliverableService.loadKits(itemIds, key).catch(() => new Map<string, SellerKit>()) : Promise.resolve(new Map<string, SellerKit>()),
        readListings(itemIds).catch(() => new Map<string, ItemListing>()),
      ])
  const kitPayloads = toKitPayloads(kits)

  return orders.map(order => {
    const payload = payloads.get(order.id) ?? null
    const digital = storefrontSupportsDigital() && hasDigitalLines(payload ?? undefined)
    const orderDeliveries = deliveries.get(order.id) ?? []
    const uncertain = digital && (deliveriesFailed || statusesFailed)
    const status = statuses.get(order.id)
    return {
      id: order.id,
      storeId: order.storeId,
      sellerId: order.sellerId,
      buyerId: order.buyerId,
      createdAt: order.createdAt,
      payload,
      locked: !key,
      status: statusDTO(status),
      digital,
      deliveries: orderDeliveries.map(deliveryDTO),
      buyerName: names.get(order.buyerId) ?? null,
      paymentUrl: payload?.txid ? getPaymentVerificationUrl(payload.txid, payload.paymentUri) : null,
      uncertain,
      missingKits: digital && payload ? planDelivery(payload, kitPayloads, listings).missingKits : [],
      readyToDeliver: digital && payload !== null && !uncertain && isReadyForBulkDelivery({
        payload, storeId: order.storeId, latestStatus: status?.status, alreadyDelivered: orderDeliveries.length > 0, kits: kitPayloads, listings,
      }),
    }
  })
}

/** The buyer's view of a page of orders (web `/orders`). */
async function buyerOrders(buyer: string, orders: StoreOrder[]): Promise<BuyerOrderDTO[]> {
  const key = getEncryptionKeyBytes(buyer)
  const orderIds = orders.map(order => order.id)
  const [stores, reviews, statusMap] = await Promise.all([
    storeService.getMany([...new Set(orders.map(order => order.storeId))]).catch(() => [] as Store[]),
    storeReviewService.getOrderReviews(orderIds).catch(() => new Map<string, unknown>()),
    orderStatusService.getLatestStatuses(orderIds).catch(() => new Map<string, OrderStatusUpdate>()),
  ])
  const names = new Map(stores.map(store => [store.id, store.name]))
  const keys = new Map<string, Uint8Array>()
  for (const sellerId of new Set(orders.map(order => order.sellerId))) {
    const sellerKey = await cachedSellerKey(sellerId)
    if (sellerKey) keys.set(sellerId, sellerKey)
  }
  const payloads = new Map<string, OrderPayload>()
  await Promise.all(orders.map(async order => {
    const sellerKey = keys.get(order.sellerId)
    if (!key || !sellerKey) return
    try {
      payloads.set(order.id, await storeOrderService.decryptOrderPayload(order.encryptedPayload, order.nonce, order.storeId, key, sellerKey, true))
    } catch {
      // Shown as "could not be read".
    }
  }))
  const statuses = storefrontStatusIsSealed() && key ? openStatusNotesAsBuyer(statusMap, orders, key, keys) : statusMap

  const deliveries = new Map<string, DeliveryDTO[]>()
  if (storefrontSupportsDigital() && orders.length > 0) {
    const forBuyer = await orderDeliveryService.getForBuyer(buyer).catch(() => new Map<string, OrderDelivery[]>())
    for (const order of orders) {
      const sellerKey = keys.get(order.sellerId)
      deliveries.set(order.id, (forBuyer.get(order.id) ?? []).map(delivery => {
        try {
          if (!key || !sellerKey) throw new Error('No key on this device to decrypt the delivery')
          return deliveryDTO({ ...delivery, payload: orderDeliveryService.decryptAsBuyer(delivery, order, key, sellerKey) })
        } catch {
          return deliveryDTO(delivery)
        }
      }))
    }
  }

  return orders.map(order => {
    const payload = payloads.get(order.id) ?? null
    return {
      id: order.id,
      storeId: order.storeId,
      sellerId: order.sellerId,
      buyerId: order.buyerId,
      createdAt: order.createdAt,
      payload,
      locked: !key,
      status: statusDTO(statuses.get(order.id)),
      digital: storefrontSupportsDigital() && hasDigitalLines(payload ?? undefined),
      deliveries: deliveries.get(order.id) ?? [],
      storeName: names.get(order.storeId) ?? null,
      reviewed: reviews.has(order.id),
    }
  })
}

/**
 * The seller's key on this device. Without it, BAD_REQUEST: never `NO_KEY`,
 * which the host reads as a signing key gone (sign in again), not the
 * encryption key Messages unlocks.
 */
function sellerKeyOrThrow(seller: string): Uint8Array {
  const key = getEncryptionKeyBytes(seller)
  if (!key) throw badRequest(UNLOCK_MESSAGE)
  return key
}

const UNLOCK_MESSAGE = 'Unlock your encryption key on this device first.'

/** A refusal before a ticket's write, as the failed ticket's own sentence (classify keeps only BAD_REQUEST's). */
const refusedBefore = (error: unknown): NotSentError =>
  new NotSentError(error instanceof RpcError && error.code !== 'BAD_REQUEST' && !/^(NETWORK|TIMEOUT|RATE_LIMITED)$/.test(error.code) ? badRequest(error.message) : error)

/** The seller's own order, or NOT_OWNER. */
async function sellerOrder(seller: string, orderId: string): Promise<StoreOrder> {
  const order = await readOrder(orderId)
  if (order.sellerId !== seller) throw new RpcError('This order was not placed with your store', 'NOT_OWNER')
  return order
}

interface DeliveryState {
  order: StoreOrder
  payload: OrderPayload
  lines: OrderItem[]
  deliveries: OrderDelivery[]
  kits: Map<string, SellerKit>
  listings: Map<string, ItemListing>
}

/** Everything a delivery is worked out from, read fresh. Throws when any read fails: nothing is sent on a guess. */
async function deliveryState(seller: string, orderId: string, key: Uint8Array): Promise<DeliveryState> {
  const order = await sellerOrder(seller, orderId)
  let payload: OrderPayload
  try {
    payload = await storeOrderService.decryptOrderPayload(order.encryptedPayload, order.nonce, order.storeId, key, null, false)
  } catch {
    throw badRequest('This order could not be read with your key')
  }
  const lines = digitalLines(payload)
  if (lines.length === 0) throw badRequest('This order has nothing to deliver digitally')
  const itemIds = [...new Set(lines.map(line => line.itemId))]
  try {
    const [read, kits, listings] = await Promise.all([
      orderDeliveryService.loadDecrypted([order], (delivery, owner) => orderDeliveryService.decryptAsSeller(delivery, owner, key)),
      itemDeliverableService.loadKits(itemIds, key),
      readListings(itemIds),
    ])
    return { order, payload, lines, deliveries: withHeldDeliveries(read.get(order.id) ?? [], heldDeliveries.get(order.id) ?? []), kits, listings }
  } catch (error) {
    throw readFailure(error)
  }
}

/** Deliveries this engine sent that may not show on chain yet, per order (`withHeldDeliveries`). */
const heldDeliveries = new Map<string, OrderDelivery[]>()

function kitContents(kit: ItemDeliverablePayload | undefined): string[] {
  if (!kit) return []
  return [
    ...kit.assets.map(asset => (asset.kind === 'file' ? `File: ${asset.name}` : asset.kind === 'link' ? `Link: ${asset.label}` : `Code: ${asset.label}`)),
    ...(kit.instructions ? ['Instructions'] : []),
  ]
}

const toAsset = (extra: NonNullable<DeliverInput['extras']>[string][number]): DigitalAsset =>
  extra.kind === 'link'
    ? { kind: 'link', label: extra.label.trim(), url: extra.url.trim(), ...(extra.code?.trim() ? { code: extra.code.trim() } : {}) }
    : { kind: 'code', label: extra.label.trim(), code: extra.code.trim() }

/**
 * Web `DeliverDigitalModal`'s allocation for `input` against `state`: the
 * plan, its blockers and warnings, and the lines it covers.
 */
function workOut(state: DeliveryState, input: Pick<DeliverInput, 'lines' | 'message' | 'extras'>) {
  const { lines, deliveries, kits, listings, payload, order } = state
  const coverage = lines.map(line => lineCoverage(line, deliveries))
  const sellsCodes = lines.map(line => kits.get(line.itemId)?.kit.licenseKeys !== undefined)
  const owed = lines.map((line, index) => (sellsCodes[index] ? Math.max(0, line.quantity - coverage[index].possiblyCodes) : 0))
  const pending = coverage.flatMap((line, index) => (!line.possibly || owed[index] > 0 ? [index] : []))
  const defaults = pending.length > 0 ? pending : coverage.map((_, index) => index)
  const selected = new Set((input.lines ?? defaults).filter(index => Number.isInteger(index) && index >= 0 && index < lines.length))

  const extras = input.extras ?? {}
  const effectiveKits = new Map<string, ItemDeliverablePayload>()
  for (const itemId of new Set(lines.filter((_, index) => selected.has(index)).map(line => line.itemId))) {
    const base = kits.get(itemId)?.kit
    const extra = (extras[itemId] ?? []).map(toAsset)
    if (!base && extra.length === 0) continue
    effectiveKits.set(itemId, base ? { ...base, assets: [...base.assets, ...extra] } : { v: 1, assets: extra, deliverWhen: 'payment_confirmed' })
  }

  const noCodes = new Set<OrderItem>()
  const items = lines.flatMap((line, index) => {
    if (!selected.has(index)) return []
    const codes = sellsCodes[index] ? owed[index] : line.quantity
    const planned: OrderItem = { ...line, itemTitle: listings.get(line.itemId)?.title ?? line.itemTitle, ...(codes > 0 ? { quantity: codes } : {}) }
    if (codes === 0) noCodes.add(planned)
    return [planned]
  })
  const message = input.message?.slice(0, MAX_DELIVERY_MESSAGE_LENGTH)
  const plan = planDelivery({ items }, effectiveKits, listings, message, line => noCodes.has(line))
  const unchosen = new Set(lines.filter((_, index) => !selected.has(index)))
  const problems = lineProblems({ ...payload, items: payload.items.filter(item => !unchosen.has(item)) }, order.storeId, listings)
  const blockers = [
    ...(selected.size === 0 ? ['Choose at least one item to deliver.'] : []),
    ...wholeOrderProblems(payload),
    ...problems.filter(problem => problem.blocking).map(problem => problem.text),
    ...planBlockers(plan),
  ]
  const sending = lines.map((_, index) => ({ selected: selected.has(index), sellsCodes: sellsCodes[index], codes: owed[index] }))
  return {
    plan,
    blockers,
    warnings: problems.filter(problem => !problem.blocking).map(problem => problem.text),
    selected: [...selected],
    defaults,
    coverage,
    sellsCodes,
    owed,
    marksDelivered: isDigitalOnly(payload.items) && deliveryCompletesOrder(lines, deliveries, sending),
  }
}

/** Fold a fulfilment into what this engine holds: its delivery stays counted until a read shows it. */
function holdDelivery(orderId: string, delivery: OrderDelivery): void {
  heldDeliveries.set(orderId, [...(heldDeliveries.get(orderId) ?? []), delivery])
}

/** Recovery text from a failed fulfilment: plaintext codes for the seller, never logged. */
function recoveryOf(error: unknown): string | null {
  return error instanceof KeyRecoveryError ? error.recoveryText() : null
}

function kitDTO(kit: ItemDeliverablePayload): KitDTO {
  return {
    instructions: kit.instructions ?? '',
    files: kit.assets.flatMap(asset => (asset.kind === 'file' ? [{ name: asset.name, size: asset.size }] : [])),
    links: kit.assets.flatMap(asset => (asset.kind === 'link' ? [{ label: asset.label, url: asset.url, ...(asset.code ? { code: asset.code } : {}) }] : [])),
    codes: kit.assets.flatMap(asset => (asset.kind === 'code' ? [{ label: asset.label, code: asset.code }] : [])),
    licenseKeys: kit.licenseKeys ?? null,
    deliverWhen: kit.deliverWhen,
  }
}

/** The kit `input` describes, keeping the stored kit's files (and their variant targets) as they are. */
function kitFrom(input: KitDTO, stored: ItemDeliverablePayload | undefined): ItemDeliverablePayload {
  const trim = (value: string | undefined) => value?.trim() ?? ''
  const keys = input.licenseKeys === null ? undefined : input.licenseKeys.map(trim).filter(Boolean)
  return {
    v: 1,
    assets: [
      ...(stored?.assets.filter(asset => asset.kind === 'file') ?? []),
      ...input.links.filter(link => trim(link.url)).map((link): DigitalAsset => ({ kind: 'link', label: trim(link.label) || 'Download', url: trim(link.url), ...(trim(link.code) ? { code: trim(link.code) } : {}) })),
      ...input.codes.filter(code => trim(code.code)).map((code): DigitalAsset => ({ kind: 'code', label: trim(code.label) || 'Code', code: trim(code.code) })),
    ],
    ...(trim(input.instructions) ? { instructions: trim(input.instructions) } : {}),
    ...(keys ? { licenseKeys: keys } : {}),
    deliverWhen: input.deliverWhen === 'on_order' ? 'on_order' : 'payment_confirmed',
  }
}

/**
 * Web checkout's `handlePlaceOrder`: shipping checked again fresh, the
 * lines' availability (a product switched to or from digital sends the
 * buyer back), readiness, then the order encrypted to the seller and placed.
 * Every refusal before the write is BAD_REQUEST with web's copy.
 */
async function placeOrder(buyer: string, input: PlaceOrderInput, ctx: { stage(): void; documents(docs: TicketDocument[]): void }) {
  const notSent = (message: string) => new NotSentError(badRequest(message))
  const store = await storeService.getById(input.storeId).catch((error: unknown) => { throw new NotSentError(readFailure(error)) })
  if (!store) throw notSent('This store could not be found')
  const stored = cartService.getItemsForStore(store.id)
  const availability = await cartService.getAvailability(stored)
  const lines = availability.map(result => result.item)
  const reviewed = new Map(input.reviewed.lines.map(line => [line.key, line]))
  if (lines.length !== reviewed.size || lines.some(line => reviewed.get(cartLineKey(line))?.quantity !== line.quantity)) throw notSent(CART_CHANGED_MESSAGE)
  if (lines.some(line => reviewed.get(cartLineKey(line))?.digital !== (line.fulfillment === 'digital'))) throw notSent(FULFILLMENT_CHANGED_MESSAGE)
  const unavailable = availability.filter(result => result.reason)
  if (unavailable.length > 0) throw notSent(unavailable.map(result => `${result.item.title}: ${result.reason}`).join(' '))
  const currency = lines.length > 0 ? lines[0].currency || 'USD' : 'USD'
  if (lines.some(line => (line.currency || 'USD') !== currency)) throw notSent('Your cart mixes currencies for this store. Remove some items to continue.')

  const digitalOnly = lines.every(line => line.fulfillment === 'digital')
  const shipTo = input.shipTo && !digitalOnly ? cleanAddress(input.shipTo) : undefined
  let shippingCost = 0
  if (shipTo) {
    let fresh: ShippingCheck | null
    try {
      const [shippingLines, zones] = await Promise.all([
        cartService.getShippingLines(lines),
        shippingZoneService.getByStore(store.id).catch(() => null),
      ])
      fresh = checkShipping(zones, shippingLines, shipTo)
    } catch {
      fresh = null
    }
    const verdict = finalShippingCheck(input.reviewed.shippingCost, fresh, cost => formatPrice(cost, currency))
    if (verdict.kind !== 'proceed') throw notSent(verdict.message)
    shippingCost = fresh?.quote?.cost ?? 0
  } else if (input.reviewed.shippingCost !== 0) {
    throw notSent(FULFILLMENT_CHANGED_MESSAGE)
  }

  if (!(store.paymentUris ?? []).some(payment => payment.uri === input.paymentUri)) throw notSent('Choose one of the store\'s payment methods')
  const payload = storeOrderService.buildOrderPayload(
    lines, shipTo, cleanContact(input.contact), shippingCost, input.paymentUri, currency,
    input.notes?.trim() || undefined, input.refundAddress?.trim() || undefined,
  )
  if (input.txid?.trim()) payload.txid = input.txid.trim()
  const readiness = await checkoutReadiness(store, buyer)
  if (readiness.blocker || !readiness.sellerKey || !readiness.buyerKey) {
    throw notSent(checkoutBlockerMessage(readiness.blocker) ?? 'Checkout is not ready. Please try again.')
  }
  const nonce = new Uint8Array(24)
  crypto.getRandomValues(nonce)
  const encryptedPayload = await storeOrderService.encryptOrderPayload(payload, readiness.buyerKey, readiness.sellerKey, nonce, store.id)

  ctx.stage()
  let created: StoreOrder
  try {
    created = await storeOrderService.createOrder(buyer, { storeId: store.id, sellerId: store.ownerId, encryptedPayload, nonce })
  } catch (error) {
    // createOrder's own refusals (own store, too large, store closed) come before signing.
    const message = error instanceof Error ? error.message : ''
    if (/own store|too large|isn't taking orders/.test(message)) throw notSent(message)
    throw error
  }
  const confirmed = wasConfirmed(created)
  ctx.documents([storefrontDoc(STOREFRONT_DOCUMENT_TYPES.STORE_ORDER, created.id, 'create', confirmed)])
  cartService.removeStoreItems(store.id)
  return confirmed
}

export function createOrderModule(tickets: TicketStore) {
  tickets.register<PlaceOrderInput>('store.order', {
    // The address and contact never sit on disk outside the order's own encryption.
    persistArgs: false,
    stagedSends: true,
    async run(input, ctx) {
      const buyer = signer(ctx)
      // Validation reads come first: none of them sends anything.
      ctx.stage('queued', true)
      const confirmed = await placeOrder(buyer, input, { stage: () => ctx.stage('signing'), documents: docs => ctx.documents(docs) })
      return { state: confirmed ? 'confirmed' : 'unconfirmed' }
    },
  })

  tickets.register<StatusUpdateInput>('store.order.status', {
    // Tracking and message are sealed to the order on v10: not kept in plain storage.
    persistArgs: false,
    stagedSends: true,
    async run(input, ctx) {
      const seller = signer(ctx)
      ctx.stage('queued', true)
      const order = await sellerOrder(seller, input.orderId).catch((error: unknown) => { throw refusedBefore(error) })
      const hasNote = Boolean(input.trackingNumber || input.trackingCarrier || input.message)
      const key = storefrontStatusIsSealed() && hasNote ? getEncryptionKeyBytes(seller) : null
      if (storefrontStatusIsSealed() && hasNote && !key) throw new NotSentError(badRequest('Unlock your encryption key to add tracking or a message.'))
      ctx.stage('signing')
      let update: OrderStatusUpdate
      try {
        update = await orderStatusService.createStatusUpdate(seller, order.id, {
          status: input.status,
          trackingNumber: input.trackingNumber || undefined,
          trackingCarrier: input.trackingCarrier || undefined,
          message: input.message || undefined,
          buyerId: order.buyerId,
          orderKey: key ? sellerOrderDeliveryKey(order, key) : undefined,
        })
      } catch (error) {
        if (error instanceof StatusNoteError) throw new NotSentError(badRequest(error.message))
        throw error
      }
      const confirmed = wasConfirmed(update)
      ctx.documents([storefrontDoc(STOREFRONT_DOCUMENT_TYPES.ORDER_STATUS_UPDATE, update.id, 'create', confirmed)])
      return { state: confirmed ? 'confirmed' : 'unconfirmed' }
    },
  })

  const reads = {
    /** The viewer's orders as a buyer, newest first. */
    async myOrders(cursor?: string | null): Promise<Page<BuyerOrderDTO>> {
      const buyer = requireViewer('Your orders')
      const { orders } = await storeOrderService.getBuyerOrders(buyer, { limit: ORDERS_PAGE, startAfter: afterOf(cursor, 'buyer-orders') })
      return pageOf(await buyerOrders(buyer, orders), 'buyer-orders', orders.length === ORDERS_PAGE)
    },

    /** Orders placed with the viewer's store, newest first. */
    async sellerOrders(cursor?: string | null): Promise<Page<SellerOrderDTO>> {
      const seller = requireViewer('Your store\'s orders')
      const { orders } = await storeOrderService.getSellerOrders(seller, { limit: ORDERS_PAGE, startAfter: afterOf(cursor, 'seller-orders') })
      return pageOf(await sellerOrders(seller, orders), 'seller-orders', orders.length === ORDERS_PAGE)
    },

    /** One order of the viewer's, as its buyer or its seller. */
    async order(orderId: string): Promise<{ role: 'buyer'; order: BuyerOrderDTO } | { role: 'seller'; order: SellerOrderDTO }> {
      const viewer = requireViewer('Your orders')
      const order = await readOrder(orderId)
      if (order.sellerId === viewer) return { role: 'seller', order: (await sellerOrders(viewer, [order]))[0] }
      if (order.buyerId === viewer) return { role: 'buyer', order: (await buyerOrders(viewer, [order]))[0] }
      throw new RpcError('This order is not yours', 'NOT_OWNER')
    },

    /** What delivering the order now would send, from its receipts, kits and listings read just now. */
    async deliveryPlan(orderId: string): Promise<DeliveryPlanDTO> {
      const seller = requireViewer('Delivering an order')
      const state = await deliveryState(seller, orderId, sellerKeyOrThrow(seller))
      const worked = workOut(state, {})
      return {
        orderId,
        lines: state.lines.map((line, index) => {
          const planned = worked.plan.delivery.items.find(item => deliveredFor(item, line))
          return {
            index,
            itemId: line.itemId,
            itemTitle: state.listings.get(line.itemId)?.title ?? line.itemTitle,
            ...(line.variantLabel ? { variantLabel: line.variantLabel } : {}),
            quantity: line.quantity,
            sentBefore: worked.coverage[index].possibly,
            sellsCodes: worked.sellsCodes[index],
            codesOwed: worked.owed[index],
            contents: planned ? kitContents(state.kits.get(line.itemId)?.kit) : [],
          }
        }),
        selected: worked.selected,
        blockers: worked.blockers,
        warnings: worked.warnings,
        marksDelivered: worked.marksDelivered,
        previousDeliveries: state.deliveries.length,
      }
    },

    /** The seller's delivery content for a digital product; `locked` without the key on this device. */
    async kit(itemId: string): Promise<KitReadDTO> {
      const seller = requireViewer('Delivery content')
      const key = getEncryptionKeyBytes(seller)
      if (!key) return { locked: true }
      const kits = await itemDeliverableService.loadKits([itemId], key).catch((error: unknown) => { throw readFailure(error) })
      const kit = kits.get(itemId)?.kit
      return { locked: false, kit: kit ? kitDTO(kit) : null }
    },
  }

  const writes = {
    /** Place the order for a store's cart (web checkout's Place Order). */
    async placeOrder(input: PlaceOrderInput): Promise<WriteTicket> {
      const buyer = requireViewer('Placing an order')
      if (typeof input?.storeId !== 'string' || typeof input.paymentUri !== 'string' || !Array.isArray(input.reviewed?.lines)) throw badRequest('storeId, paymentUri and reviewed are required')
      return tickets.submit({ op: 'store.order', args: input, target: { identityId: buyer } })
    },

    /** The seller sets an order's status (and tracking or a message). */
    async updateOrderStatus(input: StatusUpdateInput): Promise<WriteTicket> {
      const seller = requireViewer('Updating an order')
      if (!ORDER_STATUSES.includes(input?.status)) throw badRequest(`status is one of ${ORDER_STATUSES.join(', ')}`)
      return tickets.submit({ op: 'store.order.status', args: input, target: { identityId: seller } })
    },

    /**
     * Deliver an order's digital lines now (web `DeliverDigitalModal`'s
     * submit): the receipts, kits and listings read fresh; refused with every
     * blocker, or with the warnings until `acknowledged`. Long-running: it
     * reserves unique codes, publishes, and marks the order delivered.
     */
    async deliver(input: DeliverInput): Promise<DeliverResultDTO> {
      const seller = requireViewer('Delivering an order')
      const key = sellerKeyOrThrow(seller)
      const state = await deliveryState(seller, input.orderId, key)
      const worked = workOut(state, input)
      if (worked.blockers.length > 0) throw badRequest(worked.blockers.join(' '))
      if (worked.warnings.length > 0 && !input.acknowledged) throw badRequest(`Check these lines before delivering: ${worked.warnings.join(' ')}`)
      try {
        const result = await fulfillOrder({
          sellerId: seller, order: state.order, delivery: worked.plan.delivery, consumedKeys: worked.plan.consumedKeys,
          kits: state.kits, markDelivered: worked.marksDelivered, sellerPrivateKey: key,
        })
        holdDelivery(state.order.id, result.delivery)
        return { pending: result.pending, warnings: result.warnings, recoveryText: result.pendingRecoveryText ?? null }
      } catch (error) {
        const recovery = recoveryOf(error)
        throw new RpcError(recovery ? `${error instanceof Error ? error.message : 'Delivery failed.'} ${recovery}` : (error instanceof Error ? error.message : 'Delivery failed.'), 'BAD_REQUEST')
      }
    },

    /** Web's "Deliver all": every order on the first page that is ready, one at a time, each re-checked as it stands now. */
    async deliverReady(): Promise<BulkDeliveryDTO> {
      const seller = requireViewer('Delivering orders')
      const key = sellerKeyOrThrow(seller)
      const { orders } = await storeOrderService.getSellerOrders(seller, { limit: 50 })
      const ready = (await sellerOrders(seller, orders)).filter(order => order.readyToDeliver)
      const result: BulkDeliveryDTO = { delivered: 0, skipped: [], firstFailure: null, warnings: [], recoveryTexts: [] }
      let kits = new Map<string, SellerKit>()
      for (const dto of ready) {
        try {
          const state = await deliveryState(seller, dto.id, key)
          kits = newerKits(kits, state.kits)
          const current = kitsOf(state.lines.map(line => line.itemId), kits, state.kits)
          const status = (await orderStatusService.getLatestStatuses([dto.id])).get(dto.id)
          const stillReady = current && isReadyForBulkDelivery({
            payload: state.payload, storeId: state.order.storeId, latestStatus: status?.status, alreadyDelivered: state.deliveries.length > 0,
            kits: toKitPayloads(current), listings: state.listings,
          })
          const plan = stillReady ? planDelivery(state.payload, toKitPayloads(kits), state.listings) : null
          if (!plan || !current) {
            result.skipped.push(dto.id)
            continue
          }
          const fulfilled = await fulfillOrder({
            sellerId: seller, order: state.order, delivery: plan.delivery, consumedKeys: plan.consumedKeys, kits,
            markDelivered: isDigitalOnly(state.payload.items), sellerPrivateKey: key,
          })
          kits = newerKits(kits, fulfilled.updatedKits)
          holdDelivery(dto.id, fulfilled.delivery)
          result.delivered++
          result.warnings.push(...fulfilled.warnings)
          if (fulfilled.pendingRecoveryText) result.recoveryTexts.push(fulfilled.pendingRecoveryText)
        } catch (error) {
          if (error instanceof FulfillmentError) kits = newerKits(kits, error.updatedKits)
          result.skipped.push(dto.id)
          result.firstFailure ??= error instanceof Error ? error.message : 'unknown error'
          const recovery = recoveryOf(error)
          if (recovery) result.recoveryTexts.push(recovery)
        }
      }
      return result
    },

    /** Save a digital product's delivery content (web's kit editor). Long-running: it reconciles an unseen write. */
    async saveKit(itemId: string, input: KitDTO): Promise<KitDTO> {
      const seller = requireViewer('Saving delivery content')
      const key = sellerKeyOrThrow(seller)
      const item = await storeItemService.getById(itemId).catch((error: unknown) => { throw readFailure(error) })
      if (!item || item.ownerId !== seller) throw new RpcError('This product is not yours', 'NOT_OWNER')
      const stored = (await itemDeliverableService.loadKits([itemId], key).catch((error: unknown) => { throw readFailure(error) })).get(itemId)
      const kit = kitFrom(input, stored?.kit)
      const fit = kitDeliveryFitError(kit)
      if (fit) throw badRequest(fit)
      try {
        await itemDeliverableService.saveKit(seller, itemId, kit, key, stored?.deliverable ?? null)
      } catch (error) {
        if (error instanceof KitWriteUncertainError) throw new RpcError(error.message, 'TIMEOUT')
        throw error
      }
      return kitDTO(kit)
    },
  }

  return { reads, writes }
}
