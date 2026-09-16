import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));
import { storeItemService } from './store-item-service';

const storeId = '11111111111111111111111111111111';
const raw = {
  $id: 'item', $ownerId: 'owner', $revision: 4, $createdAt: 1700000000000,
  storeId, title: 'Tracked product', status: 'active', stockQuantity: 7,
  basePrice: 2500000, currency: 'DASH', description: 'Keep this description',
};

beforeEach(() => {
  storeItemService.clearCache();
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
