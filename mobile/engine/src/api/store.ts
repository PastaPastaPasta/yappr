import { storefrontIsV6, storefrontSupportsDigital, storefrontSupportsItemZones } from '@/lib/constants'
import { cartLineKey, cartService, getCartCurrency } from '@/lib/services/cart-service'
import { isDigitalLine } from '@/lib/services/digital-delivery-plan'
import { itemReviewService } from '@/lib/services/item-review-service'
import { checkShipping, shippingZoneService, SHIPPING_CHECK_FAILED_MESSAGE } from '@/lib/services/shipping-zone-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { storeOrderService } from '@/lib/services/store-order-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { storeService } from '@/lib/services/store-service'
import { storeStatsService } from '@/lib/services/store-stats-service'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { ORDER_PAYMENT_FIELD_LIMITS, orderPaymentBudgetError } from '@/lib/storefront/storefront-contract'
import { parseStorePolicies } from '@/lib/utils/policies'
import { filterPaymentUris } from '@/lib/utils/payment-uri'
import type { CartItem, ShippingAddress, ShippingZone, Store, StoreItem, StorePolicy, ParsedPaymentUri, BuyerContact } from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import { badRequest, readFailure, requireViewer, viewerId } from '../dto/hydrate'
import type { TicketStore } from '../writes/tickets'
import { createOrderModule } from './store-orders'
import { createStoreWrites } from './store-writes'
import { checkoutBlockerMessage, checkoutReadiness, cleanAddress, cleanContact, sellerEncryptionKey, type CheckoutBlocker } from './store-shared'

export type { CheckoutBlocker } from './store-shared'

export type {
  ItemVariants, Store, StoreItem, StoreReview, ItemReview, StoreStatus, StoreItemStatus, ShippingZone, ShippingAddress, BuyerContact,
  ShippingTier, ShippingPricingConfig, ShippingRateType, StorePolicy, OrderPayload, OrderItem, OrderStatus, DigitalAsset, DeliverWhen,
  ItemDeliverablePayload, StoreRatingSummary, VariantCombination, VariantAxis,
} from '@/lib/types'
export type { ParsedPaymentUri } from '@/lib/types'

export interface StoreQuery { sort?: 'newest' | 'topRated' | 'mostOrdered'; limit?: number }
export interface StoreItemQuery { storeId: string; cursor?: string; activeOnly?: boolean; limit?: number }

/** One cart line as the app shows it. `key` names it for every cart call (`cartLineKey`). */
export interface CartLineDTO {
  key: string
  itemId: string
  storeId: string
  title: string
  variantId?: string
  variantLabel?: string
  quantity: number
  /** In the currency's smallest unit. */
  unitPrice: number
  currency: string
  imageUrl?: string
  digital: boolean
}

export interface CartStoreDTO {
  storeId: string
  /** Null when the store could not be read. */
  storeName: string | null
  /** Null when the lines mix currencies: they cannot be checked out together (web's cart says so). */
  currency: string | null
  subtotal: number
  lines: CartLineDTO[]
}

export interface CartDTO {
  stores: CartStoreDTO[]
  /** Units across every line. */
  count: number
}

export interface CheckoutQuoteDTO {
  store: { id: string; name: string; ownerId: string; policies: StorePolicy[]; paymentUris: ParsedPaymentUri[] }
  /** The store's lines as they check out now (a product switched to or from digital is updated). */
  lines: CartLineDTO[]
  /** Lines that cannot be bought as they stand, by line key. */
  unavailable: { key: string; title: string; reason: string }[]
  /** Null when the lines mix currencies. */
  currency: string | null
  digitalCount: number
  /** Nothing ships: no address is needed. */
  digitalOnly: boolean
  subtotal: number
  /**
   * `none`: no shipping asked for (or nothing ships); `ok`: priced; `problem`: these
   * lines cannot ship to the address (`problem` says why, web's copy).
   */
  shipping: { state: 'none' | 'ok' | 'problem'; cost: number; problem: string | null; shipments: { zone: string; cost: number; titles: string[] }[] }
  total: number
  blocker: CheckoutBlocker | null
  blockerMessage: string | null
  /** v6: the order could outgrow the encrypted payload cap even before the payment fields. */
  orderSizeError: string | null
  /** v6: the longest transaction id, refund address and notes the order has room for. */
  paymentFieldLimits: { txid: number; refundAddress: number; notes: number } | null
}

/** What the seller's dashboard needs at once (web `/store/manage`). */
export interface StoreManageDTO {
  store: Store | null
  /** The store's policies, parsed (web `parseStorePolicies`). */
  policies: StorePolicy[]
  items: StoreItem[]
  zones: ShippingZone[]
  /** Storefront v6+: a store's category is required. */
  categoryRequired: boolean
  supportsDigital: boolean
  supportsItemZones: boolean
  /**
   * Buyers encrypt orders to the seller's encryption key: without one on the
   * identity nobody can order. False when it could not be read either.
   */
  canTakeOrders: boolean
  /** The seller's encryption key is on this device (reading orders, delivering). */
  keyOnDevice: boolean
}

