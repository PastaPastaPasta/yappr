/**
 * Store Order Service
 *
 * Manages encrypted orders created by buyers.
 * Order payloads are encrypted to the seller using XChaCha20-Poly1305.
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { identifierToBase58, stringToIdentifierBytes, toUint8Array } from './sdk-helpers';
import { privateFeedCryptoService } from './private-feed-crypto-service';
import type {
  StoreOrder,
  StoreOrderDocument,
  OrderPayload,
  CartItem,
  ShippingAddress,
  BuyerContact,
  OrderItem
} from '../types';

class StoreOrderService extends BaseDocumentService<StoreOrder> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE_ORDER, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): StoreOrder {
    const data = (doc.data || doc) as StoreOrderDocument;

    // Convert byte arrays to base58
    const storeId = identifierToBase58(data.storeId) || '';
    const sellerId = identifierToBase58(data.sellerId) || '';

    // Convert encrypted payload and nonce to Uint8Array
    const encryptedPayload = toUint8Array(data.encryptedPayload) || new Uint8Array();
    const nonce = toUint8Array(data.nonce) || new Uint8Array();

    return {
      id: (doc.$id || doc.id) as string,
      buyerId: (doc.$ownerId || doc.ownerId) as string,
      storeId,
      sellerId,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      encryptedPayload,
      nonce
    };
  }

  /**
   * Get orders placed by a buyer
   */
  async getBuyerOrders(buyerId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ orders: StoreOrder[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', buyerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      orders: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Get orders for a seller
   */
  async getSellerOrders(sellerId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ orders: StoreOrder[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['sellerId', '==', sellerId]],
      orderBy: [['sellerId', 'asc'], ['$createdAt', 'asc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      orders: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Get orders for a store
   */
  async getStoreOrders(storeId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ orders: StoreOrder[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['storeId', '==', storeId]],
      orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      orders: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Create an order (buyer creates, encrypted to seller)
   *
   * The encryption should be done by the caller using crypto-helpers
   * following the same pattern as private posts.
   */
  async createOrder(
    buyerId: string,
    data: {
      storeId: string;
      sellerId: string;
      encryptedPayload: Uint8Array;
      nonce: Uint8Array;
    }
  ): Promise<StoreOrder> {
    const documentData: Record<string, unknown> = {
      storeId: stringToIdentifierBytes(data.storeId),
      sellerId: stringToIdentifierBytes(data.sellerId),
      encryptedPayload: Array.from(data.encryptedPayload),
      nonce: Array.from(data.nonce)
    };

    return this.create(buyerId, documentData);
  }

  /**
   * Helper to build order payload from cart items
   */
  buildOrderPayload(
    cartItems: CartItem[],
    shippingAddress: ShippingAddress,
    buyerContact: BuyerContact,
    shippingCost: number,
    paymentUri: string,
    currency: string,
    notes?: string
  ): OrderPayload {
    const orderItems: OrderItem[] = cartItems.map(item => ({
      itemId: item.itemId,
      itemTitle: item.title,
      variantKey: item.variantKey,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      imageUrl: item.imageUrl
    }));

    const subtotal = cartItems.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0
    );

    return {
      items: orderItems,
      shippingAddress,
      buyerContact,
      subtotal,
      shippingCost,
      total: subtotal + shippingCost,
      currency,
      paymentUri,
      notes
    };
  }

  /**
   * Update order with payment txid
   * Note: Orders are immutable, so this creates a new order with the txid.
   * In practice, the buyer would need to include txid in the initial order
   * or use a separate mechanism to communicate payment.
   */
  getPaymentVerificationUrl(txid: string, network: 'mainnet' | 'testnet' = 'testnet'): string {
    const baseUrl = network === 'mainnet'
      ? 'https://insight.dash.org/insight/tx/'
      : 'https://testnet-insight.dashevo.org/insight/tx/';
    return `${baseUrl}${txid}`;
  }

  /**
   * Decrypt order payload for seller
   * @param encryptedPayload - The encrypted order payload from the document
   * @param sellerPrivateKey - Seller's encryption private key (Uint8Array, 32 bytes)
   * @returns Decrypted OrderPayload
   */
  async decryptOrderPayload(
    encryptedPayload: Uint8Array,
    sellerPrivateKey: Uint8Array
  ): Promise<OrderPayload> {
    const aad = new TextEncoder().encode('yappr/order/v1');

    const decryptedBytes = await privateFeedCryptoService.eciesDecrypt(
      sellerPrivateKey,
      encryptedPayload,
      aad
    );

    const decoder = new TextDecoder();
    const payloadJson = decoder.decode(decryptedBytes);
    return JSON.parse(payloadJson) as OrderPayload;
  }
}

export const storeOrderService = new StoreOrderService();
