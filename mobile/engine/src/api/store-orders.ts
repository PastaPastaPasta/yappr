import { logger } from '@/lib/logger'
import { STOREFRONT_DOCUMENT_TYPES, storefrontStatusIsSealed, storefrontSupportsDigital } from '@/lib/constants'
import { sellerOrderDeliveryKey } from '@/lib/crypto/digital-delivery'
import { cartLineKey, cartService, getCartCurrency } from '@/lib/services/cart-service'
import {
  deliveredFor, deliveryCompletesOrder, digitalLines, hasDigitalLines, isDigitalOnly, isReadyForBulkDelivery, isSafeDeliveryUrl, kitDeliveryFitError,
  lineCoverage, lineProblems, MAX_CODE_LENGTH, MAX_DELIVERY_MESSAGE_LENGTH, normalizeLinkInput, planBlockers, planDelivery, wholeOrderProblems,
  withHeldDeliveries, type ItemListing,
} from '@/lib/services/digital-delivery-plan'
import { fulfillOrder, FulfillmentError, KeyRecoveryError, kitsOf, newerKits, toKitPayloads } from '@/lib/services/digital-fulfillment'
import { getPaymentVerificationUrl } from '@/lib/services/insight-api-service'
import { bytesToBase64 } from '@/lib/bytes'
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
import { fetchDeliveredFile } from './delivered-file'
import { NotSentError, type ProbeKit, type ProbeResult, type TicketStore } from '../writes/tickets'
import { signer } from '../writes/handler-kit'
import { wasConfirmed } from '../writes/lib-results'
import type { TicketDocument, WriteTicket } from '../writes/types'
import { checkoutBlockerMessage, checkoutReadiness, cleanAddress, cleanContact, sellerEncryptionKey, storefrontDoc } from './store-shared'

const ORDERS_PAGE = 20

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * The decrypted order as the screens may read it, or null. The payload is the
 * BUYER's JSON: decrypting it proves nothing about its shape, and one order
 * whose `items` is not a list would break the seller's whole list.
 */
function validPayload(value: unknown): OrderPayload | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  const items = value.items.filter((line): line is OrderPayload['items'][number] =>
    isRecord(line) && isText(line.itemId) && isText(line.itemTitle) && isAmount(line.quantity) && isAmount(line.unitPrice))
  if (items.length !== value.items.length || items.length === 0) return null
  if (!isAmount(value.subtotal) || !isAmount(value.shippingCost) || !isAmount(value.total) || !isText(value.currency) || !isText(value.paymentUri)) return null
  const address = value.shippingAddress
  if (address !== undefined && !(isRecord(address) && ['name', 'street', 'city', 'postalCode', 'country'].every(field => isText(address[field])))) return null
  for (const field of ['txid', 'notes', 'refundAddress'] as const) if (value[field] !== undefined && !isText(value[field])) return null
  const contact = isRecord(value.buyerContact) ? value.buyerContact : {}
  return {
    ...(value as unknown as OrderPayload),
    items,
    buyerContact: { ...(isText(contact.email) ? { email: contact.email } : {}), ...(isText(contact.phone) ? { phone: contact.phone } : {}) },
  }
}

/** Decrypt and validate one order's payload; null when this key can't read it or it is malformed. */
async function readPayload(order: StoreOrder, key: Uint8Array, sellerKey: Uint8Array | null, isBuyer: boolean): Promise<OrderPayload | null> {
  try {
    return validPayload(await storeOrderService.decryptOrderPayload(order.encryptedPayload, order.nonce, order.storeId, key, sellerKey, isBuyer))
  } catch {
    return null
  }
}
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
  /**
   * Null when it was delivered (or sent). Otherwise why not: returned, not
   * thrown, so unique codes in `recoveryText` never reach the host's error log.
   */
  error: string | null
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
  /** `optionIds`: the variants a link or code goes to (absent: every variant); kept as the web editor set them. */
  links: { label: string; url: string; code?: string; optionIds?: number[] }[]
  codes: { label: string; code: string; optionIds?: number[] }[]
  /** Null when the product sells no unique codes. */
  licenseKeys: string[] | null
  deliverWhen: 'payment_confirmed' | 'on_order'
}

/**
 * `revision`: the kit document's revision when read (null: no kit yet). A
 * save sends it back and is refused if the kit moved since, as web's editor
 * saves against the copy it loaded: a delivery in between took codes, and
 * writing the old pool would put sold codes back.
 */