export interface StoreDetailDTO {
  store: Store
  rating: { average: number; count: number } | null
  /** The viewer owns it. */
  own: boolean
}

const cap = (value: number | undefined, fallback = 20) => Math.max(1, Math.min(50, Math.trunc(value ?? fallback)))

function cartLineDTO(line: CartItem): CartLineDTO {
  return {
    key: cartLineKey(line),
    itemId: line.itemId,
    storeId: line.storeId,
    title: line.title,
    ...(line.variantId ? { variantId: line.variantId } : {}),
    ...(line.variantLabel ? { variantLabel: line.variantLabel } : {}),
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    currency: line.currency || 'USD',
    ...(line.imageUrl ? { imageUrl: line.imageUrl } : {}),
    digital: isDigitalLine(line),
  }
}

/** The stored line `key` names; BAD_REQUEST when the cart has none. */
function cartLine(key: string): CartItem {
  const line = cartService.getItems().find(item => cartLineKey(item) === key)
  if (!line) throw badRequest('That item is no longer in your cart')
  return line
}

const subtotalOf = (lines: readonly CartItem[]) => lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)

async function cartDTO(): Promise<CartDTO> {
  const items = cartService.getItems()
  const storeIds = cartService.getStoreIds()
  const stores = await storeService.getMany(storeIds).catch(() => [] as Store[])
  const names = new Map(stores.map(store => [store.id, store.name]))
  return {
    count: cartService.getItemCount(),
    stores: storeIds.map(storeId => {
      const lines = items.filter(item => item.storeId === storeId)
      return { storeId, storeName: names.get(storeId) ?? null, currency: getCartCurrency(lines), subtotal: subtotalOf(lines), lines: lines.map(cartLineDTO) }
    }),
  }
}

/** A product's listing read past the cache, or BAD_REQUEST when it is gone. */
async function currentItem(itemId: string): Promise<StoreItem> {
  let documents: StoreItem[]
  try {
    ({ documents } = await storeItemService.query({ where: [['$id', '==', itemId]], limit: 1 }))
  } catch (error) {
    throw readFailure(error)
  }
  if (!documents[0]) throw badRequest('This item is no longer available')
  return documents[0]
}

function assertAddress(address: unknown): asserts address is ShippingAddress {
  const value = address as Partial<ShippingAddress> | null
  if (typeof value !== 'object' || value === null) throw badRequest('shipTo must be an address')
  for (const field of ['name', 'street', 'city', 'postalCode', 'country'] as const) {
    if (typeof value[field] !== 'string') throw badRequest(`shipTo.${field} must be text`)
  }
}

/**
 * Web `/checkout`'s state for a store's cart: availability (read past the
 * cache), readiness, the shipping quote to `shipTo` (null: no shipping asked
 * for), totals, and whether the order fits v6's payload cap. A read: it
 * changes nothing but a line whose product switched to or from digital.
 */
async function checkoutQuote(input: { storeId: string; shipTo?: ShippingAddress | null; contact?: BuyerContact | null }): Promise<CheckoutQuoteDTO> {
  const viewer = requireViewer('Checking out')
  if (typeof input?.storeId !== 'string') throw badRequest('storeId is required')
  if (input.shipTo) assertAddress(input.shipTo)
  let store: Store | null
  try {
    store = await storeService.getById(input.storeId)
  } catch (error) {
    throw readFailure(error)
  }
  if (!store) throw new RpcError('This store could not be found', 'TARGET_GONE')
  const stored = cartService.getItemsForStore(store.id)
  if (stored.length === 0) throw badRequest('Your cart has nothing from this store')

  const availability = await cartService.getAvailability(stored)
  const lines = availability.map(result => result.item)
  const unavailable = availability.flatMap(result => (result.reason ? [{ key: cartLineKey(result.item), title: result.item.title, reason: result.reason }] : []))
  const currency = getCartCurrency(lines)
  const digitalCount = lines.filter(isDigitalLine).length
  const digitalOnly = digitalCount === lines.length
  const shipTo = input.shipTo && !digitalOnly ? cleanAddress(input.shipTo) : null

  let shipping: CheckoutQuoteDTO['shipping'] = { state: 'none', cost: 0, problem: null, shipments: [] }
  if (shipTo) {
    try {
      const shippingLines = await cartService.getShippingLines(lines)
      const zones = await shippingZoneService.getByStore(store.id).catch(() => null)
      const check = checkShipping(zones, shippingLines, shipTo)
      shipping = {
        state: check.problem ? 'problem' : 'ok',
        cost: check.quote?.cost ?? 0,
        problem: check.problem,
        shipments: (check.quote?.shipments ?? []).map(shipment => ({ zone: shipment.zone.name, cost: shipment.cost, titles: shipment.lines.map(line => line.title) })),
      }
    } catch {
      shipping = { state: 'problem', cost: 0, problem: SHIPPING_CHECK_FAILED_MESSAGE, shipments: [] }
    }
  }

  const readiness = await checkoutReadiness(store, viewer)
  const subtotal = subtotalOf(lines)
  const paymentUris = filterPaymentUris(store.paymentUris ?? [])
  const draft = storeOrderService.buildOrderPayload(lines, shipTo ?? undefined, cleanContact(input.contact), shipping.cost, paymentUris[0]?.uri ?? '', currency ?? 'USD')
  return {
    store: { id: store.id, name: store.name, ownerId: store.ownerId, policies: parseStorePolicies(store.policies), paymentUris },
    lines: lines.map(cartLineDTO),
    unavailable,
    currency,
    digitalCount,
    digitalOnly,
    subtotal,
    shipping,
    total: subtotal + shipping.cost,
    blocker: readiness.blocker,
    blockerMessage: checkoutBlockerMessage(readiness.blocker),
    orderSizeError: orderPaymentBudgetError(draft, paymentUris.map(payment => payment.uri)),
    paymentFieldLimits: storefrontIsV6() ? { ...ORDER_PAYMENT_FIELD_LIMITS } : null,
  }
}

