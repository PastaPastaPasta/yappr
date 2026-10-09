import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CartItem, ItemVariants, StoreItem } from '@/lib/types'
import { variantsFromRows, type VariantRow } from '@/lib/storefront/variant-codec'
import { scopedKey } from '@/lib/storage-scope'
import { storeItemService } from './store-item-service'
import { cartService, getCartCurrency } from './cart-service'

/** A one-axis table; option ids run 1, 2, … in row order, so variant ids are '1', '2', … */
const sizes = (rows: Array<Omit<VariantRow, 'optionNames'> & { name: string }>): ItemVariants =>
  variantsFromRows(['Size'], rows.map(({ name, ...data }) => ({ optionNames: [name], ...data }))).variants as ItemVariants

const product = (overrides: Partial<StoreItem> = {}): StoreItem => ({
  id: 'item', storeId: 'store', ownerId: 'seller', createdAt: new Date(),
  title: 'Limited item', description: '', section: 'goods', basePrice: 100,
  currency: 'DASH', status: 'active', stockQuantity: 2, ...overrides
} as StoreItem)
const cartItem = (overrides: Partial<CartItem> = {}): CartItem => ({
  itemId: 'item', storeId: 'store', title: 'Limited item', quantity: 2,
  unitPrice: 100, currency: 'DASH', ...overrides
})
const respond = (item: StoreItem | null) => vi.mocked(storeItemService.query).mockResolvedValue({ documents: item ? [item] : [] })

beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) })
  vi.restoreAllMocks()
  vi.spyOn(storeItemService, 'query').mockResolvedValue({ documents: [] })
  cartService.clearCart()
})