export type KitReadDTO = { locked: true } | { locked: false; kit: KitDTO | null; revision: number | null }

/** A delivered file, decrypted, for the host to save: the bridge carries it as base64. */
export interface DeliveredFileDTO {
  name: string
  base64: string
}

/** The largest delivered file the app saves (the bridge carries it whole, as base64). */
const MAX_SAVED_FILE_BYTES = 25 * 1024 * 1024
const FILE_TOO_LARGE_MESSAGE = 'This file is too large to save on a phone. Save it from a computer instead.'
const UNLOCK_MESSAGE = 'Unlock your encryption key on this device first.'
const NO_KEY_FOR_DELIVERY = 'No key on this device to decrypt the delivery'

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

/** What the buyer's and the seller's views of an order share. `key`: the viewer's encryption key on this device. */
function orderBase(order: StoreOrder, payload: OrderPayload | null, key: Uint8Array | null, status: OrderStatusUpdate | undefined, deliveries: DeliveryDTO[]): OrderBaseDTO {
  return {
    id: order.id,
    storeId: order.storeId,
    sellerId: order.sellerId,
    buyerId: order.buyerId,
    createdAt: order.createdAt,
    payload,
    locked: !key,
    status: statusDTO(status),
    digital: storefrontSupportsDigital() && hasDigitalLines(payload ?? undefined),
    deliveries,
  }
}

/** The seller's view of a page of orders (web `/orders/seller` `loadOrdersPage`). */
async function sellerOrders(seller: string, orders: StoreOrder[]): Promise<SellerOrderDTO[]> {
  const key = getEncryptionKeyBytes(seller)
  const payloads = new Map<string, OrderPayload>()
  await Promise.all(orders.map(async order => {
    if (!key) return
    const payload = await readPayload(order, key, null, false)
    // Unreadable or malformed: shown as "could not be read".
    if (payload) payloads.set(order.id, payload)
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
          if (!key) throw new Error(NO_KEY_FOR_DELIVERY)
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
    const orderDeliveries = deliveries.get(order.id) ?? []
    const status = statuses.get(order.id)
    const base = orderBase(order, payload, key, status, orderDeliveries.map(deliveryDTO))
    const { digital } = base
    const uncertain = digital && (deliveriesFailed || statusesFailed)
    return {
      ...base,
      // DPNS answers the full name (`alice.dash`): shown as a handle, like everywhere else.
      buyerName: names.get(order.buyerId)?.replace(/\.dash$/i, '') ?? null,
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
    const payload = await readPayload(order, key, sellerKey, true)
    if (payload) payloads.set(order.id, payload)
  }))
  const statuses = storefrontStatusIsSealed() && key ? openStatusNotesAsBuyer(statusMap, orders, key, keys) : statusMap

  const deliveries = new Map<string, DeliveryDTO[]>()
  if (storefrontSupportsDigital() && orders.length > 0) {
    const forBuyer = await orderDeliveryService.getForBuyer(buyer).catch(() => new Map<string, OrderDelivery[]>())
    for (const order of orders) {
      const sellerKey = keys.get(order.sellerId)
      deliveries.set(order.id, (forBuyer.get(order.id) ?? []).map(delivery => {
        try {
          if (!key || !sellerKey) throw new Error(NO_KEY_FOR_DELIVERY)
          return deliveryDTO({ ...delivery, payload: orderDeliveryService.decryptAsBuyer(delivery, order, key, sellerKey) })
        } catch {
          return deliveryDTO(delivery)
        }
      }))
    }
  }

  return orders.map(order => ({
    ...orderBase(order, payloads.get(order.id) ?? null, key, statuses.get(order.id), deliveries.get(order.id) ?? []),
    storeName: names.get(order.storeId) ?? null,
    reviewed: reviews.has(order.id),
  }))
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
  const payload = await readPayload(order, key, null, false)
  if (!payload) throw badRequest('This order could not be read with your key')
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

function assetSummary(asset: DigitalAsset): string {
  switch (asset.kind) {
    case 'file': return `File: ${asset.name}`
    case 'link': return `Link: ${asset.label}`
    case 'code': return `Code: ${asset.label}`
  }
}

function kitContents(kit: ItemDeliverablePayload | undefined): string[] {
  if (!kit) return []
  return [...kit.assets.map(assetSummary), ...(kit.instructions ? ['Instructions'] : [])]
}

const LINK_PROBLEM = 'Links must start with https://, http://, magnet: or ipfs://. Send any other kind of address as a code.'
const CODE_PROBLEM = `Codes are at most ${MAX_CODE_LENGTH} characters.`

/** A seller-typed link, normalized as web's editor does (`drive.google.com/x` gets https://); BAD_REQUEST when it can't be opened safely. */
function linkAsset(label: string | undefined, url: string, code: string | undefined, optionIds?: number[]): DigitalAsset {
  const href = normalizeLinkInput(url)
  if (!isSafeDeliveryUrl(href)) throw badRequest(LINK_PROBLEM)
  const access = code?.trim()
  if (access && access.length > MAX_CODE_LENGTH) throw badRequest(CODE_PROBLEM)
  return { kind: 'link', label: label?.trim() || href, url: href, ...(access ? { code: access } : {}), ...(optionIds?.length ? { optionIds } : {}) }
}

function codeAsset(label: string | undefined, code: string, optionIds?: number[]): DigitalAsset {
  const value = code.trim()
  if (value.length > MAX_CODE_LENGTH) throw badRequest(CODE_PROBLEM)
  return { kind: 'code', label: label?.trim() || 'Code', code: value, ...(optionIds?.length ? { optionIds } : {}) }
}

const toAsset = (extra: NonNullable<DeliverInput['extras']>[string][number]): DigitalAsset =>
  extra.kind === 'link' ? linkAsset(extra.label, extra.url, extra.code) : codeAsset(extra.label, extra.code)

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
    const extra = (extras[itemId] ?? []).filter(entry => (entry.kind === 'link' ? entry.url : entry.code).trim()).map(toAsset)
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
    links: kit.assets.flatMap(asset => (asset.kind === 'link' ? [{ label: asset.label, url: asset.url, ...(asset.code ? { code: asset.code } : {}), ...(asset.optionIds ? { optionIds: asset.optionIds } : {}) }] : [])),
    codes: kit.assets.flatMap(asset => (asset.kind === 'code' ? [{ label: asset.label, code: asset.code, ...(asset.optionIds ? { optionIds: asset.optionIds } : {}) }] : [])),
    licenseKeys: kit.licenseKeys ?? null,
    deliverWhen: kit.deliverWhen,
  }
}

