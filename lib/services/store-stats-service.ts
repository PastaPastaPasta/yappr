/**
 * Proved storefront aggregates on the v2 storefront contract.
 *
 * Every read here is one DAPI request against a count/sum/average tree or its
 * ranked secondary (docs/archive/NON_SOCIAL_CONTRACTS_PRE_RELEASE.md): store and item rating summaries,
 * rating distributions, "top rated" / "most reviewed" / "most ordered"
 * rankings, and the composite store page (items + per-item review counts) —
 * replacing the review scans the v1 client did per store.
 */

import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { STOREFRONT_DOCUMENT_TYPES, YAPPR_STOREFRONT_CONTRACT_ID, storefrontIsV6, storefrontModPin } from '../constants';
import type { ItemRatingSummary, StoreRatingSummary } from '../types';
import { getEvoSdk } from './evo-sdk-service';
import { chunk, documentCount, groupedCountEntries, groupedDocumentCount, mapLimit, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import { documentToPlainObject, identifierToHex, type DocumentWhereClause } from './sdk-helpers';

const SUMMARY_TTL_MS = 60 * 1000;
const RANKING_TTL_MS = 60 * 1000;
/**
 * Grouped count keys for small integers are hex of one byte: 0x80 + value on
 * chains before 5.0.0-beta.5, the plain value from it (an unsigned integer
 * index value is keyed as big-endian bytes, platform #5350). Values below 128
 * make the two unambiguous.
 */
const INTEGER_KEY_OFFSET = 0x80;
const integerFromGroupKey = (key: string) => {
  const byte = parseInt(key, 16);
  return byte >= INTEGER_KEY_OFFSET ? byte - INTEGER_KEY_OFFSET : byte;
};
const RATINGS = [1, 2, 3, 4, 5] as const;

export interface RankedEntry {
  /** The group key: a store id or an item id (base58), or a category slug. */
  id: string;
  /** Average rating on the average axis, a document count on the count axis. */
  value: number;
}

type Sdk = Awaited<ReturnType<typeof getEvoSdk>>;
type AverageEntry = { count: bigint; sum: bigint };

function emptyDistribution(): StoreRatingSummary['ratingDistribution'] {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `{count, sum}` for the '' (grand-total) key of an average query, zeros when unmaterialized. */
async function averageOf(sdk: Sdk, documentTypeName: string, where: DocumentWhereClause[]): Promise<{ count: number; sum: number }> {
  const raw = await sdk.documents.average(
    { dataContractId: YAPPR_STOREFRONT_CONTRACT_ID, documentTypeName, where },
    'rating'
  );
  const entry = groupedCountEntries(raw).find(([key]) => key === '')?.[1] as AverageEntry | undefined;
  if (!entry) return { count: 0, sum: 0 };
  return { count: Number(entry.count), sum: Number(entry.sum) };
}

/**
 * `{count, sum}` per store from ONE average query grouped by `storeId`, for at
 * most 100 stores. Keys arrive as the hex of each id's bytes; a store with no
 * group has no reviews. Throws when groups came back but none decoded, rather
 * than reading every store as unreviewed.
 */
async function groupedAverages(sdk: Sdk, storeIds: string[]): Promise<Map<string, { count: number; sum: number }>> {
  const raw = await sdk.documents.average(
    {
      dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
      documentTypeName: STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW,
      where: [...storefrontModPin(), ['storeId', 'in', storeIds]],
      groupBy: ['storeId'],
    },
    'rating'
  );
  const idByHex = new Map<string, string>();
  for (const id of storeIds) {
    const hex = identifierToHex(id);
    if (hex) idByHex.set(hex, id);
  }
  const averages = new Map(storeIds.map((id) => [id, { count: 0, sum: 0 }]));
  const all = groupedCountEntries(raw);
  const entries = all.filter(([key]) => key !== '');
  // Only a grand total with reviews in it: the grouping was not applied, which must not read as "no reviews".
  const total = all.find(([key]) => key === '')?.[1] as AverageEntry | undefined;
  if (entries.length === 0 && total && Number(total.count) > 0) throw new Error('storeStats: grouped average came back ungrouped');
  let matched = 0;
  for (const [key, value] of entries) {
    const id = idByHex.get(key.toLowerCase());
    if (!id) continue;
    const entry = value as AverageEntry;
    averages.set(id, { count: Number(entry.count), sum: Number(entry.sum) });
    matched += 1;
  }
  if (entries.length > 0 && matched === 0) throw new Error('storeStats: no grouped average key matched a store id');
  return averages;
}

/**
 * v6 reads item ratings through `storeItemRating`, whose prefix is the store; earlier cuts index `itemId` alone.
 * v11 keys it `[mod, storeId, itemId]`: the listed lane comes first.
 */
function storePin(storeId: string): DocumentWhereClause[] {
  return storefrontIsV6() ? [...storefrontModPin(), ['storeId', '==', storeId]] : [];
}

/** The store-review rating trees: `storeRating [mod, storeId]` on v11, `[storeId]` before. */
function storeRatingPin(storeId: string): DocumentWhereClause[] {
  return [...storefrontModPin(), ['storeId', '==', storeId]];
}


function summaryFrom({ count, sum }: { count: number; sum: number }): ItemRatingSummary {
  return { reviewCount: count, averageRating: count > 0 ? round1(sum / count) : 0 };
}

class StoreStatsService {
  private readonly storeSummaries = new TtlMap<string, StoreRatingSummary>(SUMMARY_TTL_MS);
  private readonly itemSummaries = new TtlMap<string, ItemRatingSummary>(SUMMARY_TTL_MS);
  private readonly rankings = new TtlMap<string, unknown>(RANKING_TTL_MS);

  /** Drop cached aggregates touching `storeId` (call after writing a review). */
  invalidateStore(storeId: string): void {
    this.storeSummaries.delete(storeId);
    this.rankings.clear();
  }

  invalidateItem(itemId: string): void {
    this.itemSummaries.delete(itemId);
    this.rankings.clear();
  }

  /** Drop every cached aggregate (a moderator restored a review, whose store or item the record does not name). */
  invalidateAll(): void {
    this.storeSummaries.clear();
    this.itemSummaries.clear();
    this.rankings.clear();
  }

  /**
   * A store's proved rating summary: average and count from the `storeRating`
   * average tree, the 1–5 distribution from one grouped count. Two requests;
   * a failed distribution degrades to zeros rather than losing the average.
   */
  async getStoreRatingSummary(storeId: string): Promise<StoreRatingSummary> {
    const cached = this.storeSummaries.get(storeId);
    if (cached) return cached;
    const sdk = await getEvoSdk();
    const [average, distribution] = await Promise.all([
      averageOf(sdk, STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, storeRatingPin(storeId)),
      this.ratingDistribution(sdk, storeId).catch((error) => {
        logger.warn(`storeStats: rating distribution for ${storeId} failed`, error);
        return emptyDistribution();
      }),
    ]);
    const summary: StoreRatingSummary = { ...summaryFrom(average), ratingDistribution: distribution };
    this.storeSummaries.set(storeId, summary);
    return summary;
  }

  /**
   * Rating summaries for many stores at once: one proved average query grouped
   * by store per 100 stores (`storeId in [...]` on the `storeRating` average
   * tree), where a store with no group has no reviews. Should a grouped read
   * fail or answer in keys that do not decode, its stores fall back to one
   * average query each.
   */
  async getStoreRatingSummaries(storeIds: string[]): Promise<Map<string, StoreRatingSummary>> {
    const result = new Map<string, StoreRatingSummary>();
    const missing = Array.from(new Set(storeIds)).filter((id) => {
      const cached = this.storeSummaries.get(id);
      if (cached) result.set(id, cached);
      return !cached;
    });
    if (missing.length === 0) return result;
    const sdk = await getEvoSdk();
    // Discovery cards only show the average and count; the distribution is
    // fetched when a store page opens.
    const cardSummary = (average: { count: number; sum: number }): StoreRatingSummary =>
      ({ ...summaryFrom(average), ratingDistribution: emptyDistribution() });
    await mapLimit(chunk(missing, MAX_IN_CLAUSE_VALUES), 2, async (batch) => {
      try {
        const averages = await groupedAverages(sdk, batch);
        averages.forEach((average, storeId) => result.set(storeId, cardSummary(average)));
      } catch (error) {
        logger.warn('storeStats: grouped store averages failed, reading each store', error);
        await mapLimit(batch, 6, async (storeId) => {
          try {
            result.set(storeId, cardSummary(await averageOf(sdk, STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, storeRatingPin(storeId))));
          } catch (storeError) {
            logger.warn(`storeStats: average for store ${storeId} failed`, storeError);
          }
        });
      }
    });
    return result;
  }

  private async ratingDistribution(sdk: Sdk, storeId: string): Promise<StoreRatingSummary['ratingDistribution']> {
    const distribution = emptyDistribution();
    const raw = await sdk.documents.count({
      dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
      documentTypeName: STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW,
      // v11: `storeRatingDistribution [storeId, mod, rating]`.
      where: [['storeId', '==', storeId], ...storefrontModPin(), ['rating', 'in', [...RATINGS]]],
      groupBy: ['rating'],
    });
    for (const [key, value] of groupedCountEntries(raw)) {
      if (key === '') continue;
      const rating = integerFromGroupKey(key);
      if (rating >= 1 && rating <= 5) distribution[rating as 1 | 2 | 3 | 4 | 5] = Number(value as bigint | number);
    }
    return distribution;
  }

  /**
   * An item's proved average and review count: the `itemRating [itemId]`
   * average tree before v6, `storeItemRating [storeId, itemId]` with the
   * item's store pinned on v6 (which drops the per-item tree).
   */
  async getItemRatingSummary(itemId: string, storeId: string): Promise<ItemRatingSummary> {
    const cached = this.itemSummaries.get(itemId);
    if (cached) return cached;
    const sdk = await getEvoSdk();
    const summary = summaryFrom(await averageOf(sdk, STOREFRONT_DOCUMENT_TYPES.ITEM_REVIEW, [...storePin(storeId), ['itemId', '==', itemId]]));
    this.itemSummaries.set(itemId, summary);
    return summary;
  }

  /**
   * Per-item review counts for one store's page: one grouped count per 100
   * items (with the shared helper's per-id fallback when the grouped shape
   * fails), over `itemRating [itemId]` before v6 and `storeItemRating
   * [storeId, itemId]` with the store pinned on v6. Averages need the sum too,
   * so items with reviews take their average from the ranked
   * `storeItemRating` read the page also makes (see `topItemsInStore`).
   */
  async getItemReviewCounts(itemIds: string[], storeId: string): Promise<Map<string, number>> {
    if (itemIds.length === 0) return new Map();
    const sdk = await getEvoSdk();
    const query = { dataContractId: YAPPR_STOREFRONT_CONTRACT_ID, documentTypeName: STOREFRONT_DOCUMENT_TYPES.ITEM_REVIEW };
    const where = storePin(storeId);
    return groupedDocumentCount(sdk, { ...query, groupField: 'itemId', where }, itemIds, (itemId) =>
      documentCount(sdk, { ...query, where: [...where, ['itemId', '==', itemId]] })
    );
  }

  private async rankedPage(
    key: string,
    query: {
      documentTypeName: string;
      groupBy: string;
      aggregate: { type: 'count' } | { type: 'avg'; property: string };
      where?: [string, '==', unknown][];
      limit: number;
    },
    throwOnError = false
  ): Promise<RankedEntry[]> {
    const cached = this.rankings.get(key) as RankedEntry[] | undefined;
    if (cached) return cached;
    try {
      const sdk = await getEvoSdk();
      const result = await sdk.documents.ranked({
        dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
        direction: 'desc',
        ...query,
      });
      // Averages arrive fixed-point; the result carries its own scale.
      const scale = Number(result.valueScale ?? 1n);
      const entries = result.entries
        .filter((entry) => entry.value > 0n && typeof entry.groupValue === 'string')
        .map((entry) => {
          const value = Number(entry.value) / scale;
          return { id: entry.groupValue as string, value: query.aggregate.type === 'avg' ? round1(value) : value };
        });
      this.rankings.set(key, entries);
      return entries;
    } catch (error) {
      // Directory callers need to distinguish an unavailable ranking from a
      // genuinely empty one so they can show the ordinary store listing.
      if (throwOnError) throw error;
      logger.error(`storeStats: ranked ${query.documentTypeName}.${query.groupBy} failed`, error);
      return [];
    }
  }

  /** Stores ranked by proved average rating (the `storeRating` average axis). */
  topRatedStores(limit = 20, { throwOnError = false } = {}): Promise<RankedEntry[]> {
    return this.rankedPage(`stores:avg:${limit}`, {
      documentTypeName: STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, groupBy: 'storeId', aggregate: { type: 'avg', property: 'rating' },
      where: storefrontModPin(), limit,
    }, throwOnError);
  }

  /** Stores ranked by order count (`storeOrderCount`; v6 ranks the merged `storeOrders` at `storeId`). */
  mostOrderedStores(limit = 20, { throwOnError = false } = {}): Promise<RankedEntry[]> {
    return this.rankedPage(`stores:orders:${limit}`, {
      documentTypeName: STOREFRONT_DOCUMENT_TYPES.STORE_ORDER, groupBy: 'storeId', aggregate: { type: 'count' }, limit,
    }, throwOnError);
  }

  /**
   * The categories with the most active stores, most first: one proved
   * ranked count over v6's `byCategory [status, category, $createdAt]`
   * (rankedCountable at `category`) with `status` pinned active.
   */
  topStoreCategories(limit = 20): Promise<RankedEntry[]> {
    return this.rankedPage(`stores:categories:${limit}`, {
      documentTypeName: STOREFRONT_DOCUMENT_TYPES.STORE, groupBy: 'category', aggregate: { type: 'count' },
      where: [['status', '==', 'active'], ...storefrontModPin()], limit,
    });
  }

  /** A store's items ranked by average rating (`storeItemRating`, store pinned). Carries each item's average. */
  topItemsInStore(storeId: string, limit = 100): Promise<RankedEntry[]> {
    return this.rankedPage(`items:${storeId}:${limit}`, {
      documentTypeName: STOREFRONT_DOCUMENT_TYPES.ITEM_REVIEW, groupBy: 'itemId', aggregate: { type: 'avg', property: 'rating' },
      where: [...storefrontModPin(), ['storeId', '==', storeId]], limit,
    });
  }

  /**
   * A buyer's order page in one proof: the orders plus, bound to each order's
   * id, the store (by-id join), the buyer's review (unique per order) and the
   * status history. Returns plain objects; callers transform them.
   */
  async loadBuyerOrdersComposite(buyerId: string, limit = 50): Promise<{
    orders: Record<string, unknown>[];
    stores: Record<string, unknown>[];
    reviews: Record<string, unknown>[];
    statuses: Record<string, unknown>[];
  } | null> {
    try {
      const sdk = await getEvoSdk();
      const result = await sdk.documents.composite({
        dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
        documentType: STOREFRONT_DOCUMENT_TYPES.STORE_ORDER,
        where: [['$ownerId', '==', buyerId]],
        orderBy: [['$createdAt', 'desc']],
        limit,
        subQueries: [
          { documentType: STOREFRONT_DOCUMENT_TYPES.STORE, bind: { sourceProperty: 'storeId', field: '$id' } },
          { documentType: STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, bind: { sourceProperty: '$id', field: 'orderId' } },
          // Left unordered: every component inherits the page's walk direction.
          { documentType: STOREFRONT_DOCUMENT_TYPES.ORDER_STATUS_UPDATE, bind: { sourceProperty: '$id', field: 'orderId' }, limit: 100 },
        ],
      });
      if (result.subResults.length !== 3 || result.subResults.some((sub) => sub.kind !== 'documents')) {
        throw new Error(`buyer orders composite returned ${result.subResults.length} sub-results`);
      }
      const docs = (index: number) => {
        const sub = result.subResults[index];
        return sub?.kind === 'documents' ? sub.documents.map(documentToPlainObject) : [];
      };
      return {
        orders: result.pageDocuments.map(documentToPlainObject),
        stores: docs(0),
        reviews: docs(1),
        statuses: docs(2),
      };
    } catch (error) {
      logger.warn('storeStats: buyer orders composite failed; falling back to per-order reads', error);
      return null;
    }
  }

  /**
   * O(1) order total for a seller's (one) store: the countable
   * `sellerOrderCount [sellerId]` before v6, the rangeCountable
   * `storeOrders [storeId, $createdAt]` on v6 (which drops the seller index).
   */
  async countSellerOrders(sellerId: string, storeId: string): Promise<number> {
    const sdk = await getEvoSdk();
    return documentCount(sdk, {
      dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
      documentTypeName: STOREFRONT_DOCUMENT_TYPES.STORE_ORDER,
      where: storefrontIsV6() ? [['storeId', '==', storeId]] : [['sellerId', '==', sellerId]],
    });
  }
}

export const storeStatsService = new StoreStatsService();
