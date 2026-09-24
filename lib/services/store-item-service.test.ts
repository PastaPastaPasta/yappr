import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, query, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), query: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get, query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));
import { storeItemService } from './store-item-service';

const storeId = '11111111111111111111111111111111';
const raw = {
  $id: 'item', $ownerId: 'owner', $revision: 4, $createdAt: 1700000000000,
  storeId, title: 'Tracked product', status: 'active', stockQuantity: 7,
  basePrice: 2500000, currency: 'DASH', description: 'Keep this description',
};
const records = Array.from({ length: 104 }, (_, index) => ({
  $id: `item-${index}`, $ownerId: storeId, $createdAt: 1000 + index,
  storeId, title: `Product ${index}`, basePrice: 0, currency: 'DASH', status: 'active',
}));

beforeEach(() => {
  storeItemService.clearCache();
  query.mockReset();
  get.mockReset().mockResolvedValue(raw);
  updateDocument.mockReset().mockImplementation(async (_contract, _type, id, owner, data, revision) => ({
    success: true,
    document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  }));
});

describe('product stock replacements', () => {
  it('removes explicitly cleared stock from the replacement while preserving other fields', async () => {
    const result = await storeItemService.updateItem('item', 'owner', storeId, { stockQuantity: undefined });
    const replacement = updateDocument.mock.calls[0][4];
    expect(replacement).not.toHaveProperty('stockQuantity');
    expect(replacement).toMatchObject({ title: raw.title, status: raw.status, basePrice: raw.basePrice, description: raw.description });
    expect(storeItemService.getStock(result)).toBe(Infinity);
  });

  it('preserves tracked stock when another field changes', async () => {
    await storeItemService.updateItem('item', 'owner', storeId, { title: 'Renamed product' });
    expect(updateDocument.mock.calls[0][4]).toMatchObject({ title: 'Renamed product', stockQuantity: 7 });
  });

  it('keeps zero as explicitly out of stock', async () => {
    const result = await storeItemService.updateItem('item', 'owner', storeId, { stockQuantity: 0 });
    expect(updateDocument.mock.calls[0][4]).toMatchObject({ stockQuantity: 0 });
    expect(storeItemService.isOutOfStock(result)).toBe(true);
  });
});

describe('the replace merge re-encodes parsed fields (docs/SOCIAL_V9.md TODO 20)', () => {
  const variants = { axes: [{ name: 'Size', options: ['S'] }], combinations: [{ key: 'S', price: 1 }] };
  const stored = { ...raw, tags: '["wood","catan"]', imageUrls: '["https://example.com/a.png"]', variants: JSON.stringify(variants) };

  it('a stock edit re-sends tags, images and variants as the v1–v3 JSON strings, storeId as bytes', async () => {
    get.mockResolvedValue(stored);
    await storeItemService.updateItem('item', 'owner', storeId, { stockQuantity: 3 });
    const replacement = updateDocument.mock.calls[0][4];
    expect(replacement).toMatchObject({ tags: '["wood","catan"]', imageUrls: '["https://example.com/a.png"]', variants: JSON.stringify(variants), stockQuantity: 3 });
    expect(replacement.storeId).toBeInstanceOf(Uint8Array);
  });

  it('on storefront v4 writes tags and images as lists and reads a stored list back', async () => {
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v4');
    vi.resetModules();
    try {
      const { storeItemService: v4Service } = await import('./store-item-service');
      get.mockResolvedValue({ ...stored, tags: ['wood', 'catan'], imageUrls: ['https://example.com/a.png'] });
      await v4Service.updateItem('item', 'owner', storeId, { stockQuantity: 3 });
      expect(updateDocument.mock.calls[0][4]).toMatchObject({ tags: ['wood', 'catan'], imageUrls: ['https://example.com/a.png'], variants: JSON.stringify(variants) });
      await v4Service.updateItem('item', 'owner', storeId, { tags: ['new'] });
      expect(updateDocument.mock.calls[1][4]).toMatchObject({ tags: ['new'] });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('storefront v4 list limits', () => {
  it('refuses an image URL the v4 pattern rejects before anything is written', async () => {
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v4');
    vi.resetModules();
    try {
      const { storeItemService: v4Service } = await import('./store-item-service');
      await expect(v4Service.updateItem('item', 'owner', storeId, { imageUrls: ['ftp://example.com/a.png'] }))
        .rejects.toThrow(/https:\/\//);
      expect(updateDocument).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('complete store product list', () => {
  it('includes products beyond the first 100 in creation order', async () => {
    query.mockResolvedValueOnce(records.slice(0, 100)).mockResolvedValueOnce(records.slice(100));

    const items = await storeItemService.getAllByStore(storeId);

    expect(items.map(item => item.id)).toEqual(records.map(record => record.$id));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatchObject({
      where: [['storeId', '==', storeId]],
      orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']],
      limit: 100,
      startAfter: 'item-99',
    });
  });

  it('checks for exhaustion after exactly 100 products without losing any', async () => {
    query.mockResolvedValueOnce(records.slice(0, 100)).mockResolvedValueOnce([]);
    await expect(storeItemService.getAllByStore(storeId)).resolves.toHaveLength(100);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('finishes an empty store in one query', async () => {
    query.mockResolvedValueOnce([]);
    await expect(storeItemService.getAllByStore(storeId)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not return a truncated list when a later page fails', async () => {
    query.mockResolvedValueOnce(records.slice(0, 100)).mockRejectedValueOnce(new Error('offline'));
    await expect(storeItemService.getAllByStore(storeId)).rejects.toThrow('offline');
  });

  it('stops instead of looping if the service repeats a full page', async () => {
    query.mockResolvedValue(records.slice(0, 100));
    await expect(storeItemService.getAllByStore(storeId)).rejects.toThrow('pagination did not advance');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