describe('cart inventory', () => {
  it('counts prior additions against the product stock', () => {
    cartService.addStoreItem(product(), undefined, 2)
    expect(() => cartService.addStoreItem(product())).toThrow('Only 2 available')
    expect(cartService.getItems()[0].quantity).toBe(2)
  })

  it('allows untracked stock to be added repeatedly', () => {
    cartService.addStoreItem(product({ stockQuantity: undefined }), undefined, 2)
    cartService.addStoreItem(product({ stockQuantity: undefined }), undefined, 3)
    expect(cartService.getItems()[0].quantity).toBe(5)
  })

  it('keeps per-variant additions within their own stock', () => {
    const item = product({ basePrice: undefined, stockQuantity: undefined, variants: sizes([{ name: 'S', price: 100, stock: 1 }, { name: 'M', price: 120, stock: 2 }]) })
    cartService.addStoreItem(item, '1')
    cartService.addStoreItem(item, '2', 2)
    expect(() => cartService.addStoreItem(item, '1')).toThrow('Only 1 available')
    expect(cartService.getItemCount()).toBe(3)
    expect(cartService.getItems().map(line => [line.variantId, line.variantLabel, line.unitPrice])).toEqual([['1', 'S', 100], ['2', 'M', 120]])
  })

  it('snapshots the SKU when a line is added: the variant\'s, else the item\'s', () => {
    const item = product({ basePrice: undefined, stockQuantity: undefined, sku: 'TEE', variants: sizes([{ name: 'S', price: 100, sku: 'TEE-S' }, { name: 'M', price: 100 }]) })
    cartService.addStoreItem(item, '1')
    cartService.addStoreItem(item, '2')
    cartService.addStoreItem(product({ id: 'plain', sku: 'MUG' }))
    expect(cartService.getItems().map(line => line.sku)).toEqual(['TEE-S', 'TEE', 'MUG'])
  })

  it('names a line by its variant id and shows the variant image', () => {
    const variants = sizes([{ name: 'S', price: 100, image: 2 }, { name: 'M', price: 100 }])
    const item = product({ basePrice: undefined, stockQuantity: undefined, imageUrls: ['https://a/hero.png', 'https://a/small.png'], variants })
    cartService.addStoreItem(item, '1')
    cartService.addStoreItem(item, '2')
    expect(cartService.getItems().map(line => line.imageUrl)).toEqual(['https://a/small.png', 'https://a/hero.png'])
    const [small, medium] = cartService.getItems()
    cartService.updateQuantity(small, 4)
    cartService.removeItem(medium)
    expect(cartService.getItems()).toMatchObject([{ variantId: '1', quantity: 4 }])
  })

  it('on v1–v6 never merges a new choice into an old line that shares its positional id', () => {
    const red = product({ basePrice: undefined, stockQuantity: undefined, variants: sizes([{ name: 'Red', price: 100, stock: 1 }, { name: 'Blue', price: 200, stock: 1 }]) })
    cartService.addStoreItem(red, '1')
    // The seller moved Blue first: id '1' is now Blue.
    const moved = product({ basePrice: undefined, stockQuantity: undefined, variants: sizes([{ name: 'Blue', price: 200, stock: 1 }, { name: 'Red', price: 100, stock: 1 }]) })
    cartService.addStoreItem(moved, '1')
    expect(cartService.getItems().map(line => [line.variantId, line.variantOptions, line.quantity])).toEqual([['1', ['Red'], 1], ['1', ['Blue'], 1]])
    cartService.removeItem(cartService.getItems()[0])
    expect(cartService.getItems().map(line => line.variantOptions)).toEqual([['Blue']])
  })

  it('rejects removed variants, and a variant item named without one, before adding them', () => {
    const item = product({ basePrice: undefined, stockQuantity: undefined, variants: sizes([{ name: 'S', price: 100 }]) })
    expect(() => cartService.addStoreItem(item, '9')).toThrow('no longer available')
    expect(() => cartService.addStoreItem(item)).toThrow('no longer available')
    expect(cartService.getItems()).toHaveLength(0)
  })

  it('a line naming a variant of an item that has none is no longer available', async () => {
    respond(product())
    expect(await cartService.validateItems([cartItem({ variantId: '1', variantOptions: ['S'], quantity: 1 })])).toMatchObject([{ maxQuantity: 0, reason: 'Selected option is no longer available' }])
  })

  it('on v1–v6 tells combinations apart by their exact option names, however they read', async () => {
    // ["A / B", "C"] and ["A", "B / C"] read the same joined; the names tell them apart.
    const variants = variantsFromRows(['X', 'Y'], [{ optionNames: ['A / B', 'C'], price: 100 }, { optionNames: ['A', 'B / C'], price: 200 }]).variants as ItemVariants
    // Reversing both option lists swaps which combination positional id '1.3' names.
    const reversed = variantsFromRows(['X', 'Y'], [{ optionNames: ['A', 'B / C'], price: 200 }, { optionNames: ['A / B', 'C'], price: 100 }]).variants as ItemVariants
    expect(reversed.combinations[0].id).toBe(variants.combinations[0].id)
    respond(product({ stockQuantity: undefined, basePrice: undefined, variants: reversed }))
    const line = { variantId: variants.combinations[0].id, variantLabel: 'A / B / C', quantity: 1 }
    expect(await cartService.validateItems([cartItem({ ...line, variantOptions: ['A / B', 'C'] })])).toMatchObject([{ reason: 'Selected option is no longer available' }])
    expect(await cartService.validateItems([cartItem({ ...line, variantOptions: ['A', 'B / C'] })])).toEqual([])
    // A line without its names cannot be checked, so it is not trusted.
    expect(await cartService.validateItems([cartItem(line)])).toMatchObject([{ reason: 'Selected option is no longer available' }])
  })

  it('drops lines saved before variants had ids, and keeps the rest', async () => {
    const lines = [cartItem(), { ...cartItem({ itemId: 'old' }), variantKey: 'Blue|L' }, cartItem({ itemId: 'v', variantId: '1', variantLabel: 'S' })]
    localStorage.setItem(scopedKey('yappr_cart'), JSON.stringify({ items: lines, updatedAt: 0 }))
    vi.resetModules()
    const { cartService: reloaded } = await import('./cart-service')
    expect(reloaded.getItems().map(line => line.itemId)).toEqual(['item', 'v'])
  })

  it('weighs each shipped line by its variant, else by its item', async () => {
    const item = product({ weight: 500, basePrice: undefined, stockQuantity: undefined, variants: sizes([{ name: 'Single', price: 100 }, { name: '4-pack', price: 353, weight: 1800 }]) })
    vi.spyOn(storeItemService, 'get').mockResolvedValue(item)
    cartService.addStoreItem(item, '1', 2)
    cartService.addStoreItem(item, '2')
    expect(await cartService.getTotalWeight()).toBe(2 * 500 + 1800)
  })

  it('returns a maximum for a cart already at available stock', async () => {
    respond(product())
    expect(await cartService.getAvailability([cartItem()])).toEqual([{ item: cartItem(), maxQuantity: 2, reason: undefined }])
    expect(await cartService.validateItems([cartItem()])).toEqual([])
  })

  it('blocks an overstock snapshot without clamping or dropping it', async () => {
    cartService.addItem(cartItem({ quantity: 3 }))
    respond(product())
    const snapshot = JSON.stringify(cartService.getCart())
    expect(await cartService.validateItems()).toMatchObject([{ maxQuantity: 2, reason: 'Only 2 available' }])
    expect(JSON.stringify(cartService.getCart())).toBe(snapshot)
  })

  it.each([
    [null, 'Item is no longer available'],
    [product({ status: 'inactive' as StoreItem['status'] }), 'Item is no longer available'],
    [product({ stockQuantity: 0 }), 'Out of stock']
  ])('blocks unavailable products (%s)', async (item, reason) => {
    respond(item)
    expect(await cartService.validateItems([cartItem()])).toMatchObject([{ maxQuantity: 0, reason }])
  })

  it('does not mistake a removed option for unlimited inventory', async () => {
    respond(product({ stockQuantity: undefined, basePrice: undefined, variants: sizes([{ name: 'S', price: 100 }]) }))
    expect(await cartService.validateItems([cartItem({ variantId: '7' })])).toMatchObject([{ maxQuantity: 0, reason: 'Selected option is no longer available' }])
    expect(await cartService.validateItems([cartItem()])).toMatchObject([{ maxQuantity: 0, reason: 'Selected option is no longer available' }])
  })

  it('checks a variant line against that variant\'s stock', async () => {
    respond(product({ stockQuantity: undefined, basePrice: undefined, variants: sizes([{ name: 'S', price: 100, stock: 1 }, { name: 'M', price: 100, stock: 0 }]) }))
    expect(await cartService.validateItems([cartItem({ variantId: '1', variantOptions: ['S'], quantity: 1 })])).toEqual([])
    expect(await cartService.validateItems([cartItem({ variantId: '2', variantOptions: ['M'], quantity: 1 })])).toMatchObject([{ maxQuantity: 0, reason: 'Out of stock' }])
  })

  it('on v1–v6, where ids follow option order, a line whose label no longer matches its id names nothing', async () => {
    // The seller moved M first: id '1' is now M, but the line was added as S.
    respond(product({ stockQuantity: undefined, basePrice: undefined, variants: sizes([{ name: 'M', price: 200 }, { name: 'S', price: 100 }]) }))
    expect(await cartService.validateItems([cartItem({ variantId: '1', variantOptions: ['S'], quantity: 1 })])).toMatchObject([{ maxQuantity: 0, reason: 'Selected option is no longer available' }])
  })

  it('preserves the cart through a failed lookup and permits a successful retry', async () => {
    cartService.addItem(cartItem())
    const snapshot = JSON.stringify(cartService.getCart())
    vi.mocked(storeItemService.query).mockRejectedValue(new Error('offline'))
    expect(await cartService.validateItems()).toMatchObject([{ reason: 'Could not check availability. Please try again.' }])
    expect(JSON.stringify(cartService.getCart())).toBe(snapshot)
    respond(product())
    expect(await cartService.validateItems()).toEqual([])
    expect(JSON.stringify(cartService.getCart())).toBe(snapshot)
  })

  it('validates only the selected checkout snapshot and re-reads current stock', async () => {
    cartService.addItem(cartItem({ itemId: 'other-item', storeId: 'other-store' }))
    respond(product())
    expect(await cartService.validateItems([cartItem()])).toEqual([])
    respond(product({ stockQuantity: 1 }))
    expect(await cartService.validateItems([cartItem()])).toMatchObject([{ reason: 'Only 1 available' }])
    expect(vi.mocked(storeItemService.query).mock.calls.map(([options]) => options?.where)).toEqual([
      [['$id', '==', 'item']], [['$id', '==', 'item']]
    ])
  })
})

describe('cart currencies (QA D-02)', () => {
  it('names the single currency of a store cart, and none for a mix', () => {
    expect(getCartCurrency([cartItem(), cartItem({ itemId: 'b' })])).toBe('DASH')
    expect(getCartCurrency([cartItem({ currency: 'USD' }), cartItem({ itemId: 'b', currency: 'DASH' })])).toBeNull()
    expect(getCartCurrency([])).toBe('USD')
  })

  it('refuses an item priced in another currency than the store lines already in the cart', () => {
    cartService.addStoreItem(product({ id: 'usd', currency: 'USD', basePrice: 725 }))
    expect(() => cartService.addStoreItem(product({ id: 'dash', currency: 'DASH', basePrice: 1500000 }))).toThrow('priced in USD')
    expect(cartService.getItems().map(item => item.itemId)).toEqual(['usd'])
  })

  it('keeps each store to its own currency', () => {
    cartService.addStoreItem(product({ id: 'usd', currency: 'USD' }))
    cartService.addStoreItem(product({ id: 'dash', storeId: 'other', currency: 'DASH' }))
    expect(cartService.getItems()).toHaveLength(2)
  })
})
