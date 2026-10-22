/**
 * Store Review Service (storefront v2)
 *
 * One review per order. Consensus enforces that the order exists, that the
 * review's storeId/sellerId agree with it, and that the signer OWNS the order
 * (the `{$ownerId: $ownerId}` writer gate) — so every review on chain comes
 * from someone who placed an order there (not proof it was paid or
 * delivered). Costs 3 YAPP on v2–v5 and an action fee on v6. Aggregates (average, count,
 * distribution, rankings) come from `storeStatsService`, never from scans.
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES, lanePinOrderBy, storefrontIsV2, storefrontModPin } from '../constants';
import { carryModerationIntoReplace, moderationFieldOf } from './moderation-carry';
import { chunk, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import { identifierToBase58, identifierStringToDocumentBytes } from './sdk-helpers';
import { storeStatsService } from './store-stats-service';
import type { StoreReview, StoreReviewDocument } from '../../types';

class StoreReviewService extends BaseDocumentService<StoreReview> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  /** A replace (the client writes none today) sends a moderator's `mod`/`modLabel` back unchanged (41124 otherwise). */
  protected extractContentFields(doc: StoreReview): Record<string, unknown> {
    const fields = super.extractContentFields(doc);
    carryModerationIntoReplace(fields, doc);
    return fields;
  }

  protected transformDocument(doc: Record<string, unknown>): StoreReview {
    const data = (doc.data || doc) as StoreReviewDocument;
    return {
      id: (doc.$id || doc.id) as string,
      reviewerId: (doc.$ownerId || doc.ownerId) as string,
      storeId: identifierToBase58(data.storeId) || '',
      orderId: identifierToBase58(data.orderId) || '',
      sellerId: identifierToBase58(data.sellerId) || '',
      // v2 gates the writer to the order's owner; v1 has no such rule, so a
      // review there proves nothing about an order.
      ordered: storefrontIsV2(),
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      rating: data.rating,
      title: data.title,
      content: data.content,
      ...moderationFieldOf(doc),
    };
  }

  /** Reviews of a store, newest first. */
  async getStoreReviews(storeId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ reviews: StoreReview[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['storeId', '==', storeId], ...storefrontModPin()],
      orderBy: [['storeId', 'asc'], ...lanePinOrderBy(storefrontModPin()), ['$createdAt', 'desc']],
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
      // The buyer's own order page: `orderId` is not a laned index, so the review is read with its marks
      // (the page labels a hidden one for its author) and a public list drops it.
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
