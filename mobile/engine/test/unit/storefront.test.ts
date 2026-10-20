/**
 * The native storefront (`store.*`, `cart.*`) with lib's services mocked:
 * checkout readiness and quoting, placing an encrypted order (every
 * refusal before the write sends nothing), the seller's status updates,
 * digital delivery's refusals, and the seller form checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CartItem, OrderPayload, ShippingZone, Store, StoreItem } from '@/lib/types'

const kv = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => kv.get(key) ?? null,
    setItem: (key: string, value: string) => { kv.set(key, value) },
    removeItem: (key: string) => { kv.delete(key) },
  },
})

const m = vi.hoisted(() => ({
  viewer: 'V' as string | null,
  cart: [] as CartItem[],
  availability: vi.fn(),
  shippingLines: vi.fn(),
  removeStoreItems: vi.fn(),
  store: { getById: vi.fn(), getCurrent: vi.fn(), getByOwner: vi.fn(), getMany: vi.fn(async () => []), createStore: vi.fn(), updateStore: vi.fn() },
  zones: { getByStore: vi.fn() },
  order: { encryptOrderPayload: vi.fn(), createOrder: vi.fn(), get: vi.fn(), decryptOrderPayload: vi.fn(), getBuyerOrders: vi.fn() },
  status: { createStatusUpdate: vi.fn() },
  buyerKey: null as Uint8Array | null,
  sellerKey: null as Uint8Array | null,
  deliveries: { loadDecrypted: vi.fn() },
  kits: { loadKits: vi.fn(), saveKit: vi.fn() },
  items: { getManyFresh: vi.fn(), getById: vi.fn(), createItem: vi.fn(), updateItem: vi.fn() },
  reviews: { getOrderReviews: vi.fn(), createReview: vi.fn() },
  itemReviews: { query: vi.fn(), createItemReview: vi.fn() },
  fulfillOrder: vi.fn(),
}))

vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/constants', async (load) => ({ ...await load<object>(), storefrontIsV2: () => true, storefrontIsV6: () => true, storefrontSupportsDigital: () => true, storefrontStatusIsSealed: () => false }))
vi.mock('@/lib/secure-storage', async (load) => ({ ...await load<object>(), getEncryptionKeyBytes: () => m.buyerKey }))
vi.mock('@/lib/crypto/encryption-key-lookup', async (load) => ({ ...await load<object>(), resolveEncryptionPublicKey: async () => m.sellerKey }))
vi.mock('@/lib/services/cart-service', async (load) => {
  const actual = await load<typeof import('@/lib/services/cart-service')>()
  return {
    ...actual,
    cartService: {
      getItems: () => m.cart,
      getItemsForStore: (storeId: string) => m.cart.filter(line => line.storeId === storeId),
      getStoreIds: () => [...new Set(m.cart.map(line => line.storeId))],
      getItemCount: () => m.cart.reduce((sum, line) => sum + line.quantity, 0),
      getAvailability: m.availability,
      getShippingLines: m.shippingLines,
      removeStoreItems: m.removeStoreItems,
    },
  }
})
vi.mock('@/lib/services/store-service', () => ({ storeService: m.store }))
vi.mock('@/lib/services/shipping-zone-service', async (load) => {
  const actual = await load<typeof import('@/lib/services/shipping-zone-service')>()
  return { ...actual, shippingZoneService: { ...actual.shippingZoneService, getByStore: m.zones.getByStore, quoteShipping: actual.shippingZoneService.quoteShipping.bind(actual.shippingZoneService) } }
})
vi.mock('@/lib/services/store-order-service', async (load) => {
  const actual = await load<typeof import('@/lib/services/store-order-service')>()
  return { storeOrderService: { ...m.order, buildOrderPayload: actual.storeOrderService.buildOrderPayload.bind(actual.storeOrderService) } }
})
vi.mock('@/lib/services/order-status-service', async (load) => ({ ...await load<object>(), orderStatusService: { ...m.status, getLatestStatuses: async () => new Map() } }))
vi.mock('@/lib/services/order-delivery-service', () => ({ orderDeliveryService: m.deliveries }))
vi.mock('@/lib/services/item-deliverable-service', async (load) => ({ ...await load<object>(), itemDeliverableService: m.kits }))
vi.mock('@/lib/services/store-item-service', () => ({ storeItemService: m.items }))
vi.mock('@/lib/services/store-review-service', () => ({ storeReviewService: m.reviews }))
vi.mock('@/lib/services/item-review-service', () => ({ itemReviewService: m.itemReviews }))
vi.mock('@/lib/services/digital-fulfillment', async (load) => ({ ...await load<object>(), fulfillOrder: m.fulfillOrder }))

const { createTicketStore } = await import('../../src/writes/tickets')
const { createStoreModule } = await import('../../src/api/store')
const { cartLineKey } = await import('@/lib/services/cart-service')
const { identifierToBase58 } = await import('@/lib/services/sdk-helpers')
type WriteTicket = import('../../src/writes/types').WriteTicket

/** A real base58 document id (32 bytes), distinct per tag. */
const id = (tag: string) => identifierToBase58(new Uint8Array(32).map((_, i) => (tag.charCodeAt(i % tag.length) * (i + 1)) % 256 || 1)) as string
const BUYER = id('Buyer')
const SELLER = id('Seller')
const STORE = id('Store')
const ITEM = id('Item')
const ORDER = id('Order')
const SELLER_KEY = new Uint8Array(33).fill(2)