/** The kit document's revision (null: no kit yet), as `KitReadDTO.revision` carries it and a save is checked against. */
const kitRevision = (stored: SellerKit | undefined): number | null => (stored ? stored.deliverable.$revision ?? 0 : null)

/** The kit `input` describes, keeping the stored kit's files (and their variant targets) as they are. */
function kitFrom(input: KitDTO, stored: ItemDeliverablePayload | undefined): ItemDeliverablePayload {
  const trim = (value: string | undefined) => value?.trim() ?? ''
  const keys = input.licenseKeys === null ? undefined : input.licenseKeys.map(trim).filter(Boolean)
  return {
    v: 1,
    assets: [
      ...(stored?.assets.filter(asset => asset.kind === 'file') ?? []),
      ...input.links.filter(link => trim(link.url)).map(link => linkAsset(link.label, link.url, link.code, link.optionIds)),
      ...input.codes.filter(code => trim(code.code)).map(code => codeAsset(code.label, code.code, code.optionIds)),
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
/**
 * The nonce of each order attempt this engine is placing, by ticket id: the
 * probe recognises the attempt's own order by it (an order's nonce is random
 * per attempt). After a restart it is gone, and the probe proves nothing.
 */
const orderNonces = new Map<string, Uint8Array>()

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index])

async function placeOrder(buyer: string, input: PlaceOrderInput, ctx: { ticketId: string; stage(): void; documents(docs: TicketDocument[]): void }) {
  // Everything before the write sends nothing: any failure there (a read, the encryption) is not-sent and retryable.
  const prepared = await prepareOrder(buyer, input).catch((error: unknown) => {
    throw error instanceof NotSentError ? error : new NotSentError(readFailure(error))
  })
  orderNonces.set(ctx.ticketId, prepared.nonce)
  ctx.stage()
  let created: StoreOrder
  try {
    created = await storeOrderService.createOrder(buyer, prepared)
  } catch (error) {
    // createOrder's own refusals (own store, too large, store closed) come before signing.
    const message = error instanceof Error ? error.message : ''
    if (/own store|too large|isn't taking orders/.test(message)) throw new NotSentError(badRequest(message))
    throw error
  }
  const confirmed = wasConfirmed(created)
  ctx.documents([storefrontDoc(STOREFRONT_DOCUMENT_TYPES.STORE_ORDER, created.id, 'create', confirmed)])
  cartService.removeStoreItems(prepared.storeId)
  return confirmed
}

/** The order checked again and encrypted, ready to place; refusals are NotSentError with web's copy. */
async function prepareOrder(buyer: string, input: PlaceOrderInput) {
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
  const currency = getCartCurrency(lines)
  if (!currency) throw notSent('Your cart mixes currencies for this store. Remove some items to continue.')

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
  return { storeId: store.id, sellerId: store.ownerId, encryptedPayload, nonce }
}

/**
 * "Check again" for an order the write did not name (its call threw after
 * signing): the buyer's newest orders, looking for one to this store placed
 * since the ticket. Found, it landed; the cart's lines for the store go then,
 * so the same cart is never ordered twice.
 */
async function orderProbe(ticket: WriteTicket, input: PlaceOrderInput | undefined, kit: ProbeKit): Promise<ProbeResult> {
  if (ticket.documents.length > 0) return kit.proveDocuments(ticket.documents)
  const nonce = orderNonces.get(ticket.id)
  if (!ticket.identityId || !input?.storeId || !nonce) return { state: 'unknown', error: new Error('Nothing to check: this order named no document') }
  try {
    const { orders } = await storeOrderService.getBuyerOrders(ticket.identityId, { limit: 10 })
    const placed = orders.find(order => order.storeId === input.storeId && sameBytes(order.nonce, nonce))
    if (!placed) return { state: 'unknown', error: new Error('The order is not visible yet') }
    cartService.removeStoreItems(input.storeId)
    return { state: 'applied', documents: [storefrontDoc(STOREFRONT_DOCUMENT_TYPES.STORE_ORDER, placed.id, 'create', true)] }
  } catch (error) {
    return { state: 'unknown', error }
  }
}

/** Orders a delivery is running for in this engine: a second one for any of them waits for nothing, it is refused. */
const delivering = new Set<string>()
const KIT_MOVED = "This product's delivery content changed since you opened it (a delivery took unique codes). Go back, reopen it and save again."

/**
 * Run `work` while no other delivery runs for any of `orderIds` (web disables
 * Deliver while one is on its way). A second delivery would read the same
 * receipts and send the order again.
 */
async function deliveringExclusively<T>(orderIds: string[], work: () => Promise<T>): Promise<T> {
  if (orderIds.some(id => delivering.has(id))) throw badRequest('A delivery for this order is still on its way. Wait for it, then check the order before sending again.')
  for (const id of orderIds) delivering.add(id)
  try {
    return await work()
  } finally {
    for (const id of orderIds) delivering.delete(id)
  }
}

/** Web's "Deliver all" loop: each ready order re-checked as it stands now, one at a time, so each draws codes from the pool the previous left. */
async function deliverAll(seller: string, key: Uint8Array, ready: SellerOrderDTO[]): Promise<BulkDeliveryDTO> {
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
      try {
        const confirmed = await placeOrder(buyer, input, { ticketId: ctx.ticket.id, stage: () => ctx.stage('signing'), documents: docs => ctx.documents(docs) })
        return { state: confirmed ? 'confirmed' : 'unconfirmed' }
      } catch (error) {
        if (error instanceof NotSentError) throw error
        // Signed and maybe sent: look for it before calling it failed.
        const proof = await ctx.probe()
        if (proof.state === 'applied') return { state: 'confirmed', documents: proof.documents }
        throw error
      }
    },
    probe: orderProbe,
  })

  tickets.register<StatusUpdateInput>('store.order.status', {
    // Tracking and message are sealed to the order on v10: not kept in plain storage.
    persistArgs: false,
    stagedSends: true,
    async run(input, ctx) {
      const seller = signer(ctx)
      ctx.stage('queued', true)
      const order = await sellerOrder(seller, input.orderId).catch((error: unknown) => { throw refusedBefore(error) })
      const sealedNote = storefrontStatusIsSealed() && Boolean(input.trackingNumber || input.trackingCarrier || input.message)
      const key = sealedNote ? getEncryptionKeyBytes(seller) : null
      if (sealedNote && !key) throw new NotSentError(badRequest('Unlock your encryption key to add tracking or a message.'))
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

    /**
     * One delivered file, decrypted (web's library download): the viewer
     * must be the order's buyer or its seller, with the key on this device.
     * `itemIndex` and `assetIndex` name it in the delivery as `DeliveryDTO` lists it.
     */
    async deliveredFile(input: { orderId: string; deliveryId: string; itemIndex: number; assetIndex: number }): Promise<DeliveredFileDTO> {
      const viewer = requireViewer('Saving a file')
      const order = await readOrder(input?.orderId)
      const key = getEncryptionKeyBytes(viewer)
      if (!key) throw badRequest(UNLOCK_MESSAGE)
      let delivery: OrderDelivery | undefined
      try {
        if (order.sellerId === viewer) {
          const read = await orderDeliveryService.loadDecrypted([order], (found, owner) => orderDeliveryService.decryptAsSeller(found, owner, key))
          delivery = read.get(order.id)?.find(found => found.id === input.deliveryId)
        } else if (order.buyerId === viewer) {
          const sellerKey = await cachedSellerKey(order.sellerId)
          const found = (await orderDeliveryService.getForBuyer(viewer)).get(order.id)?.find(candidate => candidate.id === input.deliveryId)
          if (found && sellerKey) delivery = { ...found, payload: orderDeliveryService.decryptAsBuyer(found, order, key, sellerKey) }
        } else {
          throw badRequest('This order is not yours')
        }
      } catch (error) {
        throw readFailure(error)
      }
      const asset = delivery?.payload?.items[input.itemIndex]?.assets[input.assetIndex]
      if (!asset || asset.kind !== 'file') throw badRequest('This file could not be found in the delivery')
      if (asset.size > MAX_SAVED_FILE_BYTES) throw badRequest(FILE_TOO_LARGE_MESSAGE)
      // The declared size is the seller's word: the download itself stops past the cap.
      const bytes = await fetchDeliveredFile(asset, MAX_SAVED_FILE_BYTES)
      return { name: asset.name, base64: bytesToBase64(bytes) }
    },

    /** The seller's delivery content for a digital product; `locked` without the key on this device. */
    async kit(itemId: string): Promise<KitReadDTO> {
      const seller = requireViewer('Delivery content')
      const key = getEncryptionKeyBytes(seller)
      if (!key) return { locked: true }
      const stored = (await itemDeliverableService.loadKits([itemId], key).catch((error: unknown) => { throw readFailure(error) })).get(itemId)
      return { locked: false, kit: stored ? kitDTO(stored.kit) : null, revision: kitRevision(stored) }
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
      return deliveringExclusively([input?.orderId], async () => {
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
          return { error: null, pending: result.pending, warnings: result.warnings, recoveryText: result.pendingRecoveryText ?? null }
        } catch (error) {
          // KeyRecoveryError's own text names the codes: the message is its plain sentence, the codes go in recoveryText.
          return { error: error instanceof Error ? error.message : 'Delivery failed.', pending: false, warnings: [], recoveryText: recoveryOf(error) }
        }
      })
    },

    /** Web's "Deliver all": every order on the first page that is ready, one at a time, each re-checked as it stands now. */
    async deliverReady(): Promise<BulkDeliveryDTO> {
      const seller = requireViewer('Delivering orders')
      const key = sellerKeyOrThrow(seller)
      const { orders } = await storeOrderService.getSellerOrders(seller, { limit: 50 })
      const ready = (await sellerOrders(seller, orders)).filter(order => order.readyToDeliver)
      return deliveringExclusively(ready.map(order => order.id), () => deliverAll(seller, key, ready))
    },

    /** Save a digital product's delivery content (web's kit editor). Long-running: it reconciles an unseen write. */
    async saveKit(itemId: string, input: KitDTO, revision: number | null): Promise<KitDTO> {
      const seller = requireViewer('Saving delivery content')
      const key = sellerKeyOrThrow(seller)
      const item = await storeItemService.getById(itemId).catch((error: unknown) => { throw readFailure(error) })
      if (!item || item.ownerId !== seller) throw new RpcError('This product is not yours', 'NOT_OWNER')
      const stored = (await itemDeliverableService.loadKits([itemId], key).catch((error: unknown) => { throw readFailure(error) })).get(itemId)
      if (kitRevision(stored) !== revision) throw badRequest(KIT_MOVED)
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
