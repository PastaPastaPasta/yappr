import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CartItem, StoreItem } from '@/lib/types'

vi.mock('./store-item-service', () => ({
  storeItemService: {
    query: vi.fn(),
    getPrice: (item: StoreItem) => item.basePrice,
    getStock: (item: StoreItem, key?: string) => key
      ? item.variants?.combinations.find(combo => combo.key === key)?.stock ?? Infinity
      : item.stockQuantity ?? Infinity,
    getCombination: (item: StoreItem, key: string) => item.variants?.combinations.find(combo => combo.key === key)
  }
}))
import { storeItemService } from './store-item-service'
import { cartService } from './cart-service'

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
  vi.clearAllMocks()
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
    const item = product({ variants: { axes: [{ name: 'Size', options: ['S', 'M'] }], combinations: [{ key: 'S', price: 100, stock: 1 }, { key: 'M', price: 100, stock: 2 }] } })
    cartService.addStoreItem(item, 'S')
    cartService.addStoreItem(item, 'M', 2)
    expect(() => cartService.addStoreItem(item, 'S')).toThrow('Only 1 available')
    expect(cartService.getItemCount()).toBe(3)
  })

  it('rejects removed variants before adding them', () => {
    expect(() => cartService.addStoreItem(product({ variants: { axes: [], combinations: [] } }), 'removed')).toThrow('no longer available')
    expect(cartService.getItems()).toHaveLength(0)
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
    respond(product({ stockQuantity: undefined, variants: { axes: [], combinations: [] } }))
    expect(await cartService.validateItems([cartItem({ variantKey: 'old' })])).toMatchObject([{ maxQuantity: 0, reason: 'Selected option is no longer available' }])
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