const store = (extra: Partial<Store> = {}): Store => ({
  id: STORE, ownerId: SELLER, createdAt: new Date(0), name: 'Shop', status: 'active',
  paymentUris: [{ scheme: 'dash:', uri: 'dash:yXdashAddress' }], policies: JSON.stringify([{ name: 'Returns', content: '30 days' }]), ...extra,
})
const line = (extra: Partial<CartItem> = {}): CartItem => ({ itemId: ITEM, storeId: STORE, title: 'Mug', quantity: 2, unitPrice: 500, currency: 'USD', ...extra })
const zone = (extra: Partial<ShippingZone> = {}): ShippingZone => ({ id: id('Zone'), ownerId: SELLER, storeId: STORE, createdAt: new Date(0), name: 'US', rateType: 'flat', flatRate: 700, priority: 0, countryPattern: 'US', ...extra })
const address = { name: 'Ann', street: '1 Main', city: 'Town', postalCode: '12345', country: 'us' }

function engine() {
  const tickets = createTicketStore({
    storage: { getItem: () => null, setItem: () => undefined }, emit: () => undefined, currentIdentity: () => m.viewer,
    documentExists: async () => true, absenceRecheckMs: 0, autoRetryDelaysMs: [],
  })
  return { tickets, ...createStoreModule(tickets) }
}

function settled(tickets: ReturnType<typeof engine>['tickets'], ticket: WriteTicket) {
  return vi.waitFor(() => {
    const current = tickets.get(ticket.id)
    if (!current || current.state === 'pending') throw new Error('still pending')
    return current
  }, { timeout: 5_000, interval: 5 })
}

beforeEach(() => {
  vi.clearAllMocks()
  m.viewer = BUYER
  m.cart = [line()]
  m.buyerKey = new Uint8Array(32).fill(7)
  m.sellerKey = SELLER_KEY
  m.availability.mockImplementation(async (items: CartItem[]) => items.map(item => ({ item, maxQuantity: 10 })))
  m.shippingLines.mockImplementation(async (items: CartItem[]) => items.filter(item => item.fulfillment !== 'digital').map(item => ({ itemId: item.itemId, title: item.title, weight: 0, subtotal: item.unitPrice * item.quantity })))
  m.store.getById.mockResolvedValue(store())
  m.store.getCurrent.mockResolvedValue(store())
  m.zones.getByStore.mockResolvedValue([zone()])
  m.order.encryptOrderPayload.mockResolvedValue(new Uint8Array([1, 2, 3]))
  m.order.createOrder.mockResolvedValue({ id: ORDER, __createConfirmed: true })
})

