/**
 * Store Review Service (storefront v2)
 *
 * One review per order. Consensus enforces that the order exists and that the
 * review's storeId/sellerId/buyerId agree with it (refersTo +
 * propertyAgreement); the app marks a review as a verified purchase when its
 * owner is the order's buyer. Costs 3 YAPP. Aggregates (average, count,
 * distribution, rankings) come from `storeStatsService`, never from scans.
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES, storefrontIsV2 } from '../constants';
import { chunk, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import { identifierToBase58, identifierStringToDocumentBytes } from './sdk-helpers';
import { storeStatsService } from './store-stats-service';
import type { StoreReview, StoreReviewDocument } from '../../types';

class StoreReviewService extends BaseDocumentService<StoreReview> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): StoreReview {
    const data = (doc.data || doc) as StoreReviewDocument;
    const reviewerId = (doc.$ownerId || doc.ownerId) as string;
    const buyerId = identifierToBase58(data.buyerId) || undefined;
    return {
      id: (doc.$id || doc.id) as string,
      reviewerId,
      storeId: identifierToBase58(data.storeId) || '',
      orderId: identifierToBase58(data.orderId) || '',
      sellerId: identifierToBase58(data.sellerId) || '',
      buyerId,
      verifiedPurchase: buyerId !== undefined && buyerId === reviewerId,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      rating: data.rating,
      title: data.title,
      content: data.content,
    };
  }

  /** Reviews of a store, newest first. */
  async getStoreReviews(storeId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ reviews: StoreReview[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['storeId', '==', storeId]],
      orderBy: [['storeId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter,
    });
    return { reviews: documents, nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined };
  }

  /** Reviews written by a buyer. */
  async getBuyerReviews(buyerId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ reviews: StoreReview[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', buyerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter,
    });
    return { reviews: documents, nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined };
  }

  /** Reviews on many orders in one `in` query (unique per order, so at most one each). */
  async getOrderReviews(orderIds: string[]): Promise<Map<string, StoreReview>> {
    const result = new Map<string, StoreReview>();
    for (const batch of chunk(orderIds, MAX_IN_CLAUSE_VALUES)) {
      const { documents } = await this.query({
        where: [['orderId', 'in', batch]],
        orderBy: [['orderId', 'asc']],
        limit: batch.length,
      });
      for (const review of documents) result.set(review.orderId, review);
    }
    return result;
  }

  async createReview(
    reviewerId: string,
    data: { storeId: string; orderId: string; sellerId: string; rating: number; title?: string; content?: string }
  ): Promise<StoreReview> {
    if (data.rating < 1 || data.rating > 5) throw new Error('Rating must be between 1 and 5');
    const documentData: Record<string, unknown> = {
      storeId: identifierStringToDocumentBytes(data.storeId),
      orderId: identifierStringToDocumentBytes(data.orderId),
      sellerId: identifierStringToDocumentBytes(data.sellerId),
      // v2: consensus checks this equals the order's buyerId; the app requires
      // it to equal the signer too, which is what makes the review "verified".
      ...(storefrontIsV2() ? { buyerId: identifierStringToDocumentBytes(reviewerId) } : {}),
      rating: data.rating,
    };
    if (data.title) documentData.title = data.title;
    if (data.content) documentData.content = data.content;
    const created = await this.create(reviewerId, documentData);
    storeStatsService.invalidateStore(data.storeId);
    return created;
  }
}

export const storeReviewService = new StoreReviewService();
