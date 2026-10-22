import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartItem, Store, StoreItem } from '@/lib/types';

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: {} }) }));

/** Fresh cart and store services under storefront v11 (the topology is read when `constants` loads). */
async function servicesOnV11() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v11');
  const [{ cartService, HIDDEN_ITEM_MESSAGE, HIDDEN_STORE_MESSAGE }, { storeItemService }, { storeService }] = await Promise.all([
    import('./cart-service'), import('./store-item-service'), import('./store-service'),
  ]);
  return { cartService, storeItemService, storeService, HIDDEN_ITEM_MESSAGE, HIDDEN_STORE_MESSAGE };
}

const hidden = { mod: 1, modLabel: 2, moderatedBy: 'mod', moderatedAt: 5 };
const product = (overrides: Partial<StoreItem> = {}): StoreItem => ({
  id: 'item', storeId: 'store', ownerId: 'seller', createdAt: new Date(),
  title: 'Mug', description: '', section: 'goods', basePrice: 100,
  currency: 'DASH', status: 'active', stockQuantity: 5, ...overrides,
} as StoreItem);
const store = (overrides: Partial<Store> = {}): Store => ({ id: 'store', ownerId: 'seller', name: 'Anvil', status: 'active', createdAt: new Date(), ...overrides } as Store);
const line: CartItem = { itemId: 'item', storeId: 'store', title: 'Mug', quantity: 1, unitPrice: 100, currency: 'DASH' };

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the cart gate for hidden items and hidden stores', () => {
  it('refuses to add a hidden item, and an item from a hidden store, saying hidden', async () => {
    const { cartService, HIDDEN_ITEM_MESSAGE, HIDDEN_STORE_MESSAGE } = await servicesOnV11();
    expect(() => cartService.addStoreItem(product({ moderation: hidden } as Partial<StoreItem>))).toThrow(HIDDEN_ITEM_MESSAGE);
    expect(() => cartService.addStoreItem(product(), undefined, 1, store({ moderation: hidden }))).toThrow(HIDDEN_STORE_MESSAGE);
    expect(HIDDEN_ITEM_MESSAGE).not.toMatch(/remov|delet/i);
    expect(cartService.getItemCount()).toBe(0);
    cartService.addStoreItem(product(), undefined, 1, store());
    expect(cartService.getItemCount()).toBe(1);
  });

  it('adds a hidden item on an archival build', async () => {
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all');
    const { cartService } = await servicesOnV11();
    cartService.addStoreItem(product({ moderation: hidden } as Partial<StoreItem>));
    expect(cartService.getItemCount()).toBe(1);
  });

  it('reports a hidden item in the cart as unavailable, and a listed one as available', async () => {
    const { cartService, storeItemService, storeService, HIDDEN_ITEM_MESSAGE } = await servicesOnV11();
    vi.spyOn(storeService, 'getCurrent').mockResolvedValue(store());
    const query = vi.spyOn(storeItemService, 'query').mockResolvedValue({ documents: [product({ moderation: hidden } as Partial<StoreItem>)] });
    await expect(cartService.getAvailability([line])).resolves.toMatchObject([{ maxQuantity: 0, reason: HIDDEN_ITEM_MESSAGE }]);
    query.mockResolvedValue({ documents: [product()] });
    await expect(cartService.getAvailability([line])).resolves.toMatchObject([{ maxQuantity: 5, reason: undefined }]);
  });

  it('reports every line of a hidden store as unavailable without reading its items', async () => {
    const { cartService, storeItemService, storeService, HIDDEN_STORE_MESSAGE } = await servicesOnV11();
    const current = vi.spyOn(storeService, 'getCurrent').mockResolvedValue(store({ moderation: hidden }));
    const query = vi.spyOn(storeItemService, 'query').mockResolvedValue({ documents: [product()] });
    const result = await cartService.getAvailability([line, { ...line, itemId: 'other' }]);
    expect(result.map(({ reason }) => reason)).toEqual([HIDDEN_STORE_MESSAGE, HIDDEN_STORE_MESSAGE]);
    expect(current).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    await expect(cartService.validateItems([line])).resolves.toHaveLength(1);
  });

  it('does not read stores before storefront v11', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v10');
    const [{ cartService }, { storeItemService }, { storeService }] = await Promise.all([
      import('./cart-service'), import('./store-item-service'), import('./store-service'),
    ]);
    const current = vi.spyOn(storeService, 'getCurrent').mockResolvedValue(store({ moderation: hidden }));
    vi.spyOn(storeItemService, 'query').mockResolvedValue({ documents: [product()] });
    await expect(cartService.getAvailability([line])).resolves.toMatchObject([{ reason: undefined }]);
    expect(current).not.toHaveBeenCalled();
  });
});
