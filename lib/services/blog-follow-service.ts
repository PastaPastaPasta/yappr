import { logger } from '@/lib/logger';
import { stateTransitionService } from './state-transition-service';
import { stringToIdentifierBytes, identifierToBase58, RequestDeduplicator } from './sdk-helpers';
import { getEvoSdk } from './evo-sdk-service';
import { YAPPR_BLOG_CONTRACT_ID } from '../constants';
import { paginateCount, paginateFetchAll } from './pagination-utils';
import type { BlogFollow } from '@/lib/types';

const DOCUMENT_TYPE = 'blogFollow';

interface BlogFollowDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  blogId: string;
}

function transformDocument(doc: Record<string, unknown>): BlogFollowDocument {
  const data = (doc.data || doc) as Record<string, unknown>;
  const rawBlogId = data.blogId || doc.blogId;
  const blogId = rawBlogId ? identifierToBase58(rawBlogId) : '';

  return {
    $id: (doc.$id || doc.id) as string,
    $ownerId: (doc.$ownerId || doc.ownerId) as string,
    $createdAt: (doc.$createdAt || doc.createdAt || 0) as number,
    blogId: blogId || '',
  };
}

class BlogFollowService {
  private followingDeduplicator = new RequestDeduplicator<string, string[]>();
  private countFollowersDeduplicator = new RequestDeduplicator<string, number>();

  async followBlog(userId: string, blogId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const existing = await this.getFollow(userId, blogId);
      if (existing) {
        logger.info('Already following blog');
        return { success: true };
      }

      const result = await stateTransitionService.createDocument(
        YAPPR_BLOG_CONTRACT_ID,
        DOCUMENT_TYPE,
        userId,
        { blogId: stringToIdentifierBytes(blogId) }
      );

      return result;
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

      const result = await stateTransitionService.deleteDocument(
        YAPPR_BLOG_CONTRACT_ID,
        DOCUMENT_TYPE,
        follow.$id,
        userId
      );

      return result;
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
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_BLOG_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPE,
        where: [
          ['$ownerId', '==', userId],
          ['blogId', '==', blogId]
        ],
        limit: 1
      } as any);

      const documents = Array.isArray(response) ? response : [];
      if (documents.length === 0) return null;

      const doc = typeof documents[0].toJSON === 'function' ? documents[0].toJSON() : documents[0];
      return transformDocument(doc as Record<string, unknown>);
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
          dataContractId: YAPPR_BLOG_CONTRACT_ID,
          documentTypeName: DOCUMENT_TYPE,
          where: [
            ['$ownerId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => {
          const transformed = transformDocument(doc);
          return {
            id: transformed.$id,
            ownerId: transformed.$ownerId,
            blogId: transformed.blogId,
            createdAt: new Date(transformed.$createdAt),
          };
        }
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
          dataContractId: YAPPR_BLOG_CONTRACT_ID,
          documentTypeName: DOCUMENT_TYPE,
          where: [
            ['blogId', '==', blogId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['blogId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => {
          const transformed = transformDocument(doc);
          return {
            id: transformed.$id,
            ownerId: transformed.$ownerId,
            blogId: transformed.blogId,
            createdAt: new Date(transformed.$createdAt),
          };
        }
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
            dataContractId: YAPPR_BLOG_CONTRACT_ID,
            documentTypeName: DOCUMENT_TYPE,
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
