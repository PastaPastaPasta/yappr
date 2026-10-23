import { logger } from '@/lib/logger';
import type { LanePin } from '@/lib/contract-topology';
import { STOREFRONT_DOCUMENT_TYPES, YAPPR_STOREFRONT_CONTRACT_ID, lanePinOrderBy, storefrontListingsCarryModLane, storefrontModPin } from '../constants';
import type { StoreNotificationDetail, StoreNotificationType } from '../../types';
import { isOrderStatus } from '../storefront/store-notification-copy';
import { queryDocumentBundle } from './document-query-bundle';
import { getEvoSdk } from './evo-sdk-service';
import { chunk, MAX_IN_CLAUSE_VALUES, paginateFetchAll } from './pagination-utils';
import { identifierToBase58, type QueryDocumentsOptions } from './sdk-helpers';
import { storeItemService } from './store-item-service';
import { storeService } from './store-service';

const { ITEM_REVIEW, ORDER_STATUS_UPDATE, STORE_ITEM, STORE_ORDER, STORE_REVIEW } = STOREFRONT_DOCUMENT_TYPES;

/** A store event before the actor is looked up (notification-service enriches it). */
export interface RawStoreNotification {
  id: string;
  type: StoreNotificationType;
  /** The buyer (orders, reviews) or the seller (status changes). */
  fromUserId: string;
  createdAt: number;
  store: StoreNotificationDetail;
}

const PAGE = 100;
/**
 * Rows per single-key source and fetch: a busier window keeps its newest
 * rows. An `in` read (item reviews up to storefront v10) has no cap: it walks
 * item by item, so a cut would drop the last items' rows whatever their age,
 * and the watermark would then pass them. (On v11 each item is a single-key
 * source of its own.)
 */
const MAX_PER_SOURCE = 1000;
/** How often to look again for the store of a user who had none. */
const STORE_RECHECK_MS = 5 * 60 * 1000;

type Documents = Record<string, unknown>[];

/** The four storefront sources' documents, as read. */
export interface StoreNotificationDocuments {
  /** storeOrder rows on the seller's store. */
  orders: Documents;
  storeReviews: Documents;
  itemReviews: Documents;
  /** orderStatusUpdate rows on the buyer's orders. */
  statusUpdates: Documents;
}

const idOf = (value: unknown): string | undefined => identifierToBase58(value) || undefined;
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function reviewOf(doc: Record<string, unknown>): StoreNotificationDetail {
  const rating = Number(doc.rating);
  // A store review may have a title as well as text; an item review has text only.
  const text = [textOf(doc.title), textOf(doc.content)].filter(Boolean).join(' — ');
  return {
    storeId: idOf(doc.storeId),
    ...(Number.isInteger(rating) && rating >= 1 && rating <= 5 ? { rating } : {}),
    ...(text ? { text } : {}),
  };
}

function eventOf(type: StoreNotificationType, doc: Record<string, unknown>, store: StoreNotificationDetail): RawStoreNotification[] {
  const createdAt = Number(doc.$createdAt);
  if (typeof doc.$id !== 'string' || typeof doc.$ownerId !== 'string' || !Number.isFinite(createdAt)) return [];
  return [{ id: `${type}-${doc.$id}`, type, fromUserId: doc.$ownerId, createdAt, store }];
}

/**
 * The notifications these documents stand for. Only public fields reach
 * them: an order's items, address and payment are encrypted, so a new order
 * is announced without any of it. A status update can only be written by
 * the order's seller (the contract's writer gate), so every one is trusted.
 */
