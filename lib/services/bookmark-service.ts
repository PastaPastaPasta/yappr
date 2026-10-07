import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { transformDocumentWithField, identifierStringToDocumentBytes } from './sdk-helpers';
import { paginateFetchAll, chunk, mapLimit, MAX_IN_CLAUSE_VALUES } from './pagination-utils';

export interface BookmarkDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  postId: string;
}

class BookmarkService extends BaseDocumentService<BookmarkDocument> {
  constructor() {
    super('bookmark');
  }

  protected transformDocument(doc: Record<string, unknown>): BookmarkDocument {
    return transformDocumentWithField<BookmarkDocument>(doc, 'postId', 'BookmarkService');
  }

  /**
   * Bookmark a post
   */
  async bookmarkPost(postId: string, ownerId: string): Promise<boolean> {
    try {
      // Check if already bookmarked
      const existing = await this.getBookmark(postId, ownerId, { throwOnError: true });
      if (existing) {
        logger.debug('Post already bookmarked');
        return true;
      }

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        { postId: identifierStringToDocumentBytes(postId) }
      );

      return result.success;
    } catch (error) {
      logger.error('Error bookmarking post:', error);
      return false;
    }
  }

  /**
   * Remove bookmark
   */
  async removeBookmark(postId: string, ownerId: string): Promise<boolean> {
    try {
      const bookmark = await this.getBookmark(postId, ownerId, { throwOnError: true });
      if (!bookmark) {
        logger.debug('Post not bookmarked');
        return true;
      }

      return await this.deleteBookmark(bookmark.$id, ownerId);
    } catch (error) {
      logger.error('Error removing bookmark:', error);
      return false;
    }
  }

  /** Delete one of the owner's bookmark documents by its id (no lookup first). */
  async deleteBookmark(bookmarkId: string, ownerId: string): Promise<boolean> {
    try {
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        bookmarkId,
        ownerId
      );
      return result.success;
    } catch (error) {
      logger.error('Error deleting bookmark:', error);
      return false;
    }
  }

  /**
   * Check if post is bookmarked by user
   */
  async isBookmarked(postId: string, ownerId: string): Promise<boolean> {
    const bookmark = await this.getBookmark(postId, ownerId);
    return bookmark !== null;
  }

  /**
   * Get bookmark by post and owner
   */
  async getBookmark(postId: string, ownerId: string, options: { throwOnError?: boolean } = {}): Promise<BookmarkDocument | null> {
    try {
      const result = await this.query({
        where: [
          ['postId', '==', postId],
          ['$ownerId', '==', ownerId]
        ],
        limit: 1
      });

      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (error) {
      logger.error('Error getting bookmark:', error);
      if (options.throwOnError) throw error;
      return null;
    }
  }

  /**
   * Every bookmark a user made, newest first, read to the end (no cap): the
   * bookmarks page searches, sorts and clears the whole set, and pages only
   * the hydration of the posts. Rejects when the read fails, so a failure
   * never passes for "no bookmarks".
   */
  async getUserBookmarks(userId: string): Promise<BookmarkDocument[]> {
    const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

    const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: 'bookmark',
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$createdAt', 'desc']]
        }),
        (doc) => this.transformDocument(doc),
        { maxResults: Infinity }
      );

    return documents;
  }

  /**
   * Get user's bookmarks for specific posts.
   * Uses the ownerAndPost index: [$ownerId, postId]
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  async getUserBookmarksForPosts(userId: string, postIds: string[]): Promise<BookmarkDocument[]> {
    if (postIds.length === 0) return [];

    try {
      // Platform caps `in` clauses (and query limits) at 100 values, so
      // oversized pages must be batched.
      const batches = await mapLimit(chunk(postIds, MAX_IN_CLAUSE_VALUES), 2, (batch) =>
        this.query({
          where: [
            ['$ownerId', '==', userId],
            ['postId', 'in', batch]
          ],
          orderBy: [['$ownerId', 'asc'], ['postId', 'asc']],
          limit: batch.length
        })
      );

      return batches.flatMap((result) => result.documents);
    } catch (error) {
      logger.error('Error getting user bookmarks for posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const bookmarkService = new BookmarkService();
