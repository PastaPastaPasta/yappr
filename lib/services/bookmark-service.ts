import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierToBase58 } from './sdk-helpers';

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

  /**
   * Transform document
   */
  protected transformDocument(doc: any): BookmarkDocument {
    // Handle different document structures from SDK
    // Batch queries return: { id, ownerId, data: { postId } }
    // Regular queries return: { $id, $ownerId, postId }
    const data = doc.data || doc;
    const rawPostId = data.postId || doc.postId;

    // SDK v3 toJSON() returns byte array fields as base64 strings
    // Convert to base58 for consistent handling
    const postId = identifierToBase58(rawPostId) || String(rawPostId);

    return {
      $id: doc.$id || doc.id,
      $ownerId: doc.$ownerId || doc.ownerId,
      $createdAt: doc.$createdAt || doc.createdAt,
      postId
    };
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
}

// Singleton instance
export const bookmarkService = new BookmarkService();