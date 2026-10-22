import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { get, query, ranked, average, count, updateDocument } = vi.hoisted(() => ({
  get: vi.fn(), query: vi.fn(), ranked: vi.fn(), average: vi.fn(), count: vi.fn(), updateDocument: vi.fn(),
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get, query, ranked, average, count } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));

const storeId = '11111111111111111111111111111111';
const itemId = '22222222222222222222222222222222';

/** Fresh services under the given storefront cut (the topology is read when `constants` loads). */
async function servicesOn(topology: 'v10' | 'v11') {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology);
  const [{ storeService }, { storeItemService }, { storeReviewService }, { itemReviewService }, { storeStatsService }] = await Promise.all([
    import('./store-service'), import('./store-item-service'), import('./store-review-service'),
    import('./item-review-service'), import('./store-stats-service'),
  ]);
  return { storeService, storeItemService, storeReviewService, itemReviewService, storeStatsService };
}

const rawStore = {
  $id: 'store', $ownerId: 'owner', $revision: 3, $createdAt: 1700000000000, name: 'Anvil', status: 'active', category: 'art',
};
const hiddenMarks = { mod: 1, modLabel: 6, $moderatedBy: 'mod', $moderatedAt: 1700000005000 };

beforeEach(() => {
  query.mockReset().mockResolvedValue(new Map());
  get.mockReset();
  ranked.mockReset().mockResolvedValue({ entries: [], valueScale: 1n });
  average.mockReset().mockResolvedValue(new Map());
  count.mockReset().mockResolvedValue(new Map());
  updateDocument.mockReset().mockImplementation(async (_contract, _type, id, owner, data, revision) => ({
    success: true,
    document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('storefront v11 reads pin the listed lane in the index order', () => {
  it('lists stores by status and category through mod == null', async () => {
    const { storeService } = await servicesOn('v11');
    await storeService.getNewestActiveStores(10);
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['status', '==', 'active'], ['mod', '==', null]],
      orderBy: [['status', 'asc'], ['mod', 'asc'], ['$createdAt', 'desc']],
    }));
    await storeService.getNewestActiveStoresInCategory('art', 10);
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['status', '==', 'active'], ['mod', '==', null], ['category', '==', 'art']],
      orderBy: [['status', 'asc'], ['mod', 'asc'], ['category', 'asc'], ['$createdAt', 'desc']],
    }));
  });

  it('lists items, reviews and the rating trees through mod == null', async () => {
    const { storeItemService, storeReviewService, itemReviewService, storeStatsService } = await servicesOn('v11');
    await storeItemService.getByStore(storeId, { limit: 5 });
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['storeId', '==', storeId], ['mod', '==', null]],
      orderBy: [['storeId', 'asc'], ['mod', 'asc'], ['$createdAt', 'asc']],
    }));
    await storeItemService.getByStore(storeId, { limit: 5, activeOnly: true });
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['storeId', '==', storeId], ['mod', '==', null], ['status', '==', 'active']],
      orderBy: [['storeId', 'asc'], ['mod', 'asc'], ['status', 'asc'], ['$createdAt', 'asc']],
    }));
    await storeReviewService.getStoreReviews(storeId);
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['storeId', '==', storeId], ['mod', '==', null]],
      orderBy: [['storeId', 'asc'], ['mod', 'asc'], ['$createdAt', 'desc']],
    }));
    await itemReviewService.getItemReviews(itemId);
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['itemId', '==', itemId], ['mod', '==', null]],
      orderBy: [['itemId', 'asc'], ['mod', 'asc'], ['$createdAt', 'desc']],
    }));

    await storeStatsService.getStoreRatingSummary(storeId);
    expect(average.mock.calls[0][0].where).toEqual([['mod', '==', null], ['storeId', '==', storeId]]);
    expect(count.mock.calls[0][0].where).toEqual([['storeId', '==', storeId], ['mod', '==', null], ['rating', 'in', [1, 2, 3, 4, 5]]]);
    await storeStatsService.getItemRatingSummary(itemId, storeId);
    expect(average.mock.calls[1][0].where).toEqual([['mod', '==', null], ['storeId', '==', storeId], ['itemId', '==', itemId]]);
    await storeStatsService.topRatedStores(5);
    expect(ranked).toHaveBeenLastCalledWith(expect.objectContaining({ where: [['mod', '==', null]], groupBy: 'storeId' }));
    await storeStatsService.topStoreCategories(5);
    expect(ranked).toHaveBeenLastCalledWith(expect.objectContaining({ where: [['status', '==', 'active'], ['mod', '==', null]], groupBy: 'category' }));
    await storeStatsService.topItemsInStore(storeId, 5);
    expect(ranked).toHaveBeenLastCalledWith(expect.objectContaining({ where: [['mod', '==', null], ['storeId', '==', storeId]], groupBy: 'itemId' }));
  });

  it('reads exactly what it did before on storefront v10', async () => {
    const { storeService, storeItemService, storeStatsService } = await servicesOn('v10');
    await storeService.getNewestActiveStores(10);
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['status', '==', 'active']], orderBy: [['status', 'asc'], ['$createdAt', 'desc']],
    }));
    await storeItemService.getByStore(storeId, { limit: 5 });
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      where: [['storeId', '==', storeId]], orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']],
    }));
    await storeStatsService.topRatedStores(5);
    expect(ranked).toHaveBeenLastCalledWith(expect.objectContaining({ where: [] }));
    await storeStatsService.getItemRatingSummary(itemId, storeId);
    expect(average.mock.calls[0][0].where).toEqual([['storeId', '==', storeId], ['itemId', '==', itemId]]);
  });
});