/** `cart.*`: the device's cart (web `cartService`, kept in the engine's storage). */
function createCartModule() {
  return {
    async get(): Promise<CartDTO> {
      return cartDTO()
    },

    /** Add `quantity` of a product (and variant) as it is listed now; BAD_REQUEST with web's reason when it can't be. */
    async add(input: { itemId: string; variantId?: string | null; quantity?: number }): Promise<CartDTO> {
      if (typeof input?.itemId !== 'string') throw badRequest('itemId is required')
      const quantity = Math.trunc(input.quantity ?? 1)
      if (!(quantity >= 1)) throw badRequest('quantity must be at least 1')
      const item = await currentItem(input.itemId)
      try {
        cartService.addStoreItem(item, input.variantId ?? undefined, quantity)
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'This item could not be added')
      }
      return cartDTO()
    },

    /** Set a line's quantity; 0 removes it. */
    async setQuantity(key: string, quantity: number): Promise<CartDTO> {
      if (!Number.isInteger(quantity) || quantity < 0) throw badRequest('quantity must be a whole number')
      cartService.updateQuantity(cartLine(key), quantity)
      return cartDTO()
    },

    async remove(key: string): Promise<CartDTO> {
      cartService.removeItem(cartLine(key))
      return cartDTO()
    },
  }
}

export function createStoreModule(tickets: TicketStore) {
  const orders = createOrderModule(tickets)
  return {
    store: {
      async discover(query: StoreQuery = {}) {
        return storeService.getDiscoveryStores(query.sort ?? 'newest', cap(query.limit, 30))
      },
      async get(id: string): Promise<Store | null> { return storeService.getById(id) },
      /** The store, its rating and whether the viewer owns it. Null when it does not exist. */
      async detail(id: string): Promise<StoreDetailDTO | null> {
        const store = await storeService.getById(id)
        if (!store) return null
        const summary = await storeStatsService.getStoreRatingSummary(id).catch(() => null)
        const viewer = viewerId()
        return { store, rating: summary && summary.reviewCount > 0 ? { average: summary.averageRating, count: summary.reviewCount } : null, own: store.ownerId === viewer }
      },
      async items(query: StoreItemQuery): Promise<{ items: StoreItem[]; nextCursor?: string }> {
        return storeItemService.getByStore(query.storeId, { limit: cap(query.limit), startAfter: query.cursor, activeOnly: query.activeOnly ?? true })
      },
      async item(id: string): Promise<StoreItem | null> { return storeItemService.getById(id) },
      async reviews(storeId: string, cursor?: string) { return storeReviewService.getStoreReviews(storeId, { limit: 20, startAfter: cursor }) },
      async itemReviews(itemId: string, cursor?: string) { return itemReviewService.getItemReviews(itemId, { limit: 20, startAfter: cursor }) },
      /** A store's shipping zones, highest priority first. */
      async zones(storeId: string): Promise<ShippingZone[]> { return shippingZoneService.getByStore(storeId) },
      async mine(): Promise<Store | null> { return storeService.getByOwner(requireViewer('Your store')) },
      /** The seller's store with every listing (paused and sold out too) and its zones. */
      async manage(): Promise<StoreManageDTO> {
        const viewer = requireViewer('Managing a store')
        const store = await storeService.getByOwner(viewer)
        const [items, zones, sellerKey] = await Promise.all([
          store ? storeItemService.getAllByStore(store.id) : Promise.resolve([]),
          store ? shippingZoneService.getByStore(store.id) : Promise.resolve([]),
          sellerEncryptionKey(viewer).catch(() => null),
        ])
        return {
          store,
          policies: parseStorePolicies(store?.policies),
          items: items.filter(item => item.status !== 'deleted'),
          zones,
          categoryRequired: storefrontIsV6(),
          supportsDigital: storefrontSupportsDigital(),
          supportsItemZones: storefrontSupportsItemZones(),
          canTakeOrders: sellerKey !== null,
          keyOnDevice: getEncryptionKeyBytes(viewer) !== null,
        }
      },
      checkout: checkoutQuote,
      ...orders.reads,
      ...orders.writes,
      ...createStoreWrites(tickets),
    },
    cart: createCartModule(),
  }
}