describe('checkout quote', () => {
  it('quotes the zone that ships to the address, with web copy for every blocker', async () => {
    const quote = await engine().store.checkout({ storeId: STORE, shipTo: address })
    expect(quote.blocker).toBeNull()
    expect(quote.shipping).toMatchObject({ state: 'ok', cost: 700 })
    expect(quote.subtotal).toBe(1000)
    expect(quote.total).toBe(1700)
    expect(quote.store.policies).toEqual([{ name: 'Returns', content: '30 days' }])
    expect(quote.lines[0].key).toBe(cartLineKey(line()))
  })

  it('names the lines that do not ship to the address', async () => {
    m.zones.getByStore.mockResolvedValue([zone({ countryPattern: 'DE' })])
    const quote = await engine().store.checkout({ storeId: STORE, shipTo: address })
    expect(quote.shipping.state).toBe('problem')
    expect(quote.shipping.problem).toMatch(/cannot ship/)
  })

  it('needs no address for an all-digital cart', async () => {
    m.cart = [line({ fulfillment: 'digital' })]
    const quote = await engine().store.checkout({ storeId: STORE, shipTo: address })
    expect(quote.digitalOnly).toBe(true)
    expect(quote.shipping.state).toBe('none')
    expect(m.shippingLines).not.toHaveBeenCalled()
  })

  it.each([
    ['own-store', () => { m.viewer = SELLER }],
    ['store-unavailable', () => { m.store.getCurrent.mockResolvedValue(store({ status: 'paused' })) }],
    ['no-payment-methods', () => { m.store.getById.mockResolvedValue(store({ paymentUris: [] })) }],
    ['missing-buyer-key', () => { m.buyerKey = null }],
    ['missing-seller-key', () => { m.sellerKey = null }],
    ['invalid-seller-key', () => { m.sellerKey = new Uint8Array(33).fill(9) }],
  ])('blocks payment: %s', async (blocker, arrange) => {
    arrange()
    const quote = await engine().store.checkout({ storeId: STORE, shipTo: null })
    expect(quote.blocker).toBe(blocker)
    expect(quote.blockerMessage).toBeTruthy()
  })
})

