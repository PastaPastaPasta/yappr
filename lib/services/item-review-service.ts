/**
 * Item Review Service (storefront v2)
 *
 * One review per (order, item). Consensus enforces that the item belongs to
 * the review's store and that the order's store and buyer agree with the
 * review (refersTo + propertyAgreement); the app marks a review as a verified
 * purchase when its owner is the order's buyer. Costs 1 YAPP.
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { identifierToBase58, identifierStringToDocumentBytes } from './sdk-helpers';
import { storeStatsService } from './store-stats-service';
import type { ItemReview, ItemReviewDocument } from '../../types';

class ItemReviewService extends BaseDocumentService<ItemReview> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.ITEM_REVIEW, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): ItemReview {
    const data = (doc.data || doc) as ItemReviewDocument;
    const reviewerId = (doc.$ownerId || doc.ownerId) as string;
    const buyerId = identifierToBase58(data.buyerId) || '';
    return {
      id: (doc.$id || doc.id) as string,
      reviewerId,
      storeId: identifierToBase58(data.storeId) || '',
      itemId: identifierToBase58(data.itemId) || '',
      orderId: identifierToBase58(data.orderId) || '',
      buyerId,
      verifiedPurchase: buyerId !== '' && buyerId === reviewerId,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      rating: data.rating,
      content: data.content,
    };
  }

  /** Reviews of one item, newest first. */
  async getItemReviews(itemId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ reviews: ItemReview[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['itemId', '==', itemId]],
      orderBy: [['itemId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter,
    });
    return { reviews: documents, nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined };
  }

  async createItemReview(
    reviewerId: string,
    data: { storeId: string; itemId: string; orderId: string; rating: number; content?: string }
  ): Promise<ItemReview> {
    if (data.rating < 1 || data.rating > 5) throw new Error('Rating must be between 1 and 5');
    const documentData: Record<string, unknown> = {
      storeId: identifierStringToDocumentBytes(data.storeId),
      itemId: identifierStringToDocumentBytes(data.itemId),
      orderId: identifierStringToDocumentBytes(data.orderId),
      // Consensus checks this equals the order's buyerId; the app requires it
      // to equal the signer too, which is what makes the review "verified".
      buyerId: identifierStringToDocumentBytes(reviewerId),
      rating: data.rating,
    };
    if (data.content) documentData.content = data.content;
    const created = await this.create(reviewerId, documentData);
    storeStatsService.invalidateItem(data.itemId);
    return created;
  }
}

export const itemReviewService = new ItemReviewService();