export function deriveStoreNotifications(docs: StoreNotificationDocuments, itemTitles: ReadonlyMap<string, string>): RawStoreNotification[] {
  return [
    ...docs.orders.flatMap(doc => eventOf('storeOrder', doc, { storeId: idOf(doc.storeId) })),
    ...docs.storeReviews.flatMap(doc => eventOf('storeReview', doc, reviewOf(doc))),
    ...docs.itemReviews.flatMap(doc => {
      const itemId = idOf(doc.itemId);
      const itemTitle = itemId ? textOf(itemTitles.get(itemId)) : undefined;
      return eventOf('itemReview', doc, { ...reviewOf(doc), ...(itemId ? { itemId } : {}), ...(itemTitle ? { itemTitle } : {}) });
    }),
    ...docs.statusUpdates.flatMap(doc => {
      if (!isOrderStatus(doc.status)) return [];
      const message = textOf(doc.message);
      return eventOf('orderStatus', doc, { status: doc.status, ...(message ? { text: message } : {}) });
    }),
  ];
}

/**
 * A `[key, $createdAt]` source's rows after `after`, newest first (as every
 * notification source walks). An `in` key is ordered descending too: a
 * composite refuses a sibling whose `in` walks against the page's direction.
 * `lane` is the moderator lane a laned listing pins between its key and
 * `$createdAt` (storefront v11's `[storeId|itemId, mod, $createdAt]`); it is
 * an equality, so its order direction does not change the walk.
 */
function sinceQuery(documentTypeName: string, field: string, operator: '==' | 'in', value: string | string[], after: number, lane: readonly LanePin[] = []): QueryDocumentsOptions {
  return {
    dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
    documentTypeName,
    where: [[field, operator, value], ...lane, ['$createdAt', '>', after]],
    orderBy: [[field, operator === 'in' ? 'desc' : 'asc'], ...lanePinOrderBy(lane), ['$createdAt', 'desc']],
    limit: PAGE,
  };
}

/**
 * The laned sources (store items, store reviews, item reviews) read the
 * listed lane, `mod == null` on storefront v11 (nothing before): a seller is
 * told of the reviews their store page shows, and a review a moderator hid
 * (or put on legal hold) does not notify, as it does not show there. An
 * archival build, or a seated moderator's view, fans the same read out to
 * every lane at the SDK (lib/services/sdk-lane-fanout.ts), as it does the
 * store page's. Orders and status updates carry no lane.
 */
const listedSinceQuery = (documentTypeName: string, field: string, value: string, after: number) =>
  sinceQuery(documentTypeName, field, '==', value, after, storefrontModPin());

/**
 * The reviews of these items since `after`. Up to v10 one `in` read per 100
 * items walks `itemReviews [itemId, $createdAt]`. v11's `[itemId, mod,
 * $createdAt]` puts the lane after the item, and Drive serves an `in` only
 * after the index's equalities (docs/SOCIAL_V18.md "Reading the lanes": read
 * one lane at a time elsewhere), so each item is read on its own, in the
 * listed lane; the bundle still sends them a composite at a time.
 */
function itemReviewQueries(itemIds: string[], after: number): QueryDocumentsOptions[] {
  if (storefrontListingsCarryModLane()) return itemIds.map(id => listedSinceQuery(ITEM_REVIEW, 'itemId', id, after));
  return chunk(itemIds, MAX_IN_CLAUSE_VALUES).map(batch => sinceQuery(ITEM_REVIEW, 'itemId', 'in', batch, after));
}

/** A store's items: their titles, and the newest one's creation time (chain time). */
interface StoreItems {
  titles: Map<string, string>;
  newestAt: number;
}

/**
 * Storefront notifications (storefront v6 and later; notification-service
 * reads none before):
 * - for a seller, new orders on their store (`storeOrders [storeId,
 *   $createdAt]`), reviews of it (`storeReviews [storeId, $createdAt]`) and
 *   of its items (`itemReviews [itemId, $createdAt]`, an `in` over the
 *   store's items, kept current by `storeAndTime [storeId, $createdAt]`);
 *   on storefront v11 the last three are `[key, mod, $createdAt]` and read
 *   the listed lane ({@link listedSinceQuery}), item reviews one item a read
 *   ({@link itemReviewQueries});
 * - for a buyer, status changes on their orders (`buyerFeed
 *   [orderId.$ownerId, $createdAt]`).
 * One bundle a poll (the buyer feed, and a seller's sources); a full page
 * reads on to the end of the window. Who owns which store is looked up
 * apart, every few minutes (the store's single-key `owner` index cannot
 * ride a composite): a store that is new since the last look (just opened,
 * or a replacement for one a moderator removed) is read from its creation,
 * so none of its events is skipped.
 */