describe('placing an order', () => {
  const reviewed = (quantity = 2, shippingCost = 700) => ({ lines: [{ key: cartLineKey(line()), quantity, digital: false }], shippingCost })

  it('encrypts the order to the seller with the buyer key, places it and empties the store from the cart', async () => {
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, contact: { email: ' a@b.c ' }, paymentUri: 'dash:yXdashAddress', reviewed: reviewed() }))
    expect(ticket.state).toBe('confirmed')
    expect(ticket.documents).toEqual([expect.objectContaining({ type: 'storeOrder', id: ORDER, action: 'create', confirmed: true })])
    const [payload, buyerKey, sellerKey, nonce, storeId] = m.order.encryptOrderPayload.mock.calls[0] as [OrderPayload, Uint8Array, Uint8Array, Uint8Array, string]
    expect(payload).toMatchObject({ subtotal: 1000, shippingCost: 700, total: 1700, buyerContact: { email: 'a@b.c' }, shippingAddress: { country: 'US' } })
    expect(buyerKey).toBe(m.buyerKey)
    expect(sellerKey).toBe(SELLER_KEY)
    expect(nonce).toHaveLength(24)
    expect(storeId).toBe(STORE)
    expect(m.order.createOrder).toHaveBeenCalledWith(BUYER, expect.objectContaining({ storeId: STORE, sellerId: SELLER, nonce }))
    expect(m.removeStoreItems).toHaveBeenCalledWith(STORE)
  })

  it.each([
    ['the cart changed', () => reviewed(3), /cart changed/],
    ['shipping changed', () => reviewed(2, 100), /Shipping changed/],
  ])('sends nothing when %s since review', async (_, input, message) => {
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, paymentUri: 'dash:yXdashAddress', reviewed: input() }))
    expect(ticket.state).toBe('failed')
    expect(ticket.error).toMatchObject({ code: 'BAD_REQUEST', outcome: 'local' })
    expect(ticket.error?.userMessage).toMatch(message)
    expect(m.order.createOrder).not.toHaveBeenCalled()
    expect(m.removeStoreItems).not.toHaveBeenCalled()
  })

  it('refuses a payment method the store does not list', async () => {
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, paymentUri: 'dash:yOther', reviewed: reviewed() }))
    expect(ticket.error?.userMessage).toMatch(/payment methods/)
    expect(m.order.createOrder).not.toHaveBeenCalled()
  })

  it('asks for the key when it is not on the device (never NO_KEY: that reads as a sign-in gone)', async () => {
    m.buyerKey = null
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, paymentUri: 'dash:yXdashAddress', reviewed: reviewed() }))
    expect(ticket.error).toMatchObject({ code: 'BAD_REQUEST', userMessage: expect.stringMatching(/Unlock your account/) })
    expect(m.order.createOrder).not.toHaveBeenCalled()
  })

  it('finds an order whose call threw after signing, and empties the cart then', async () => {
    m.order.createOrder.mockRejectedValue(new Error('Gateway timeout'))
    // The attempt's own order: the nonce it encrypted with.
    m.order.getBuyerOrders.mockImplementation(async () => ({
      orders: [{ id: ORDER, storeId: STORE, createdAt: new Date(), nonce: m.order.encryptOrderPayload.mock.calls[0][3] as Uint8Array }],
    }))
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, paymentUri: 'dash:yXdashAddress', reviewed: reviewed() }))
    expect(ticket.state).toBe('confirmed')
    expect(ticket.documents).toEqual([expect.objectContaining({ id: ORDER, type: 'storeOrder' })])
    expect(m.removeStoreItems).toHaveBeenCalledWith(STORE)
  })

  it('never takes another recent order to the same store for this attempt', async () => {
    m.order.createOrder.mockRejectedValue(new Error('Gateway timeout'))
    m.order.getBuyerOrders.mockResolvedValue({ orders: [{ id: id('Earlier'), storeId: STORE, createdAt: new Date(), nonce: new Uint8Array(24).fill(9) }] })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, paymentUri: 'dash:yXdashAddress', reviewed: reviewed() }))
    expect(ticket.state).not.toBe('confirmed')
    expect(m.removeStoreItems).not.toHaveBeenCalled()
  })

  it('sends nothing when the encryption fails before signing', async () => {
    m.order.encryptOrderPayload.mockRejectedValue(new Error('bad key'))
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, paymentUri: 'dash:yXdashAddress', reviewed: reviewed() }))
    expect(ticket).toMatchObject({ state: 'failed', retryable: true })
    expect(m.order.createOrder).not.toHaveBeenCalled()
  })

  it('stays unconfirmed when the broadcast was not confirmed', async () => {
    m.order.createOrder.mockResolvedValue({ id: ORDER, __createConfirmed: false })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.placeOrder({ storeId: STORE, shipTo: address, paymentUri: 'dash:yXdashAddress', reviewed: reviewed() }))
    expect(ticket.state).toBe('unconfirmed')
  })
})