describe('the seller\'s own item list on storefront v11', () => {
  const rawItem = (id: string, createdAt: number, marks: Record<string, unknown> = {}) =>
    ({ $id: id, $ownerId: 'owner', $revision: 1, $createdAt: createdAt, storeId, title: id, status: 'active', basePrice: 1, currency: 'DASH', ...marks });
  const lane = (options: { where?: unknown[][] } | undefined) => options?.where?.find(([field]) => field === 'mod')?.[2];

  it('reads the hidden and legal-hold lanes by equality and merges them by creation time with their marks', async () => {
    const { storeItemService } = await servicesOn('v11');
    query.mockImplementation(async (options: { where?: unknown[][] }) => {
      const docs = lane(options) === null ? [rawItem('listed-1', 10), rawItem('listed-2', 40)]
        : lane(options) === 1 ? [rawItem('hidden', 20, hiddenMarks)]
          : lane(options) === 2 ? [rawItem('held', 30, { mod: 2 })] : [];
      return new Map(docs.map((doc) => [doc.$id, doc]));
    });
    const items = await storeItemService.getAllByStore(storeId, { includeHidden: true });
    expect(items.map((item) => item.id)).toEqual(['listed-1', 'hidden', 'held', 'listed-2']);
    expect(items[1]).toMatchObject({ moderation: { mod: 1, modLabel: 6 } });
    expect(items[2]).toMatchObject({ moderation: { mod: 2 } });
    expect(items[0]).not.toHaveProperty('moderation');
    expect(query.mock.calls.map(([options]) => lane(options))).toEqual([null, 1, 2]);
    expect(query.mock.calls[1][0]).toMatchObject({
      where: [['storeId', '==', storeId], ['mod', '==', 1]],
      orderBy: [['storeId', 'asc'], ['mod', 'asc'], ['$createdAt', 'asc']],
    });
  });

  it('reads only the listed lane by default, and before v11 whatever is asked', async () => {
    const { storeItemService } = await servicesOn('v11');
    await storeItemService.getAllByStore(storeId);
    expect(query).toHaveBeenCalledOnce();
    query.mockClear();
    const { storeItemService: v10Items } = await servicesOn('v10');
    await v10Items.getAllByStore(storeId, { includeHidden: true });
    expect(query).toHaveBeenCalledOnce();
  });
});

describe('storefront moderator marks', () => {
  it('returns a store opened by id with its marks, and carries them through an update', async () => {
    const { storeService } = await servicesOn('v11');
    get.mockResolvedValue({ ...rawStore, ...hiddenMarks });
    query.mockResolvedValue(new Map([['store', { ...rawStore, ...hiddenMarks }]]));
    const store = await storeService.getById('store');
    expect(store).toMatchObject({ id: 'store', moderation: { mod: 1, modLabel: 6, moderatedBy: 'mod', moderatedAt: 1700000005000 } });
    await storeService.updateStore('store', 'owner', { name: 'Renamed' });
    const sent = updateDocument.mock.calls[0][4];
    expect(sent).toMatchObject({ name: 'Renamed', mod: 1, modLabel: 6 });
    expect(sent).not.toHaveProperty('moderation');
  });

  it('carries an item\'s marks through an edit, and a listed one has none', async () => {
    const { storeItemService } = await servicesOn('v11');
    const rawItem = { $id: 'item', $ownerId: 'owner', $revision: 4, $createdAt: 1, storeId, title: 'Mug', status: 'active', basePrice: 1, currency: 'DASH' };
    get.mockResolvedValue({ ...rawItem, ...hiddenMarks });
    await storeItemService.updateItem('item', 'owner', storeId, { title: 'Big mug' });
    expect(updateDocument.mock.calls[0][4]).toMatchObject({ title: 'Big mug', mod: 1, modLabel: 6 });
    storeItemService.clearCache();
    get.mockResolvedValue(rawItem);
    await storeItemService.updateItem('item', 'owner', storeId, { title: 'Bigger mug' });
    expect(updateDocument.mock.calls[1][4]).not.toHaveProperty('mod');
  });

  it('drops a hidden store from a ranked directory page, keeps a listed one', async () => {
    const { storeService } = await servicesOn('v11');
    ranked.mockResolvedValue({ entries: [{ groupValue: 'store', value: 5n }, { groupValue: 'gone', value: 4n }], valueScale: 1n });
    query.mockResolvedValue(new Map([
      ['store', rawStore],
      ['gone', { ...rawStore, $id: 'gone', ...hiddenMarks }],
    ]));
    const page = await storeService.getDiscoveryStores('topRated', 20);
    expect(page.stores.map((store) => store.id)).toEqual(['store']);
  });

  it('puts the marks on a review that carries them', async () => {
    const { storeReviewService } = await servicesOn('v11');
    const service = storeReviewService as unknown as { transformDocument(doc: Record<string, unknown>): { moderation?: unknown } };
    expect(service.transformDocument({ $id: 'r', $ownerId: 'o', $createdAt: 1, storeId, rating: 5, ...hiddenMarks }).moderation)
      .toMatchObject({ mod: 1, modLabel: 6 });
    expect(service.transformDocument({ $id: 'r', $ownerId: 'o', $createdAt: 1, storeId, rating: 5 })).not.toHaveProperty('moderation');
  });
});
