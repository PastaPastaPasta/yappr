/**
 * Order Delivery Service (storefront v6)
 *
 * Digital goods a seller delivered for an order. Only the order's seller can
 * write one (writer gate) and `buyerId` is bound to the order's owner, so a
 * delivery on chain is always the real seller's. The payload is encrypted
 * under a key both parties derive from the order's own ECDH secret
 * (lib/crypto/digital-delivery.ts).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { chunk, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import { logger } from '@/lib/logger';
import { identifierToBase58, identifierStringToDocumentBytes, normalizeBytes } from './sdk-helpers';
import { bytesEqual } from '../bytes';
import {
  buyerOrderDeliveryKey,
  decryptOrderDelivery,
  encryptOrderDelivery,
  sellerOrderDeliveryKey,
  type OrderKeyMaterial,
} from '../crypto/digital-delivery';
import { decodeDelivery, encodeDelivery } from './digital-delivery-plan';
import type { OrderDelivery, OrderDeliveryDocument, OrderDeliveryPayload, StoreOrder } from '../../types';

/** An encrypted delivery ready to publish. */
export interface SealedDelivery {
  encryptedPayload: Uint8Array;
  nonce: Uint8Array;
}

/** Deliveries are append-only, so pages are walked until one runs short. */
const DELIVERY_PAGE_SIZE = 100;
/** Orders per `in` query: ~5 deliveries each still fit one page. */
const ORDER_BATCH_SIZE = 20;

