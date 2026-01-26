/**
 * Order Status Service
 *
 * Manages order status updates created by sellers.
 * Status updates are immutable (append-only history).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { identifierToBase58, stringToIdentifierBytes } from './sdk-helpers';
import type {
  OrderStatusUpdate,
  OrderStatusUpdateDocument,
  OrderStatus
} from '../types';

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
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      status: data.status,
      trackingNumber: data.trackingNumber,
      trackingCarrier: data.trackingCarrier,
      message: data.message
    };
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

    return documents;
  }

  /**
   * Get the latest status for an order
   */
  async getLatestStatus(orderId: string): Promise<OrderStatusUpdate | null> {
    const { documents } = await this.query({
      where: [['orderId', '==', orderId]],
      orderBy: [['orderId', 'asc'], ['$createdAt', 'desc']],
      limit: 1
    });

    return documents[0] || null;
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
    }
  ): Promise<OrderStatusUpdate> {
    const documentData: Record<string, unknown> = {
      orderId: stringToIdentifierBytes(orderId),
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