class StoreNotificationService {
  /** Each user's store as last looked up (null: none); one store per owner at a time. */
  private storeOf = new Map<string, string | null>();
  /** When each user's store was last looked up. */
  private lookedUpAt = new Map<string, number>();
  private itemsOf = new Map<string, StoreItems>();
  /**
   * A store new since an earlier look: read from its creation (the polls
   * before did not read it) until a poll reads it without a failure.
   */
  private backfillFrom = new Map<string, number>();

  /**
   * The user's store events since the watermark. A read that failed is
   * reported to `onFailure` and answers none; the rest still notify.
   */
  async getNotifications(userId: string, sinceTimestamp: number, onFailure: (error: unknown) => void): Promise<RawStoreNotification[]> {
    const lookedUpAt = this.lookedUpAt.get(userId);
    if (lookedUpAt === undefined || Date.now() - lookedUpAt >= STORE_RECHECK_MS) await this.lookUpStore(userId, onFailure);

    const buyerFeed = sinceQuery(ORDER_STATUS_UPDATE, 'orderId.$ownerId', '==', userId, sinceTimestamp);
    const storeId = this.storeOf.get(userId);
    if (storeId) return this.sellerNotifications(storeId, sinceTimestamp, buyerFeed, onFailure);
    const { docs: [statusUpdates] } = await this.readAll([buyerFeed], onFailure);
    return deriveStoreNotifications({ orders: [], storeReviews: [], itemReviews: [], statusUpdates }, new Map());
  }

  /** Looks the user's store up; a failed read is reported and keeps what was known. */
  private async lookUpStore(userId: string, onFailure: (error: unknown) => void): Promise<void> {
    try {
      const store = await storeService.getByOwner(userId);
      const lookedBefore = this.lookedUpAt.has(userId);
      const previous = this.storeOf.get(userId);
      this.storeOf.set(userId, store?.id ?? null);
      this.lookedUpAt.set(userId, Date.now());
      if (store && lookedBefore && store.id !== previous) this.backfillFrom.set(store.id, store.createdAt.getTime() - 1);
    } catch (error) {
      logger.error('Store notifications: reading your store failed:', error);
      onFailure(error);
    }
  }