class OrderDeliveryService extends BaseDocumentService<OrderDelivery> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.ORDER_DELIVERY, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): OrderDelivery {
    const data = (doc.data || doc) as OrderDeliveryDocument;
    return {
      id: (doc.$id || doc.id) as string,
      sellerId: (doc.$ownerId || doc.ownerId) as string,
      orderId: identifierToBase58(data.orderId) || '',
      buyerId: identifierToBase58(data.buyerId) || '',
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      encryptedPayload: normalizeBytes(data.encryptedPayload) || new Uint8Array(),
      nonce: normalizeBytes(data.nonce) || new Uint8Array(),
    };
  }

  /**
   * Every delivery for these orders, oldest first per order. Deliveries are
   * append-only, so each `in` page is walked with a cursor until it runs short.
   */
  async getForOrders(orderIds: string[]): Promise<Map<string, OrderDelivery[]>> {
    const byOrder = new Map<string, OrderDelivery[]>();
    for (const batch of chunk([...new Set(orderIds)], Math.min(MAX_IN_CLAUSE_VALUES, ORDER_BATCH_SIZE))) {
      let startAfter: string | undefined;
      for (;;) {
        const { documents } = await this.query({
          where: [['orderId', 'in', batch]],
          orderBy: [['orderId', 'asc'], ['$createdAt', 'asc']],
          limit: DELIVERY_PAGE_SIZE,
          startAfter,
        });
        for (const delivery of documents) {
          const list = byOrder.get(delivery.orderId) ?? [];
          list.push(delivery);
          byOrder.set(delivery.orderId, list);
        }
        if (documents.length < DELIVERY_PAGE_SIZE) break;
        startAfter = documents[documents.length - 1].id;
      }
    }
    return byOrder;
  }

  /**
   * Every delivery to this buyer (the `buyerDeliveries` index), grouped by
   * order, oldest first. Walked page by page: a buyer's library must not end
   * where their loaded order history does.
   */
  async getForBuyer(buyerId: string): Promise<Map<string, OrderDelivery[]>> {
    const byOrder = new Map<string, OrderDelivery[]>();
    let startAfter: string | undefined;
    for (;;) {
      const { documents } = await this.query({
        where: [['buyerId', '==', buyerId]],
        orderBy: [['$createdAt', 'asc']],
        limit: DELIVERY_PAGE_SIZE,
        startAfter,
      });
      for (const delivery of documents) {
        const list = byOrder.get(delivery.orderId) ?? [];
        list.push(delivery);
        byOrder.set(delivery.orderId, list);
      }
      if (documents.length < DELIVERY_PAGE_SIZE) break;
      startAfter = documents[documents.length - 1].id;
    }
    return byOrder;
  }

  /**
   * Every delivery for these orders, each decrypted by `decrypt` (the buyer's
   * or the seller's view). A delivery that does not decrypt is kept without a
   * payload, so the reader can say it is there but unreadable on this device.
   */
  async loadDecrypted(
    orders: readonly StoreOrder[],
    decrypt: (delivery: OrderDelivery, order: StoreOrder) => OrderDeliveryPayload
  ): Promise<Map<string, OrderDelivery[]>> {
    if (orders.length === 0) return new Map();
    const ordersById = new Map(orders.map((order) => [order.id, order]));
    const deliveries = await this.getForOrders([...ordersById.keys()]);
    for (const [orderId, list] of deliveries) {
      const order = ordersById.get(orderId);
      if (!order) continue;
      deliveries.set(orderId, list.map((delivery) => {
        try {
          return { ...delivery, payload: decrypt(delivery, order) };
        } catch (error) {
          logger.warn(`Could not decrypt delivery ${delivery.id}:`, error);
          return delivery;
        }
      }));
    }
    return deliveries;
  }

  /**
   * Encrypt a delivery for `order`. Its random nonce identifies this attempt
   * on chain (see `findSealed`), so seal once and publish that.
   */
  seal(order: OrderKeyMaterial, payload: OrderDeliveryPayload, sellerPrivateKey: Uint8Array): SealedDelivery {
    const key = sellerOrderDeliveryKey(order, sellerPrivateKey);
    return encryptOrderDelivery(encodeDelivery(payload), key, order.id);
  }

  /**
   * Publish a sealed delivery. Only the order's seller can sign it.
   * `confirmed` is false when the broadcast went out but its outcome could not
   * be proved (a timed-out wait): the delivery may or may not land.
   */
  async publish(
    sellerId: string,
    order: Pick<StoreOrder, 'id' | 'buyerId'>,
    sealed: SealedDelivery,
    payload: OrderDeliveryPayload
  ): Promise<{ delivery: OrderDelivery; confirmed: boolean }> {
    const created = await this.create(sellerId, {
      orderId: identifierStringToDocumentBytes(order.id),
      // Bound by consensus to the order's $ownerId; indexed for the buyer's library.
      buyerId: identifierStringToDocumentBytes(order.buyerId),
      encryptedPayload: sealed.encryptedPayload,
      nonce: sealed.nonce,
    });
    const confirmed = (created as { __createConfirmed?: boolean }).__createConfirmed !== false;
    return { delivery: { ...created, payload }, confirmed };
  }

  /**
   * This attempt's delivery if it is on chain (matched by its unique nonce),
   * `absent` when the order's deliveries were read and it is not among them,
   * `unknown` when they could not be read. Absent is not proof it never will
   * land: a broadcast can still be pending.
   */
  async findSealed(orderId: string, sealed: SealedDelivery): Promise<OrderDelivery | 'absent' | 'unknown'> {
    try {
      const found = (await this.getForOrders([orderId])).get(orderId) ?? [];
      return found.find((delivery) => bytesEqual(delivery.nonce, sealed.nonce)) ?? 'absent';
    } catch (error) {
      logger.warn('Could not read the order\'s deliveries:', error);
      return 'unknown';
    }
  }

  decryptAsSeller(delivery: OrderDelivery, order: OrderKeyMaterial, sellerPrivateKey: Uint8Array): OrderDeliveryPayload {
    const key = sellerOrderDeliveryKey(order, sellerPrivateKey);
    return decodeDelivery(decryptOrderDelivery(delivery.encryptedPayload, delivery.nonce, key, order.id));
  }

  decryptAsBuyer(
    delivery: OrderDelivery,
    order: OrderKeyMaterial,
    buyerPrivateKey: Uint8Array,
    sellerPublicKey: Uint8Array
  ): OrderDeliveryPayload {
    const key = buyerOrderDeliveryKey(order, buyerPrivateKey, sellerPublicKey);
    return decodeDelivery(decryptOrderDelivery(delivery.encryptedPayload, delivery.nonce, key, order.id));
  }
}

export const orderDeliveryService = new OrderDeliveryService();
