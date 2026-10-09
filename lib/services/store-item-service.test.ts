import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, query, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), query: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get, query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));
import { storeItemService } from './store-item-service';

/** `value`, failing the test when it is missing. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

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

describe('storefront v7 typed variants', () => {
  /** Two colours × two sizes; option ids Red=1 S=2 L=3 Blue=4. */
  const table = {
    axes: ['Color', 'Size'], options: ['Red', 'Blue', 'S', 'L'], optionIds: [1, 4, 2, 3], optionAxes: [0, 0, 1, 1], nextOptionId: 5,
    selectors: [Uint8Array.of(1, 2), Uint8Array.of(1, 3), Uint8Array.of(4, 2), Uint8Array.of(4, 3)], prices: [100, 120, 100, 120], stocks: [5, 0, 2, 9],
  };
  const variantItem = { ...raw, basePrice: undefined, stockQuantity: undefined, currency: 'USD', imageUrls: ['https://a/1.png', 'https://a/2.png'], variants: table };

  async function v7() {
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v7');
    vi.resetModules();
    return (await import('./store-item-service')).storeItemService;
  }
  const restore = () => { vi.unstubAllEnvs(); vi.resetModules(); };

  it('reads the stored table and answers by variant id', async () => {
    try {
      const service = await v7();
      get.mockResolvedValue(variantItem);
      const item = defined(await service.getById('item'));
      expect(item.variants?.combinations.map((combination) => combination.id)).toEqual(['1.2', '1.3', '2.4', '3.4']);
      expect(service.getVariantLabel(item, '3.4')).toBe('Blue / L');
      expect(service.getStock(item, '1.3')).toBe(0);
      expect(service.getStock(item, '9.9')).toBe(0);
      expect(service.getPrice(item, '1.3')).toBe(120);
      expect(service.getPriceRange(item)).toEqual({ min: 100, max: 120 });
      expect(service.isOutOfStock(item)).toBe(false);
    } finally { restore(); }
  });

  it('a stock edit re-sends the table as typed lists, one replace for every combination', async () => {
    try {
      const service = await v7();
      get.mockResolvedValue(variantItem);
      const item = defined(await service.getById('item'));
      const restocked = { ...defined(item.variants), combinations: defined(item.variants).combinations.map((combination) => ({ ...combination, stock: 3 })) };
      await service.updateItem('item', 'owner', storeId, { variants: restocked }, 4);
      expect(updateDocument).toHaveBeenCalledTimes(1);
      const sent = updateDocument.mock.calls[0][4];
      expect(sent.variants).toMatchObject({ axes: table.axes, optionIds: table.optionIds, stocks: [3, 3, 3, 3], prices: table.prices });
      expect(sent.variants.selectors[3]).toEqual(Uint8Array.of(4, 3));
      expect(sent).not.toHaveProperty('basePrice');
      // A title edit re-encodes the stored table unchanged.
      await service.updateItem('item', 'owner', storeId, { title: 'Renamed' });
      expect(updateDocument.mock.calls[1][4].variants).toMatchObject({ stocks: table.stocks, optionAxes: table.optionAxes });
    } finally { restore(); }
  });

  it('refuses, before signing, a table or price the contract would refuse', async () => {
    try {
      const service = await v7();
      get.mockResolvedValue(variantItem);
      const item = defined(await service.getById('item'));
      const broken = { ...defined(item.variants), combinations: defined(item.variants).combinations.map((combination, index) => (index === 0 ? { ...combination, stock: undefined } : combination)) };
      await expect(service.updateItem('item', 'owner', storeId, { variants: broken }, 4)).rejects.toThrow(/every combination or for none/);
      await expect(service.updateItem('item', 'owner', storeId, { basePrice: 5 })).rejects.toThrow(/priced and stocked per combination/);
      await expect(service.createItem('owner', storeId, { title: 'T', currency: 'USD', variants: item.variants, stockQuantity: 3 })).rejects.toThrow(/per combination/);
      expect(updateDocument).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('refuses a table edited from an older revision, and needs one to write a table at all', async () => {
    try {
      const service = await v7();
      get.mockResolvedValue(variantItem);
      const item = defined(await service.getById('item'));
      // Another editor saved revision 5 meanwhile; this table was edited from 4.
      get.mockResolvedValue({ ...variantItem, $revision: 5 });
      await expect(service.updateItem('item', 'owner', storeId, { variants: item.variants }, 4)).rejects.toThrow(/changed somewhere else/);
      await expect(service.updateItem('item', 'owner', storeId, { variants: item.variants })).rejects.toThrow(/revision/);
      expect(updateDocument).not.toHaveBeenCalled();
      await service.updateItem('item', 'owner', storeId, { variants: item.variants }, 5);
      expect(updateDocument).toHaveBeenCalledTimes(1);
      expect(updateDocument.mock.calls[0][5]).toBe(5);
    } finally { restore(); }
  });

  it('refuses a table when another editor saves between the check and the replace', async () => {
    try {
      const service = await v7();
      get.mockResolvedValue(variantItem);
      const item = defined(await service.getById('item'));
      // updateItem's read sees 4; the replace's own read, a moment later, sees 5.
      get.mockResolvedValueOnce(variantItem).mockResolvedValueOnce({ ...variantItem, $revision: 5 });
      await expect(service.updateItem('item', 'owner', storeId, { variants: item.variants }, 4)).rejects.toThrow(/changed somewhere else/);
      expect(updateDocument).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('treats a stored table it cannot read as unbuyable, keeps it on other edits, and refuses to edit its options', async () => {
    try {
      const service = await v7();
      // Contract-valid, but the only selector names an option the table does not have.
      const unreadable = { axes: ['Color'], options: ['Red'], optionIds: [1], optionAxes: [0], nextOptionId: 2, selectors: [Uint8Array.of(2)], prices: [100] };
      get.mockResolvedValue({ ...variantItem, variants: unreadable });
      const item = defined(await service.getById('item'));
      expect(item.variants).toBeUndefined();
      expect(service.getStock(item)).toBe(0);
      expect(service.isOutOfStock(item)).toBe(true);
      await service.updateItem('item', 'owner', storeId, { status: 'paused' });
      expect(updateDocument.mock.calls[0][4].variants).toEqual(unreadable);
      await expect(service.updateItem('item', 'owner', storeId, { variants: undefined, basePrice: 5 }, 4)).rejects.toThrow(/could not be read/);
    } finally { restore(); }
  });

  it('refuses a gallery with the same image twice when a combination names images by position', async () => {
    try {
      const service = await v7();
      get.mockResolvedValue(variantItem);
      const item = defined(await service.getById('item'));
      const pictured = { ...defined(item.variants), combinations: defined(item.variants).combinations.map((combination) => ({ ...combination, image: 2 })) };
      await expect(service.updateItem('item', 'owner', storeId, { variants: pictured, imageUrls: ['https://a/1.png', 'https://a/1.png', 'https://a/2.png'] }, 4)).rejects.toThrow(/same image is in this listing twice/);
      expect(updateDocument).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('stores up to 12 images on v7', async () => {
    try {
      const service = await v7();
      get.mockResolvedValue({ ...raw, imageUrls: [] });
      const twelve = Array.from({ length: 12 }, (_, index) => `https://a/${index}.png`);
      await service.updateItem('item', 'owner', storeId, { imageUrls: twelve });
      expect(updateDocument.mock.calls[0][4].imageUrls).toEqual(twelve);
      await expect(service.updateItem('item', 'owner', storeId, { imageUrls: [...twelve, 'https://a/x.png'] })).rejects.toThrow(/At most 12/);
    } finally { restore(); }
  });

  it('on v1 writes the table as the JSON string, a combination image as its URL', async () => {
    const legacy = JSON.stringify({ axes: [{ name: 'Size', options: ['S', 'M'] }], combinations: [{ key: 'S', price: 1000, imageUrl: 'https://a/2.png' }, { key: 'M', price: 1500 }] });
    get.mockResolvedValue({ ...raw, basePrice: undefined, imageUrls: '["https://a/1.png","https://a/2.png"]', variants: legacy });
    const item = defined(await storeItemService.getById('item'));
    expect(item.variants?.combinations[0]).toMatchObject({ id: '1', price: 1000, image: 2 });
    const repointed = { ...defined(item.variants), combinations: defined(item.variants).combinations.map((combination) => ({ ...combination, image: 1 })) };
    await storeItemService.updateItem('item', 'owner', storeId, { variants: repointed }, 4);
    expect(JSON.parse(updateDocument.mock.calls[0][4].variants).combinations).toEqual([
      { key: 'S', price: 1000, imageUrl: 'https://a/1.png' }, { key: 'M', price: 1500, imageUrl: 'https://a/1.png' },
    ]);
    // Dropping an image a combination still shows is refused, not silently re-pointed.
    await expect(storeItemService.updateItem('item', 'owner', storeId, { imageUrls: ['https://a/2.png'] })).rejects.toThrow(/image the listing no longer has/);
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

describe('product edits (QA D-09, D-11, D-22)', () => {
  const variants = { axes: [{ name: 'Size', options: ['S', 'M'] }], combinations: [{ key: 'S', price: 1000 }, { key: 'M', price: 1500 }] };

  it('an edit that names no status keeps a paused product paused', async () => {
    get.mockResolvedValue({ ...raw, status: 'paused' });
    await storeItemService.updateItem('item', 'owner', storeId, { title: 'Tracked product', description: 'New copy' });
    expect(updateDocument.mock.calls[0][4]).toMatchObject({ status: 'paused', description: 'New copy' });
  });

  it('unticking variants removes them so the base price applies', async () => {
    get.mockResolvedValue({ ...raw, variants: JSON.stringify(variants) });
    const result = await storeItemService.updateItem('item', 'owner', storeId, { basePrice: 999, variants: undefined }, 4);
    expect(updateDocument.mock.calls[0][4]).not.toHaveProperty('variants');
    expect(storeItemService.getPriceRange(result)).toEqual({ min: 999, max: 999 });
  });

  it('a blanked description leaves the replacement', async () => {
    await storeItemService.updateItem('item', 'owner', storeId, { description: undefined });
    expect(updateDocument.mock.calls[0][4]).not.toHaveProperty('description');
  });

  it('archiving replaces the item with the deleted status instead of deleting it', async () => {
    const result = await storeItemService.archiveItem('item', 'owner', storeId);
    expect(updateDocument.mock.calls[0][4]).toMatchObject({ status: 'deleted', title: raw.title, stockQuantity: 7 });
    expect(result.status).toBe('deleted');
  });
});
