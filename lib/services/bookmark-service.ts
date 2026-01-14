import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { transformDocumentWithField, normalizeSDKResponse } from './sdk-helpers';

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
        console.log('Post already bookmarked');
        return true;
      }

      // Use state transition service for creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        { postId }
      );

      return result.success;
    } catch (error) {
      console.error('Error bookmarking post:', error);
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
        console.log('Post not bookmarked');
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
      console.error('Error removing bookmark:', error);
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
      console.error('Error getting bookmark:', error);
      return null;
    }
  }

  /**
   * Get user's bookmarks
   */
  async getUserBookmarks(userId: string, options: QueryOptions = {}): Promise<BookmarkDocument[]> {
    try {
      const result = await this.query({
        where: [['$ownerId', '==', userId]],
        orderBy: [['$createdAt', 'desc']],
        limit: 50,
        ...options
      });

      return result.documents;
    } catch (error) {
      console.error('Error getting user bookmarks:', error);
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
   */
  async getUserBookmarksForPosts(userId: string, postIds: string[]): Promise<BookmarkDocument[]> {
    if (postIds.length === 0) return [];

    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'bookmark',
        where: [
          ['$ownerId', '==', userId],
          ['postId', 'in', postIds]
        ],
        orderBy: [['$ownerId', 'asc'], ['postId', 'asc']],
        limit: postIds.length
      } as any);

      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      console.error('Error getting user bookmarks for posts:', error);
      return [];
    }
  }
}

// Singleton instance
export const bookmarkService = new BookmarkService();