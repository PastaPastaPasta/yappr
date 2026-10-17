import { logger } from '@/lib/logger';
import { STOREFRONT_DOCUMENT_TYPES, YAPPR_STOREFRONT_CONTRACT_ID } from '../constants';
import type { OrderStatus, StoreNotificationDetail, StoreNotificationType } from '../../types';
import { queryDocumentBundle } from './document-query-bundle';
import { getEvoSdk } from './evo-sdk-service';
import { chunk, MAX_IN_CLAUSE_VALUES, paginateFetchAll } from './pagination-utils';
import { identifierToBase58, type QueryDocumentsOptions } from './sdk-helpers';
import { storeItemService } from './store-item-service';
import { storeService } from './store-service';

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
/** Per source and fetch: a store busier than this in one window keeps its newest events. */
const MAX_PER_SOURCE = 1000;
/** Re-read a store's item titles at least this often. */
const ITEMS_TTL_MS = 30 * 60 * 1000;
/** Chain times against this device's clock: an order this close to an item read may name an item it missed. */
const CLOCK_MARGIN_MS = 5 * 60 * 1000;

const ORDER_STATUSES: ReadonlySet<string> = new Set<OrderStatus>([
  'pending', 'payment_received', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'disputed',
]);

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
  const reviewOf = (doc: Record<string, unknown>): StoreNotificationDetail => {
    const rating = Number(doc.rating);
    // A store review may have a title as well as text; an item review has text only.
    const text = [textOf(doc.title), textOf(doc.content)].filter(Boolean).join(' — ');
    return {
      storeId: idOf(doc.storeId),
      ...(Number.isInteger(rating) && rating >= 1 && rating <= 5 ? { rating } : {}),
      ...(text ? { text } : {}),
    };
  };
  return [
    ...docs.orders.flatMap(doc => eventOf('storeOrder', doc, { storeId: idOf(doc.storeId) })),
    ...docs.storeReviews.flatMap(doc => eventOf('storeReview', doc, reviewOf(doc))),
    ...docs.itemReviews.flatMap(doc => {
      const itemId = idOf(doc.itemId);
      const itemTitle = itemId ? textOf(itemTitles.get(itemId)) : undefined;
      return eventOf('itemReview', doc, { ...reviewOf(doc), ...(itemId ? { itemId } : {}), ...(itemTitle ? { itemTitle } : {}) });
    }),
    ...docs.statusUpdates.flatMap(doc => {
      if (typeof doc.status !== 'string' || !ORDER_STATUSES.has(doc.status)) return [];
      const message = textOf(doc.message);
      return eventOf('orderStatus', doc, { status: doc.status as OrderStatus, ...(message ? { text: message } : {}) });
    }),
  ];
}

/** A `[key, $createdAt]` source's rows since the watermark, newest first (as every notification source walks). */
function sinceQuery(documentTypeName: string, field: string, operator: '==' | 'in', value: string | string[], sinceTimestamp: number): QueryDocumentsOptions {
  return {
    dataContractId: YAPPR_STOREFRONT_CONTRACT_ID,
    documentTypeName,
    where: [[field, operator, value], ['$createdAt', '>', sinceTimestamp]],
    orderBy: [[field, 'asc'], ['$createdAt', 'desc']],
    limit: PAGE,
  };
}

interface ItemTitles {
  titles: Map<string, string>;
  readAt: number;
}

/**
 * Storefront notifications (storefront v6 and later; notification-service
 * reads none before):
 * - for a seller, new orders on their store (`storeOrders [storeId,
 *   $createdAt]`), reviews of it (`storeReviews [storeId, $createdAt]`) and
 *   of its items (`itemReviews [itemId, $createdAt]`, an `in` over the
 *   store's items);
 * - for a buyer, status changes on their orders (`buyerFeed
 *   [orderId.$ownerId, $createdAt]`).
 * One bundle a poll once the seller's store is known (until then, one store
 * lookup beside it); a full page reads on to the end of the window.
 */
class StoreNotificationService {
  /** A seller's store. A store is permanent and one per owner, so a found one is kept for the session. */
  private storeOf = new Map<string, string>();
  private itemsOf = new Map<string, ItemTitles>();