describe('order status', () => {
  it('only the seller updates an order', async () => {
    m.viewer = BUYER
    m.order.get.mockResolvedValue({ id: ORDER, buyerId: BUYER, sellerId: SELLER, storeId: STORE })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.updateOrderStatus({ orderId: ORDER, status: 'shipped' }))
    expect(ticket.error).toMatchObject({ code: 'BAD_REQUEST', outcome: 'local', userMessage: expect.stringMatching(/not placed with your store/) })
    expect(m.status.createStatusUpdate).not.toHaveBeenCalled()
  })

  it('writes the status against the order buyer', async () => {
    m.viewer = SELLER
    m.order.get.mockResolvedValue({ id: ORDER, buyerId: BUYER, sellerId: SELLER, storeId: STORE })
    m.status.createStatusUpdate.mockResolvedValue({ id: id('Status'), __createConfirmed: true })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.updateOrderStatus({ orderId: ORDER, status: 'shipped', trackingNumber: '1Z' }))
    expect(ticket.state).toBe('confirmed')
    expect(m.status.createStatusUpdate).toHaveBeenCalledWith(SELLER, ORDER, expect.objectContaining({ status: 'shipped', trackingNumber: '1Z', buyerId: BUYER }))
  })

  it('refuses an unknown status before submitting', async () => {
    await expect(engine().store.updateOrderStatus({ orderId: ORDER, status: 'lost' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('digital delivery', () => {
  const digitalPayload: OrderPayload = {
    items: [{ itemId: ITEM, itemTitle: 'Ebook', quantity: 1, unitPrice: 500, fulfillment: 'digital' }],
    buyerContact: {}, subtotal: 500, shippingCost: 0, total: 500, currency: 'USD', paymentUri: 'dash:y',
  }
  const listing: Partial<StoreItem> = { id: ITEM, storeId: STORE, fulfillment: 'digital', title: 'Ebook', basePrice: 500, currency: 'USD', status: 'active' }

  beforeEach(() => {
    m.viewer = SELLER
    m.buyerKey = new Uint8Array(32).fill(5)
    m.order.get.mockResolvedValue({ id: ORDER, buyerId: BUYER, sellerId: SELLER, storeId: STORE, nonce: new Uint8Array(24), encryptedPayload: new Uint8Array(1) })
    m.order.decryptOrderPayload.mockResolvedValue(digitalPayload)
    m.deliveries.loadDecrypted.mockResolvedValue(new Map())
    m.items.getManyFresh.mockResolvedValue([listing])
  })

  it('refuses to deliver a line with nothing to send, naming it', async () => {
    m.kits.loadKits.mockResolvedValue(new Map())
    const e = engine()
    const plan = await e.store.deliveryPlan(ORDER)
    expect(plan.blockers.join(' ')).toMatch(/"Ebook" has no delivery content/)
    await expect(e.store.deliver({ orderId: ORDER })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(m.fulfillOrder).not.toHaveBeenCalled()
  })

  it('delivers the kit, with a link added for this order, and marks an all-digital order delivered', async () => {
    m.kits.loadKits.mockResolvedValue(new Map([[ITEM, { deliverable: { id: id('Kit') }, kit: { v: 1, assets: [], instructions: 'Enjoy', deliverWhen: 'on_order' } }]]))
    m.fulfillOrder.mockResolvedValue({ delivery: { id: id('Delivery'), nonce: new Uint8Array(24) }, pending: false, updatedKits: new Map(), warnings: [] })
    const e = engine()
    const plan = await e.store.deliveryPlan(ORDER)
    expect(plan).toMatchObject({ blockers: [], marksDelivered: true, lines: [expect.objectContaining({ itemId: ITEM, contents: ['Instructions'] })] })
    const result = await e.store.deliver({ orderId: ORDER, extras: { [ITEM]: [{ kind: 'link', label: 'Mirror', url: 'https://example.com/book' }] } })
    expect(result).toEqual({ error: null, pending: false, warnings: [], recoveryText: null })
    const input = m.fulfillOrder.mock.calls[0][0] as { delivery: { items: { assets: unknown[]; instructions?: string }[] }; markDelivered: boolean }
    expect(input.markDelivered).toBe(true)
    expect(input.delivery.items[0]).toMatchObject({ instructions: 'Enjoy', assets: [{ kind: 'link', label: 'Mirror', url: 'https://example.com/book' }] })
  })

  it('normalizes a bare link like web, and refuses one that cannot be opened safely', async () => {
    m.kits.loadKits.mockResolvedValue(new Map([[ITEM, { deliverable: { id: id('Kit') }, kit: { v: 1, assets: [], deliverWhen: 'on_order' } }]]))
    m.fulfillOrder.mockResolvedValue({ delivery: { id: id('Delivery'), nonce: new Uint8Array(24) }, pending: false, updatedKits: new Map(), warnings: [] })
    const e = engine()
    await e.store.deliver({ orderId: ORDER, extras: { [ITEM]: [{ kind: 'link', label: '', url: 'drive.example.com/book' }] } })
    expect((m.fulfillOrder.mock.calls[0][0] as { delivery: { items: { assets: unknown[] }[] } }).delivery.items[0].assets).toEqual([{ kind: 'link', label: 'https://drive.example.com/book', url: 'https://drive.example.com/book' }])
    await expect(e.store.deliver({ orderId: ORDER, extras: { [ITEM]: [{ kind: 'link', label: 'x', url: 'javascript:alert(1)' }] } })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/Links must start/) })
  })

  it('refuses a second delivery for an order while one runs, and returns a failure with its codes as data', async () => {
    m.kits.loadKits.mockResolvedValue(new Map([[ITEM, { deliverable: { id: id('Kit') }, kit: { v: 1, assets: [], instructions: 'Enjoy', deliverWhen: 'on_order' } }]]))
    let finish: (value: unknown) => void = () => undefined
    m.fulfillOrder.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const e = engine()
    const first = e.store.deliver({ orderId: ORDER })
    await vi.waitFor(() => expect(m.fulfillOrder).toHaveBeenCalled())
    await expect(e.store.deliver({ orderId: ORDER })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/still on its way/) })
    finish({ delivery: { id: id('Delivery'), nonce: new Uint8Array(24) }, pending: false, updatedKits: new Map(), warnings: [] })
    await first
    const { KeyRecoveryError } = await import('@/lib/services/digital-fulfillment')
    m.fulfillOrder.mockRejectedValue(new KeyRecoveryError('Nothing was delivered.', [{ itemTitle: 'Ebook', keys: ['KEY-1'] }], new Map()))
    const failed = await e.store.deliver({ orderId: ORDER })
    expect(failed.error).toBe('Nothing was delivered.')
    expect(failed.recoveryText).toContain('KEY-1')
  })

  it('needs the key on this device', async () => {
    m.buyerKey = null
    await expect(engine().store.deliveryPlan(ORDER)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/Unlock/) })
  })
})

