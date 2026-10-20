import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  documents: { average: vi.fn(), count: vi.fn(), ranked: vi.fn(), composite: vi.fn() },
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }));
import bs58 from 'bs58';
import { storeStatsService } from './store-stats-service';

const storeId = '11111111111111111111111111111111';
// hex of 0x80 + rating: the grouped-count key encoding for small integers before beta.5
const ratingKey = (rating: number) => (0x80 + rating).toString(16);
// hex of the plain rating byte: the beta.5 encoding of an unsigned integer index value
const plainRatingKey = (rating: number) => rating.toString(16).padStart(2, '0');

beforeEach(() => {
  vi.resetAllMocks();
  storeStatsService.invalidateStore(storeId);
});

describe('store rating summary', () => {
  it('divides the proved count and sum and decodes the distribution keys', async () => {
    sdk.documents.average.mockResolvedValue(new Map([['', { count: 3n, sum: 11n }]]));
    sdk.documents.count.mockResolvedValue(new Map([[ratingKey(4), 2n], [ratingKey(3), 1n]]));
    const summary = await storeStatsService.getStoreRatingSummary(storeId);
    expect(summary).toEqual({
      averageRating: 3.7,
      reviewCount: 3,
      ratingDistribution: { 1: 0, 2: 0, 3: 1, 4: 2, 5: 0 },
    });
    expect(sdk.documents.average).toHaveBeenCalledWith(
      expect.objectContaining({ documentTypeName: 'storeReview', where: [['storeId', '==', storeId]] }),
      'rating'
    );
  });

  it('decodes the plain big-endian rating keys of a beta.5 network too', async () => {
    sdk.documents.average.mockResolvedValue(new Map([['', { count: 3n, sum: 11n }]]));
    sdk.documents.count.mockResolvedValue(new Map([[plainRatingKey(4), 2n], [plainRatingKey(3), 1n], [plainRatingKey(5), 0n]]));
    const summary = await storeStatsService.getStoreRatingSummary(storeId);
    expect(summary.ratingDistribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 2, 5: 0 });
  });

  it('keeps the average when only the distribution read fails', async () => {
    sdk.documents.average.mockResolvedValue(new Map([['', { count: 2n, sum: 9n }]]));
    sdk.documents.count.mockRejectedValue(new Error('offline'));
    const summary = await storeStatsService.getStoreRatingSummary(storeId);
    expect(summary.averageRating).toBe(4.5);
    expect(summary.ratingDistribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it('reports zero for a store with no reviews (unmaterialized tree)', async () => {
    sdk.documents.average.mockResolvedValue(new Map());
    sdk.documents.count.mockResolvedValue(new Map());
    const summary = await storeStatsService.getStoreRatingSummary(storeId);
    expect(summary.averageRating).toBe(0);
    expect(summary.reviewCount).toBe(0);
  });

  it('caches the summary until invalidated', async () => {
    sdk.documents.average.mockResolvedValue(new Map([['', { count: 1n, sum: 5n }]]));
    sdk.documents.count.mockResolvedValue(new Map());
    await storeStatsService.getStoreRatingSummary(storeId);
    await storeStatsService.getStoreRatingSummary(storeId);
    expect(sdk.documents.average).toHaveBeenCalledTimes(1);
    storeStatsService.invalidateStore(storeId);
    await storeStatsService.getStoreRatingSummary(storeId);
    expect(sdk.documents.average).toHaveBeenCalledTimes(2);
  });
});

describe('store card rating summaries', () => {
  const storeA = 'hZpapzaANrBFW8iDudzdwbB38ai4SW4JbHHtQH74J4g';
  const storeB = '4H6G4KaN3aT4ohxcszjCLNo2wAFJ1DmnDeGo9Ceoa89o';
  const hexOf = (id: string) => Buffer.from(bs58.decode(id)).toString('hex');

  it('reads every store with one average query grouped by store', async () => {
    sdk.documents.average.mockResolvedValue(new Map([[hexOf(storeA), { count: 4n, sum: 19n }]]));
    const summaries = await storeStatsService.getStoreRatingSummaries([storeA, storeB]);
    expect(sdk.documents.average).toHaveBeenCalledTimes(1);
    expect(sdk.documents.average.mock.calls[0][0]).toMatchObject({ where: [['storeId', 'in', [storeA, storeB]]], groupBy: ['storeId'] });
    expect(summaries.get(storeA)).toMatchObject({ reviewCount: 4, averageRating: 4.8 });
    // No group: proved to have no reviews.
    expect(summaries.get(storeB)).toMatchObject({ reviewCount: 0, averageRating: 0 });
  });

  it('falls back to one query per store when the grouped read fails', async () => {
    sdk.documents.average
      .mockRejectedValueOnce(new Error('grouped average unsupported'))
      .mockResolvedValueOnce(new Map([['', { count: 2n, sum: 9n }]]))
      .mockResolvedValueOnce(new Map());
    const summaries = await storeStatsService.getStoreRatingSummaries([storeA, storeB]);
    expect(sdk.documents.average).toHaveBeenCalledTimes(3);
    expect(summaries.get(storeA)?.reviewCount).toBe(2);
    expect(summaries.get(storeB)?.reviewCount).toBe(0);
  });

  it('does not read undecodable group keys as "no reviews"', async () => {
    sdk.documents.average
      .mockResolvedValueOnce(new Map([['not-a-store', { count: 4n, sum: 19n }]]))
      .mockResolvedValue(new Map([['', { count: 1n, sum: 5n }]]));
    const summaries = await storeStatsService.getStoreRatingSummaries([storeA]);
    expect(sdk.documents.average).toHaveBeenCalledTimes(2);
    expect(summaries.get(storeA)?.reviewCount).toBe(1);
  });
});

describe('rankings', () => {
  it('divides average-axis values by the result scale and drops zero groups', async () => {
    sdk.documents.ranked.mockResolvedValue({
      valueScale: 1000n,
      entries: [
        { groupValue: 'storeA', value: 4500n },
        { groupValue: 'storeB', value: 0n },
      ],
    });
    expect(await storeStatsService.topRatedStores(10)).toEqual([{ id: 'storeA', value: 4.5 }]);
    expect(sdk.documents.ranked).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'storeId', aggregate: { type: 'avg', property: 'rating' }, direction: 'desc', limit: 10 })
    );
  });

  it('returns an empty page instead of throwing when the ranked read fails', async () => {
    sdk.documents.ranked.mockRejectedValue(new Error('offline'));
    expect(await storeStatsService.mostOrderedStores()).toEqual([]);
  });

  it.each(['topRatedStores', 'mostOrderedStores', 'topStoreCategories', 'topItemsInStore'] as const)(
    'contains indexed-target failures in %s without caching a false empty page', async (method) => {
      sdk.documents.ranked.mockRejectedValueOnce(new Error('indexed target chain: primary entry 0101 is missing'))
        .mockResolvedValue({ entries: [{ groupValue: 'group', value: 5n }] });
      const read = () => method === 'topItemsInStore' ? storeStatsService.topItemsInStore(storeId) : storeStatsService[method]();
      expect(await read()).toEqual([]);
      expect(await read()).toEqual([{ id: 'group', value: 5 }]);
      expect(sdk.documents.ranked).toHaveBeenCalledTimes(2);
    }
  );
});

