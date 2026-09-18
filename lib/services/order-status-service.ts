/**
 * Order Status Service
 *
 * Manages order status updates created by sellers.
 * Status updates are immutable (append-only history).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES, storefrontIsV2 } from '../constants';
import { chunk, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import { identifierToBase58, identifierStringToDocumentBytes } from './sdk-helpers';
import type {
  OrderStatusUpdate,
  OrderStatusUpdateDocument,
  OrderStatus
} from '../../types';

class OrderStatusService extends BaseDocumentService<OrderStatusUpdate> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.ORDER_STATUS_UPDATE, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): OrderStatusUpdate {
    const data = (doc.data || doc) as OrderStatusUpdateDocument;

    // Convert orderId from byte array to base58
    const orderId = identifierToBase58(data.orderId) || '';

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      orderId,
      sellerId: identifierToBase58(data.sellerId) || undefined,
      buyerId: identifierToBase58(data.buyerId) || undefined,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      status: data.status,
      trackingNumber: data.trackingNumber,
      trackingCarrier: data.trackingCarrier,
      message: data.message
    };
  }

  /**
   * v2 binds `sellerId` to the order by consensus but cannot bind `$ownerId`,
   * so a stranger can post an update carrying the right ids. An update is
   * genuine only when the seller signed it. On v1 there is no attested seller
   * to compare against, so every update is taken as-is (the v1 behaviour).
   */
  isGenuine(update: OrderStatusUpdate): boolean {
    if (update.sellerId === undefined) return !storefrontIsV2();
    return update.ownerId === update.sellerId;
  }

  /** Newest genuine update per order from an unordered list of updates. */
  latestPerOrder(updates: OrderStatusUpdate[]): Map<string, OrderStatusUpdate> {
    const latest = new Map<string, OrderStatusUpdate>();
    for (const update of updates) {
      if (!this.isGenuine(update)) continue;
      const current = latest.get(update.orderId);
      if (
        !current ||
        update.createdAt > current.createdAt ||
        (update.createdAt.getTime() === current.createdAt.getTime() && update.id > current.id)
      ) {
        latest.set(update.orderId, update);
      }
    }
    return latest;
  }

  /**
   * Latest genuine status for many orders. Status history is append-only, so
   * an `in` page is walked with a cursor until it runs short — a single
   * 100-row page would silently drop the orders that sort last.
   */
  async getLatestStatuses(orderIds: string[]): Promise<Map<string, OrderStatusUpdate>> {
    const all: OrderStatusUpdate[] = [];
    // Small batches keep each cursor walk short: ~10 updates per order fit
    // in one page for a batch of ten.
    for (const batch of chunk(orderIds, Math.min(MAX_IN_CLAUSE_VALUES, 10))) {
      let startAfter: string | undefined;
      for (;;) {
        const { documents } = await this.query({
          where: [['orderId', 'in', batch]],
          orderBy: [['orderId', 'asc'], ['$createdAt', 'asc']],
          limit: 100,
          startAfter,
        });
        all.push(...documents);
        if (documents.length < 100) break;
        startAfter = documents[documents.length - 1].id;
      }
    }
    return this.latestPerOrder(all);
  }

  /**
   * Get status history for an order
   */
  async getOrderHistory(orderId: string): Promise<OrderStatusUpdate[]> {
    const { documents } = await this.query({
      where: [['orderId', '==', orderId]],
      orderBy: [['orderId', 'asc'], ['$createdAt', 'asc']],
      limit: 100
    });

    return documents.filter((update) => this.isGenuine(update));
  }

  /**
   * Get the latest status for an order
   */
  async getLatestStatus(orderId: string): Promise<OrderStatusUpdate | null> {
    // Walk newest-first until a genuine update turns up: spoofed updates are
    // cheap and unbounded, so a fixed page could hide the seller's real one.
    let startAfter: string | undefined;
    for (;;) {
      const { documents } = await this.query({
        where: [['orderId', '==', orderId]],
        orderBy: [['orderId', 'asc'], ['$createdAt', 'desc']],
        limit: 20,
        startAfter,
      });
      const genuine = documents.find((update) => this.isGenuine(update));
      if (genuine) return genuine;
      if (documents.length < 20) return null;
      startAfter = documents[documents.length - 1].id;
    }
  }

  /**
   * Get all status updates by a seller
   */
  async getSellerStatusUpdates(sellerId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ updates: OrderStatusUpdate[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', sellerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 50,
      startAfter: options.startAfter
    });

    return {
      updates: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Create a status update (seller only)
   */
  async createStatusUpdate(
    sellerId: string,
    orderId: string,
    data: {
      status: OrderStatus;
      trackingNumber?: string;
      trackingCarrier?: string;
      message?: string;
      /** The order's buyer (v2 propertyAgreement; required). */
      buyerId: string;
    }
  ): Promise<OrderStatusUpdate> {
    const documentData: Record<string, unknown> = {
      orderId: identifierStringToDocumentBytes(orderId),
      ...(storefrontIsV2()
        ? { sellerId: identifierStringToDocumentBytes(sellerId), buyerId: identifierStringToDocumentBytes(data.buyerId) }
        : {}),
      status: data.status
    };

    if (data.trackingNumber) documentData.trackingNumber = data.trackingNumber;
    if (data.trackingCarrier) documentData.trackingCarrier = data.trackingCarrier;
    if (data.message) documentData.message = data.message;

    return this.create(sellerId, documentData);
  }

  /**
   * Get tracking URL for a carrier
   */
  getTrackingUrl(carrier: string, trackingNumber: string): string | null {
    const carrierUrls: Record<string, string> = {
      'usps': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
      'ups': `https://www.ups.com/track?tracknum=${trackingNumber}`,
      'fedex': `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
      'dhl': `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
      'canada_post': `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${trackingNumber}`,
      'royal_mail': `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`,
      'australia_post': `https://auspost.com.au/mypost/track/#/search?tracking=${trackingNumber}`
    };

    const normalizedCarrier = carrier.toLowerCase().replace(/\s+/g, '_');
    return carrierUrls[normalizedCarrier] || null;
  }

  /**
   * Get human-readable status label
   */
  getStatusLabel(status: OrderStatus): string {
    const labels: Record<OrderStatus, string> = {
      'pending': 'Pending',
      'payment_received': 'Payment Received',
      'processing': 'Processing',
      'shipped': 'Shipped',
      'delivered': 'Delivered',
      'cancelled': 'Cancelled',
      'refunded': 'Refunded',
      'disputed': 'Disputed'
    };
    return labels[status] || status;
  }

  /**
   * Get status color for UI
   */
  getStatusColor(status: OrderStatus): string {
    const colors: Record<OrderStatus, string> = {
      'pending': 'text-yellow-600',
      'payment_received': 'text-blue-600',
      'processing': 'text-blue-600',
      'shipped': 'text-purple-600',
      'delivered': 'text-green-600',
      'cancelled': 'text-red-600',
      'refunded': 'text-orange-600',
      'disputed': 'text-red-600'
    };
    return colors[status] || 'text-gray-600';
  }

  /**
   * Check if order is in a terminal state
   */
  isTerminalStatus(status: OrderStatus): boolean {
    return ['delivered', 'cancelled', 'refunded'].includes(status);
  }
}

export const orderStatusService = new OrderStatusService();
