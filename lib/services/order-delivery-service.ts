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
import {
  buyerOrderDeliveryKey,
  decryptOrderDelivery,
  encryptOrderDelivery,
  sellerOrderDeliveryKey,
  type OrderKeyMaterial,
} from '../crypto/digital-delivery';
import { decodeDelivery, encodeDelivery } from './digital-delivery-plan';
import type { OrderDelivery, OrderDeliveryDocument, OrderDeliveryPayload, StoreOrder } from '../../types';

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

  /** Encrypt and publish a delivery for `order`. Only the order's seller can sign it. */
  async deliver(
    sellerId: string,
    order: OrderKeyMaterial & { buyerId: string },
    payload: OrderDeliveryPayload,
    sellerPrivateKey: Uint8Array
  ): Promise<OrderDelivery> {
    const key = sellerOrderDeliveryKey(order, sellerPrivateKey);
    const { encryptedPayload, nonce } = encryptOrderDelivery(encodeDelivery(payload), key, order.id);
    const created = await this.create(sellerId, {
      orderId: identifierStringToDocumentBytes(order.id),
      // Bound by consensus to the order's $ownerId; indexed for the buyer's library.
      buyerId: identifierStringToDocumentBytes(order.buyerId),
      encryptedPayload,
      nonce,
    });
    return { ...created, payload };
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