describe('delivery content', () => {
  beforeEach(() => {
    m.viewer = SELLER
    m.buyerKey = new Uint8Array(32).fill(5)
    m.items.getById.mockResolvedValue({ id: ITEM, ownerId: SELLER })
    m.kits.saveKit.mockResolvedValue({ id: id('Kit') })
  })

  const stored = (revision: number) => new Map([[ITEM, {
    deliverable: { id: id('Kit'), $revision: revision },
    kit: { v: 1, assets: [{ kind: 'code', label: 'Red only', code: 'R', optionIds: [3] }, { kind: 'file', name: 'a.pdf', size: 1, url: 'ipfs://x', key: 'k' }], licenseKeys: ['A', 'B'], deliverWhen: 'on_order' },
  }]])

  it('keeps variant targets and files through a round trip', async () => {
    m.kits.loadKits.mockResolvedValue(stored(2))
    const e = engine()
    const read = await e.store.kit(ITEM)
    if (read.locked || !read.kit) throw new Error('no kit read')
    expect(read.revision).toBe(2)
    await e.store.saveKit(ITEM, { ...read.kit, instructions: 'Hi' }, read.revision)
    const saved = m.kits.saveKit.mock.calls[0][2] as { assets: { kind: string; optionIds?: number[] }[]; licenseKeys: string[] }
    expect(saved.assets).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'code', optionIds: [3] }), expect.objectContaining({ kind: 'file' })]))
    expect(saved.licenseKeys).toEqual(['A', 'B'])
  })

  it('refuses a save from a copy older than the stored kit (a delivery took codes)', async () => {
    m.kits.loadKits.mockResolvedValue(stored(3))
    await expect(engine().store.saveKit(ITEM, { instructions: '', files: [], links: [], codes: [], licenseKeys: ['A', 'B'], deliverWhen: 'on_order' }, 2))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/changed since you opened it/) })
    expect(m.kits.saveKit).not.toHaveBeenCalled()
  })
})