  /**
   * The seller's events since the watermark (or since a store found late
   * opened, {@link backfillFrom}), plus the buyer feed when given.
   */
  private async sellerNotifications(storeId: string, sinceTimestamp: number, buyerFeed: QueryDocumentsOptions | null, onFailure: (error: unknown) => void): Promise<RawStoreNotification[]> {
    let failed = false;
    const report = (error: unknown) => {
      failed = true;
      onFailure(error);
    };
    const itemsFailed = (error: unknown) => {
      logger.error('Store notifications: reading your items failed:', error);
      report(error);
      return null;
    };
    const after = Math.min(sinceTimestamp, this.backfillFrom.get(storeId) ?? sinceTimestamp);
    const items = await this.storeItems(storeId).catch(itemsFailed);
    const queries = [
      ...(buyerFeed ? [buyerFeed] : []),
      sinceQuery(STORE_ORDER, 'storeId', '==', storeId, after),
      listedSinceQuery(STORE_REVIEW, 'storeId', storeId, after),
      ...(items ? [
        listedSinceQuery(STORE_ITEM, 'storeId', storeId, items.newestAt),
        ...itemReviewQueries([...items.titles.keys()], after),
      ] : []),
    ];
    const { docs, incomplete } = await this.readAll(queries, report);
    const statusUpdates = buyerFeed ? docs.shift() ?? [] : [];
    const [orders, storeReviews, newItems = [], ...itemReviewPages] = docs;
    const itemReviews = itemReviewPages.flat();
    // Items listed since the last read. The contract lets a buyer review any
    // item of a store they ordered from, so they may already have reviews:
    // none older than the item, so reading them from the watermark misses none.
    // A read of them that stopped short would move the boundary past the
    // ones it missed: read the whole list again instead.
    const newItemsIndex = (buyerFeed ? 1 : 0) + 2;
    let added: string[] = [];
    if (items && incomplete.has(newItemsIndex)) {
      const fresh = await this.storeItems(storeId, true).catch(itemsFailed);
      if (fresh) added = [...fresh.titles.keys()].filter(id => !items.titles.has(id));
    } else if (items) {
      added = this.addItems(items, newItems);
    }
    if (added.length > 0) itemReviews.push(...(await this.readAll(itemReviewQueries(added, after), report)).docs.flat());

    if (!failed) this.backfillFrom.delete(storeId);
    return deriveStoreNotifications({ orders, storeReviews, itemReviews, statusUpdates }, this.itemsOf.get(storeId)?.titles ?? new Map());
  }

  /** Every item of the store, read once a session (or on `refresh`); `storeAndTime` reads keep it current from there. */
  private async storeItems(storeId: string, refresh = false): Promise<StoreItems> {
    const cached = this.itemsOf.get(storeId);
    if (cached && !refresh) return cached;
    const all = await storeItemService.getAllByStore(storeId);
    const items = {
      titles: new Map(all.map(item => [item.id, item.title])),
      newestAt: Math.max(0, ...all.map(item => item.createdAt.getTime())),
    };
    this.itemsOf.set(storeId, items);
    return items;
  }

  /** Folds newly listed items into `items`; returns the ids it did not hold. */
  private addItems(items: StoreItems, docs: Documents): string[] {
    const added: string[] = [];
    for (const doc of docs) {
      if (typeof doc.$id !== 'string') continue;
      if (!items.titles.has(doc.$id)) added.push(doc.$id);
      items.titles.set(doc.$id, typeof doc.title === 'string' ? doc.title : '');
      items.newestAt = Math.max(items.newestAt, Number(doc.$createdAt) || 0);
    }
    return added;
  }

  /**
   * Every query's rows in one bundle; a member whose page came back full
   * reads on from its last row, so a busy window is not cut at one page.
   * A failed member answers none and is reported. `incomplete` holds the
   * members whose read stopped short (a failed continuation, or the cap).
   */
  private async readAll(queries: QueryDocumentsOptions[], onFailure: (error: unknown) => void): Promise<{ docs: Documents[]; incomplete: Set<number> }> {
    const firstPages = await queryDocumentBundle(queries, true, onFailure);
    const incomplete = new Set<number>();
    const docs = await Promise.all(queries.map(async (query, index) => {
      const first = firstPages[index] ?? [];
      const last = first[first.length - 1]?.$id;
      if (first.length < PAGE || typeof last !== 'string') return first;
      try {
        const sdk = await getEvoSdk();
        const inClause = query.where?.some(([, operator]) => operator === 'in') ?? false;
        const { documents, reachedLimit } = await paginateFetchAll(sdk, (startAfter) => ({ ...query, startAfter: startAfter ?? last }),
          doc => doc, { maxResults: inClause ? Infinity : MAX_PER_SOURCE - first.length, inClause });
        if (reachedLimit) incomplete.add(index);
        return [...first, ...documents];
      } catch (error) {
        logger.error('Store notifications: reading on past the first page failed:', error);
        onFailure(error);
        incomplete.add(index);
        return first;
      }
    }));
    return { docs, incomplete };
  }
}

export const storeNotificationService = new StoreNotificationService();
