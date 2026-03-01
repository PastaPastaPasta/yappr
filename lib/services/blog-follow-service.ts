import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { stringToIdentifierBytes, RequestDeduplicator, transformDocumentWithField } from './sdk-helpers';
import { getEvoSdk } from './evo-sdk-service';
import { YAPPR_BLOG_CONTRACT_ID } from '../constants';
import { paginateCount, paginateFetchAll } from './pagination-utils';
import type { BlogFollow } from '@/lib/types';

interface BlogFollowDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  blogId: string;
}

function toBlogFollow(doc: BlogFollowDocument): BlogFollow {
  return {
    id: doc.$id,
    ownerId: doc.$ownerId,
    blogId: doc.blogId,
    createdAt: new Date(doc.$createdAt),
  };
}

class BlogFollowService extends BaseDocumentService<BlogFollowDocument> {
  private followingDeduplicator = new RequestDeduplicator<string, string[]>();
  private countFollowersDeduplicator = new RequestDeduplicator<string, number>();

  constructor() {
    super('blogFollow', YAPPR_BLOG_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): BlogFollowDocument {
    return transformDocumentWithField<BlogFollowDocument>(doc, 'blogId', 'BlogFollowService');
  }

  async followBlog(userId: string, blogId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const existing = await this.getFollow(userId, blogId);
      if (existing) {
        logger.info('Already following blog');
        return { success: true };
      }

      return await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        userId,
        { blogId: stringToIdentifierBytes(blogId) }
      );
    } catch (error) {
      logger.error('Error following blog:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to follow blog'
      };
    }
  }

  async unfollowBlog(userId: string, blogId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const follow = await this.getFollow(userId, blogId);
      if (!follow) {
        logger.info('Not following blog');
        return { success: true };
      }

      return await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        follow.$id,
        userId
      );
    } catch (error) {
      logger.error('Error unfollowing blog:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unfollow blog'
      };
    }
  }

  async isFollowingBlog(userId: string, blogId: string): Promise<boolean> {
    if (!userId || !blogId) return false;
    const followedIds = await this.getFollowedBlogIds(userId);
    return followedIds.includes(blogId);
  }

  private async getFollow(userId: string, blogId: string): Promise<BlogFollowDocument | null> {
    try {
      const result = await this.query({
        where: [
          ['$ownerId', '==', userId],
          ['blogId', '==', blogId]
        ],
        limit: 1
      });

      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (error) {
      logger.error('Error getting blog follow:', error);
      return null;
    }
  }

  async getFollowedBlogs(userId: string): Promise<BlogFollow[]> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => toBlogFollow(this.transformDocument(doc))
      );

      return documents;
    } catch (error) {
      logger.error('Error getting followed blogs:', error);
      return [];
    }
  }

  async getFollowedBlogIds(userId: string): Promise<string[]> {
    if (!userId) return [];

    return this.followingDeduplicator.dedupe(userId, async () => {
      const follows = await this.getFollowedBlogs(userId);
      return follows.map(f => f.blogId);
    });
  }

  async getBlogFollowers(blogId: string): Promise<BlogFollow[]> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName: this.documentType,
          where: [
            ['blogId', '==', blogId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['blogId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => toBlogFollow(this.transformDocument(doc))
      );

      return documents;
    } catch (error) {
      logger.error('Error getting blog followers:', error);
      return [];
    }
  }

  async countBlogFollowers(blogId: string): Promise<number> {
    return this.countFollowersDeduplicator.dedupe(blogId, async () => {
      try {
        const sdk = await getEvoSdk();

        const { count } = await paginateCount(
          sdk,
          () => ({
            dataContractId: this.contractId,
            documentTypeName: this.documentType,
            where: [
              ['blogId', '==', blogId],
              ['$createdAt', '>', 0]
            ],
            orderBy: [['blogId', 'asc'], ['$createdAt', 'asc']]
          })
        );

        return count;
      } catch (error) {
        logger.error('Error counting blog followers:', error);
        return 0;
      }
    });
  }

  async getFollowStatusBatch(blogIds: string[], userId: string): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();

    for (const id of blogIds) {
      result.set(id, false);
    }

    if (!userId || blogIds.length === 0) {
      return result;
    }

    try {
      const followedIds = await this.getFollowedBlogIds(userId);
      const followedSet = new Set(followedIds);

      for (const blogId of blogIds) {
        result.set(blogId, followedSet.has(blogId));
      }
    } catch (error) {
      logger.error('Error getting batch blog follow status:', error);
    }

    return result;
  }
}

export const blogFollowService = new BlogFollowService();