describe('seller forms', () => {
  beforeEach(() => { m.viewer = SELLER })

  it('requires a category on v6 and parses payment URIs', async () => {
    const e = engine()
    await expect(e.store.saveStore({ fields: { name: 'Shop' } })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/category/) })
    await expect(e.store.saveStore({ fields: { name: 'Shop', category: 'books', paymentUris: ['not a uri'] } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('sends no image list for a product without images (an empty one is refused on chain)', async () => {
    m.items.createItem.mockResolvedValue({ id: ITEM, __createConfirmed: true })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.saveItem({ storeId: STORE, fields: { title: 'Ebook', imageUrls: [], basePrice: 250, fulfillment: 'digital' } }))
    expect(ticket.state).toBe('confirmed')
    expect(m.items.createItem.mock.calls[0][2]).toMatchObject({ imageUrls: undefined, fulfillment: 'digital', basePrice: 250 })
  })

  it('takes testnet Dash addresses as tdash: and refuses dash: for them, with the hint', async () => {
    const e = engine()
    await expect(e.store.saveStore({ fields: { name: 'Shop', category: 'books', paymentUris: ['dash:yLadnCajwhccmjsUS1Bm2icVv5ehdeFtxj'] } })).rejects.toMatchObject({ message: expect.stringMatching(/tdash:/) })
    await expect(e.store.saveStore({ fields: { name: 'Shop', category: 'books', paymentUris: ['tdash:yLadnCajwhccmjsUS1Bm2icVv5ehdeFtxj'] } })).resolves.toMatchObject({ op: 'store.save' })
  })

  it('never clears a saved options table (its ids live on in carts and kits)', async () => {
    m.items.getById.mockResolvedValue({ id: ITEM, ownerId: SELLER, variants: { axes: [], combinations: [{ id: '1', optionIds: [1], price: 1 }], nextOptionId: 2 } })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.saveItem({ storeId: STORE, itemId: ITEM, revision: 1, fields: { title: 'Mug', variants: { axes: [], combinations: [], nextOptionId: 2 } } }))
    expect(ticket.error).toMatchObject({ code: 'BAD_REQUEST', userMessage: expect.stringMatching(/options can't be removed/) })
    expect(m.items.updateItem).not.toHaveBeenCalled()
  })

  it('creates the store once', async () => {
    m.store.getByOwner.mockResolvedValue(null)
    m.store.createStore.mockResolvedValue({ id: STORE, __createConfirmed: true })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.saveStore({ fields: { name: ' Shop ', category: 'Books' } }))
    expect(ticket.state).toBe('confirmed')
    expect(m.store.createStore).toHaveBeenCalledWith(SELLER, expect.objectContaining({ name: 'Shop', category: 'books', status: 'active' }))
    m.store.getByOwner.mockResolvedValue(store())
    const again = await settled(e.tickets, await e.store.saveStore({ fields: { name: 'Shop', category: 'books' } }))
    expect(again.error?.userMessage).toMatch(/already have a store/)
  })
})

describe('reviews', () => {
  beforeEach(() => {
    m.viewer = BUYER
    m.order.get.mockResolvedValue({ id: ORDER, buyerId: BUYER, sellerId: SELLER, storeId: STORE })
  })

  it('resumes after an item review failed: neither the store review nor a landed item review is written twice', async () => {
    m.reviews.getOrderReviews.mockResolvedValue(new Map([[ORDER, { id: id('Review') }]]))
    const A = id('ItemA')
    const B = id('ItemB')
    m.itemReviews.query.mockImplementation(async ({ where }: { where: [string, string, string][] }) => ({ documents: where[1][2] === A ? [{ id: id('RevA') }] : [] }))
    m.itemReviews.createItemReview.mockResolvedValue({ id: id('RevB'), __createConfirmed: true })
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.review({ orderId: ORDER, rating: 5, items: [{ itemId: A, rating: 4 }, { itemId: B, rating: 5 }] }))
    expect(ticket.state).toBe('confirmed')
    expect(m.reviews.createReview).not.toHaveBeenCalled()
    expect(m.itemReviews.createItemReview).toHaveBeenCalledTimes(1)
    expect(m.itemReviews.createItemReview).toHaveBeenCalledWith(BUYER, expect.objectContaining({ itemId: B }))
  })

  it('sends nothing when it cannot tell whether the store review landed', async () => {
    m.reviews.getOrderReviews.mockRejectedValue(new Error('network'))
    const e = engine()
    const ticket = await settled(e.tickets, await e.store.review({ orderId: ORDER, rating: 5 }))
    expect(ticket).toMatchObject({ state: 'failed', retryable: true })
    expect(m.reviews.createReview).not.toHaveBeenCalled()
  })
})

describe('cart', () => {
  it('groups lines by store and says when they mix currencies', async () => {
    m.cart = [line(), line({ itemId: id('Other'), currency: 'EUR' })]
    m.store.getMany.mockResolvedValue([store()] as never)
    const cart = await engine().cart.get()
    expect(cart.count).toBe(4)
    expect(cart.stores).toEqual([expect.objectContaining({ storeId: STORE, storeName: 'Shop', currency: null })])
  })
})