  /**
   * The user's store events since the watermark. A source whose read failed
   * is reported to `onFailure` and answers none; the rest still notify.
   */
  async getNotifications(userId: string, sinceTimestamp: number, onFailure: (error: unknown) => void): Promise<RawStoreNotification[]> {
    const storeId = await this.storeFor(userId).catch((error: unknown) => {
      logger.error('Store notifications: reading your store failed:', error);
      onFailure(error);
      return null;
    });
    let items = storeId ? await this.itemTitles(storeId, false).catch((error: unknown) => {
      logger.error('Store notifications: reading your items failed:', error);
      onFailure(error);
      return null;
    }) : null;

    const T = STOREFRONT_DOCUMENT_TYPES;
    const itemQueries = (ids: string[]) => chunk(ids, MAX_IN_CLAUSE_VALUES)
      .map(batch => sinceQuery(T.ITEM_REVIEW, 'itemId', 'in', batch, sinceTimestamp));
    const queries = [
      sinceQuery(T.ORDER_STATUS_UPDATE, 'orderId.$ownerId', '==', userId, sinceTimestamp),
      ...(storeId ? [
        sinceQuery(T.STORE_ORDER, 'storeId', '==', storeId, sinceTimestamp),
        sinceQuery(T.STORE_REVIEW, 'storeId', '==', storeId, sinceTimestamp),
        ...(items ? itemQueries([...items.titles.keys()]) : []),
      ] : []),
    ];
    const [statusUpdates, orders = [], storeReviews = [], ...itemReviewPages] = await this.readAll(queries, onFailure);
    const itemReviews = itemReviewPages.flat();

    // An item can only be reviewed from an order, and an order only names an
    // item that existed when it was placed. So an order newer than the item
    // read may name an item it missed: read the items again, and the reviews
    // of any that are new.
    const stale = items;
    if (storeId && stale && orders.some(order => Number(order.$createdAt) > stale.readAt - CLOCK_MARGIN_MS)) {
      items = await this.itemTitles(storeId, true).catch((error: unknown) => {
        logger.error('Store notifications: re-reading your items failed:', error);
        onFailure(error);
        return stale;
      });
      const added = [...items.titles.keys()].filter(id => !stale.titles.has(id));
      if (added.length > 0) itemReviews.push(...(await this.readAll(itemQueries(added), onFailure)).flat());
    }

    return deriveStoreNotifications({ orders, storeReviews, itemReviews, statusUpdates }, items?.titles ?? new Map());
  }

  /** The user's store id, or null when they have none (looked up again next poll). */
  private async storeFor(userId: string): Promise<string | null> {
    const known = this.storeOf.get(userId);
    if (known) return known;
    const store = await storeService.getByOwner(userId);
    if (store) this.storeOf.set(userId, store.id);
    return store?.id ?? null;
  }

  private async itemTitles(storeId: string, refresh: boolean): Promise<ItemTitles> {
    const cached = this.itemsOf.get(storeId);
    if (cached && !refresh && Date.now() - cached.readAt < ITEMS_TTL_MS) return cached;
    const readAt = Date.now();
    const items = await storeItemService.getAllByStore(storeId);
    const fresh = { titles: new Map(items.map(item => [item.id, item.title])), readAt };
    this.itemsOf.set(storeId, fresh);
    return fresh;
  }

  /**
   * Every query's rows in one bundle; a member whose page came back full
   * reads on from its last row, so a busy window is not cut at one page.
   * A failed member answers none and is reported.
   */
  private async readAll(queries: QueryDocumentsOptions[], onFailure: (error: unknown) => void): Promise<Documents[]> {
    const firstPages = await queryDocumentBundle(queries, true, onFailure);
    return Promise.all(queries.map(async (query, index) => {
      const first = firstPages[index] ?? [];
      const last = first[first.length - 1]?.$id;
      if (first.length < PAGE || typeof last !== 'string') return first;
      try {
        const sdk = await getEvoSdk();
        const isIn = query.where?.some(([, operator]) => operator === 'in') ?? false;
        const { documents } = await paginateFetchAll(sdk, (startAfter) => ({ ...query, startAfter: startAfter ?? last }),
          doc => doc, { maxResults: MAX_PER_SOURCE - first.length, inClause: isIn });
        return [...first, ...documents];
      } catch (error) {
        logger.error('Store notifications: reading on past the first page failed:', error);
        onFailure(error);
        return first;
      }
    }));
  }
}

export const storeNotificationService = new StoreNotificationService();
