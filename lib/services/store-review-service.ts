/**
 * Store Review Service
 *
 * Manages store reviews and ratings.
 * Reviews are immutable and require a completed order.
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { identifierToBase58, stringToIdentifierBytes } from './sdk-helpers';
import type {
  StoreReview,
  StoreReviewDocument,
  StoreRatingSummary
} from '../../types';

class StoreReviewService extends BaseDocumentService<StoreReview> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): StoreReview {
    const data = (doc.data || doc) as StoreReviewDocument;

    // Convert byte arrays to base58
    const storeId = identifierToBase58(data.storeId) || '';
    const orderId = identifierToBase58(data.orderId) || '';
    const sellerId = identifierToBase58(data.sellerId) || '';

    return {
      id: (doc.$id || doc.id) as string,
      reviewerId: (doc.$ownerId || doc.ownerId) as string,
      storeId,
      orderId,
      sellerId,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      rating: data.rating,
      title: data.title,
      content: data.content
    };
  }

  /**
   * Get reviews for a store
   */
  async getStoreReviews(storeId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ reviews: StoreReview[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['storeId', '==', storeId]],
      orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      reviews: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Get reviews by a buyer
   */
  async getBuyerReviews(buyerId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ reviews: StoreReview[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', buyerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      reviews: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Get reviews for a seller's store
   */
  async getSellerReviews(sellerId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ reviews: StoreReview[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['sellerId', '==', sellerId]],
      orderBy: [['sellerId', 'asc'], ['$createdAt', 'asc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      reviews: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Check if order has been reviewed
   */
  async getOrderReview(orderId: string): Promise<StoreReview | null> {
    const { documents } = await this.query({
      where: [['orderId', '==', orderId]],
      orderBy: [['orderId', 'asc']],
      limit: 1
    });

    return documents[0] || null;
  }

  /**
   * Check if buyer can review an order
   */
  async canReview(buyerId: string, orderId: string): Promise<boolean> {
    const existingReview = await this.getOrderReview(orderId);
    return existingReview === null;
  }

  /**
   * Create a review
   */
  async createReview(
    reviewerId: string,
    data: {
      storeId: string;
      orderId: string;
      sellerId: string;
      rating: number;
      title?: string;
      content?: string;
    }
  ): Promise<StoreReview> {
    // Validate rating
    if (data.rating < 1 || data.rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    const documentData: Record<string, unknown> = {
      storeId: stringToIdentifierBytes(data.storeId),
      orderId: stringToIdentifierBytes(data.orderId),
      sellerId: stringToIdentifierBytes(data.sellerId),
      rating: data.rating
    };

    if (data.title) documentData.title = data.title;
    if (data.content) documentData.content = data.content;

    return this.create(reviewerId, documentData);
  }

  /**
   * Delete a review (immutable, but owner can delete)
   */
  async deleteReview(reviewId: string, reviewerId: string): Promise<boolean> {
    return this.delete(reviewId, reviewerId);
  }

  // =========================================================================
  // Rating Calculation Methods
  // =========================================================================

  /**
   * Calculate rating summary for a store
   */
  async calculateRatingSummary(storeId: string): Promise<StoreRatingSummary> {
    // Fetch all reviews for this store
    const allReviews: StoreReview[] = [];
    let cursor: string | undefined;

    do {
      const { reviews, nextCursor } = await this.getStoreReviews(storeId, {
        limit: 100,
        startAfter: cursor
      });
      allReviews.push(...reviews);
      cursor = nextCursor;
    } while (cursor);

    if (allReviews.length === 0) {
      return {
        averageRating: 0,
        reviewCount: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
      };
    }

    // Calculate distribution
    const distribution: { 1: number; 2: number; 3: number; 4: number; 5: number } = {
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0
    };

    let totalRating = 0;
    for (const review of allReviews) {
      totalRating += review.rating;
      if (review.rating >= 1 && review.rating <= 5) {
        distribution[review.rating as 1 | 2 | 3 | 4 | 5]++;
      }
    }

    const averageRating = Math.round((totalRating / allReviews.length) * 10) / 10;

    return {
      averageRating,
      reviewCount: allReviews.length,
      ratingDistribution: distribution
    };
  }

  /**
   * Get formatted rating string (e.g., "4.5")
   */
  formatRating(rating: number): string {
    return rating.toFixed(1);
  }

  /**
   * Get star representation (for text display)
   */
  getStarRepresentation(rating: number): string {
    const fullStars = Math.floor(rating);
    const hasHalf = rating - fullStars >= 0.5;
    const emptyStars = 5 - fullStars - (hasHalf ? 1 : 0);

    return '★'.repeat(fullStars) + (hasHalf ? '½' : '') + '☆'.repeat(emptyStars);
  }
}

export const storeReviewService = new StoreReviewService();
