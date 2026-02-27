import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { transformDocumentWithField, stringToIdentifierBytes } from './sdk-helpers';
import { paginateFetchAll } from './pagination-utils';

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
      const existing = await this.getBookmark(postId, ownerId);
      if (existing) {
        logger.info('Post already bookmarked');
        return true;
      }

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        { postId: stringToIdentifierBytes(postId) }
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
      const bookmark = await this.getBookmark(postId, ownerId);
      if (!bookmark) {
        logger.info('Post not bookmarked');
        return true;
      }

      // Use state transition service for deletion
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        bookmark.$id,
        ownerId
      );

      return result.success;
    } catch (error) {
      logger.error('Error removing bookmark:', error);
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
  async getBookmark(postId: string, ownerId: string): Promise<BookmarkDocument | null> {
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
      return null;
    }
  }

  /**
   * Get user's bookmarks.
   * Paginates through all results to return complete list.
   */
  async getUserBookmarks(userId: string): Promise<BookmarkDocument[]> {
    try {
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
        (doc) => this.transformDocument(doc)
      );

      return documents;
    } catch (error) {
      logger.error('Error getting user bookmarks:', error);
      return [];
    }
  }

  /**
   * Count bookmarks for a user
   */
  async countUserBookmarks(userId: string): Promise<number> {
    const bookmarks = await this.getUserBookmarks(userId);
    return bookmarks.length;
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
      const result = await this.query({
        where: [
          ['$ownerId', '==', userId],
          ['postId', 'in', postIds]
        ],
        orderBy: [['$ownerId', 'asc'], ['postId', 'asc']],
        limit: postIds.length
      });

      return result.documents;
    } catch (error) {
      logger.error('Error getting user bookmarks for posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const bookmarkService = new BookmarkService();