describe('buyer orders composite', () => {
  it('returns null so callers fall back when the composite surface is unavailable', async () => {
    sdk.documents.composite.mockRejectedValue(new Error('unsupported'));
    expect(await storeStatsService.loadBuyerOrdersComposite('buyer')).toBeNull();
  });

  it('returns null when the composite comes back with the wrong number of sub-results', async () => {
    sdk.documents.composite.mockResolvedValue({ pageDocuments: [], subResults: [{ kind: 'documents', documents: [] }] });
    expect(await storeStatsService.loadBuyerOrdersComposite('buyer')).toBeNull();
  });

  it('splits sub-results by kind and order', async () => {
    const doc = (fields: Record<string, unknown>) => ({ toObject: () => fields });
    sdk.documents.composite.mockResolvedValue({
      pageDocuments: [doc({ $id: 'order1' })],
      subResults: [
        { kind: 'documents', documents: [doc({ $id: 'store1' })] },
        { kind: 'documents', documents: [] },
        { kind: 'documents', documents: [doc({ $id: 'status1' }), doc({ $id: 'status2' })] },
      ],
    });
    const result = await storeStatsService.loadBuyerOrdersComposite('buyer');
    expect(result?.orders).toHaveLength(1);
    expect(result?.stores).toHaveLength(1);
    expect(result?.reviews).toHaveLength(0);
    expect(result?.statuses).toHaveLength(2);
  });
});

describe('storefront v6 indexes', () => {
  /** The service under `topology` (STOREFRONT_TOPOLOGY is read at load). */
  const load = async (topology: string) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology);
    const { storeStatsService: service } = await import('./store-stats-service');
    vi.unstubAllEnvs();
    return service;
  };
  const itemId = '22222222222222222222222222222222';

  it('reads an item rating with its store pinned on v6 (storeItemRating), by itemId alone before', async () => {
    sdk.documents.average.mockResolvedValue(new Map([['', { count: 2n, sum: 9n }]]));
    expect(await (await load('v6')).getItemRatingSummary(itemId, storeId)).toEqual({ averageRating: 4.5, reviewCount: 2 });
    expect(sdk.documents.average.mock.calls[0][0].where).toEqual([['storeId', '==', storeId], ['itemId', '==', itemId]]);
    await (await load('v5')).getItemRatingSummary(itemId, storeId);
    expect(sdk.documents.average.mock.calls[1][0].where).toEqual([['itemId', '==', itemId]]);
  });

  it('pins the store ahead of the grouped itemId count on v6', async () => {
    sdk.documents.count.mockResolvedValue(new Map());
    await (await load('v6')).getItemReviewCounts([itemId], storeId);
    expect(sdk.documents.count.mock.calls[0][0]).toMatchObject({ where: [['storeId', '==', storeId], ['itemId', 'in', [itemId]]], groupBy: ['itemId'] });
  });

  it("counts a seller's orders on their store on v6, on sellerId before", async () => {
    sdk.documents.count.mockResolvedValue(new Map([['', 7n]]));
    expect(await (await load('v6')).countSellerOrders('seller', storeId)).toBe(7);
    expect(sdk.documents.count.mock.calls[0][0].where).toEqual([['storeId', '==', storeId]]);
    await (await load('v5')).countSellerOrders('seller', storeId);
    expect(sdk.documents.count.mock.calls[1][0].where).toEqual([['sellerId', '==', 'seller']]);
  });

  it('ranks categories by active store count in one ranked read (byCategory)', async () => {
    sdk.documents.ranked.mockResolvedValue({ entries: [{ groupValue: 'books', value: 5n }, { groupValue: 'vintage-clothing', value: 2n }] });
    expect(await (await load('v6')).topStoreCategories(10)).toEqual([{ id: 'books', value: 5 }, { id: 'vintage-clothing', value: 2 }]);
    expect(sdk.documents.ranked).toHaveBeenCalledWith(expect.objectContaining({
      documentTypeName: 'store', groupBy: 'category', aggregate: { type: 'count' }, where: [['status', '==', 'active']], direction: 'desc', limit: 10,
    }));
  });
});
