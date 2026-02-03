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
    shippingAddress: ShippingAddress | undefined,
    buyerContact: BuyerContact,
    shippingCost: number,
    paymentUri: string,
    currency: string,
    notes?: string,
    refundAddress?: string
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
      ...(shippingAddress ? { shippingAddress } : {}),
      buyerContact,
      subtotal,
      shippingCost,
      total: subtotal + shippingCost,
      currency,
      paymentUri,
      notes,
      refundAddress
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
      : 'https://insight.testnet.networks.dash.org/insight/tx/';
    return `${baseUrl}${txid}`;
  }

  /**
   * Encrypt order payload using deterministic ephemeral key.
   * This allows both buyer (who can re-derive the ephemeral key) and
   * seller (standard ECIES decryption) to decrypt.
   *
   * @param payload - The order payload to encrypt
   * @param buyerPrivateKey - Buyer's encryption private key (32 bytes)
   * @param sellerPublicKey - Seller's encryption public key (33 bytes)
   * @param nonce - Random nonce for this order (24 bytes)
   * @param storeId - Store identifier
   * @returns Encrypted payload (ephemeralPubKey || ciphertext)
   */
  async encryptOrderPayload(
    payload: OrderPayload,
    buyerPrivateKey: Uint8Array,
    sellerPublicKey: Uint8Array,
    nonce: Uint8Array,
    storeId: string
  ): Promise<Uint8Array> {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const aad = new TextEncoder().encode('yappr/order/v1');

    // Derive deterministic ephemeral key from buyer's key + nonce + storeId
    const ephemeralPrivKey = privateFeedCryptoService.deriveOrderEphemeralKey(
      buyerPrivateKey,
      nonce,
      storeId
    );

    // Encrypt with the derived ephemeral key
    return privateFeedCryptoService.eciesEncryptWithEphemeralKey(
      ephemeralPrivKey,
      sellerPublicKey,
      payloadBytes,
      aad
    );
  }

  /**
   * Decrypt order payload.
   * Supports both seller (standard ECIES) and buyer (re-derived ephemeral key).
   *
   * @param encryptedPayload - The encrypted order payload from the document
   * @param nonce - The nonce stored with the order (24 bytes)
   * @param storeId - Store identifier
   * @param myPrivateKey - Decryptor's encryption private key (32 bytes)
   * @param sellerPublicKey - Seller's public key (only needed for buyer decryption)
   * @param isBuyer - True if caller is the buyer, false if seller
   * @returns Decrypted OrderPayload
   */
  async decryptOrderPayload(
    encryptedPayload: Uint8Array,
    nonce: Uint8Array,
    storeId: string,
    myPrivateKey: Uint8Array,
    sellerPublicKey: Uint8Array | null,
    isBuyer: boolean
  ): Promise<OrderPayload> {
    const aad = new TextEncoder().encode('yappr/order/v1');
    const decoder = new TextDecoder();

    // Try decryption based on caller role
    if (isBuyer && sellerPublicKey) {
      // Buyer: Re-derive the deterministic ephemeral key
      try {
        const ephemeralPrivKey = privateFeedCryptoService.deriveOrderEphemeralKey(
          myPrivateKey,
          nonce,
          storeId
        );

        const decryptedBytes = await privateFeedCryptoService.eciesDecryptWithEphemeralKey(
          ephemeralPrivKey,
          sellerPublicKey,
          encryptedPayload,
          aad
        );

        return JSON.parse(decoder.decode(decryptedBytes)) as OrderPayload;
      } catch (e) {
        // Old order with random ephemeral key - buyer can't decrypt
        // Fall through to plain JSON fallback
        console.warn('Buyer decryption failed (may be old order):', e);
      }
    } else {
      // Seller: Standard ECIES decryption
      try {
        const decryptedBytes = await privateFeedCryptoService.eciesDecrypt(
          myPrivateKey,
          encryptedPayload,
          aad
        );

        return JSON.parse(decoder.decode(decryptedBytes)) as OrderPayload;
      } catch (e) {
        console.warn('ECIES decryption failed:', e);
      }
    }

    // Fallback: Try plain JSON (very old unencrypted orders)
    try {
      const payloadJson = decoder.decode(encryptedPayload);
      return JSON.parse(payloadJson) as OrderPayload;
    } catch (e) {
      throw new Error('Failed to decrypt order payload');
    }
  }
}

export const storeOrderService = new StoreOrderService();
