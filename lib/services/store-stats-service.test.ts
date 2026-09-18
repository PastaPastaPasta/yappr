import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  documents: { average: vi.fn(), count: vi.fn(), ranked: vi.fn(), composite: vi.fn() },
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }));
import { storeStatsService } from './store-stats-service';

const storeId = '11111111111111111111111111111111';
// hex of 0x80 + rating: the grouped-count key encoding for small integers
const ratingKey = (rating: number) => (0x80 + rating).toString(16);

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
