import { logger } from '@/lib/logger';
import type { DocumentsQuery } from '@dashevo/wasm-sdk';
import type { DocumentResult, QueryOptions } from './document-service';
import type { Post } from '../types';
import type { PostStats } from './post-service';
import { normalizeSDKResponse, type DocumentWhereClause } from './sdk-helpers';
import { retryAsync } from '../retry-utils';

export async function fetchFollowingFeed(
  userId: string,
  contractId: string,
  transformDocument: (doc: Record<string, unknown>) => Post,
  options: QueryOptions & {
    timeWindowStart?: Date;
    timeWindowEnd?: Date;
    windowHours?: number;
  } = {}
): Promise<DocumentResult<Post>> {
  const TARGET_POSTS = 50;
  const DEFAULT_WINDOW_HOURS = 24;
  const MIN_WINDOW_HOURS = 1;

  try {
    const { followService } = await import('./follow-service');
    const following = await followService.getFollowing(userId);
    const followingIds = following.map((item) => item.followingId);

    if (followingIds.length === 0) {
      return { documents: [], nextCursor: undefined, prevCursor: undefined };
    }

    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();

    const now = new Date();
    const windowEndMs = options.timeWindowEnd?.getTime() || now.getTime();
    let windowHours = options.windowHours || DEFAULT_WINDOW_HOURS;
    windowHours = Math.max(MIN_WINDOW_HOURS, windowHours);
    let windowStartMs = options.timeWindowStart?.getTime() || (windowEndMs - windowHours * 60 * 60 * 1000);

    const executeQuery = async (whereClause: DocumentWhereClause[]): Promise<Post[]> => {
      const queryParams: DocumentsQuery = {
        dataContractId: contractId,
        documentTypeName: 'post',
        where: whereClause,
        orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
        limit: 100,
      };

      const response = await sdk.documents.query(queryParams);
      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => transformDocument(doc));
    };

    const buildWhere = (startMs: number, endMs?: number): DocumentWhereClause[] => {
      const where: DocumentWhereClause[] = [
        ['$ownerId', 'in', followingIds],
        ['$createdAt', '>=', startMs],
      ];
      if (endMs) {
        where.push(['$createdAt', '<', endMs]);
      }
      return where;
    };

    let posts = await executeQuery(buildWhere(windowStartMs, options.timeWindowEnd?.getTime()));
    let actualWindowHours = (windowEndMs - windowStartMs) / (60 * 60 * 1000);

    if (posts.length === 100 && !options.timeWindowEnd) {
      let currentWindowMs = windowHours * 60 * 60 * 1000;
      while (posts.length === 100) {
        currentWindowMs /= 2;
        windowStartMs = windowEndMs - currentWindowMs;
        posts = await executeQuery(buildWhere(windowStartMs));
        actualWindowHours = currentWindowMs / (60 * 60 * 1000);
      }
    } else if (posts.length === 0 && !options.timeWindowEnd) {
      let currentWindowMs = windowHours * 60 * 60 * 1000;
      const maxExpansions = 20;
      let expansions = 0;
      while (posts.length === 0 && expansions < maxExpansions) {
        currentWindowMs *= 2;
        windowStartMs = windowEndMs - currentWindowMs;
        posts = await executeQuery(buildWhere(windowStartMs));
        actualWindowHours = currentWindowMs / (60 * 60 * 1000);
        expansions++;
      }
    }

    posts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const postsPerHour = posts.length > 0 ? posts.length / actualWindowHours : 0;
    let suggestedNextWindowHours: number;

    if (postsPerHour > 0) {
      suggestedNextWindowHours = TARGET_POSTS / postsPerHour;
      suggestedNextWindowHours = Math.max(MIN_WINDOW_HOURS, suggestedNextWindowHours);
    } else {
      suggestedNextWindowHours = actualWindowHours * 2;
    }

    const nextWindowEnd = new Date(windowStartMs);
    const nextWindowStart = new Date(windowStartMs - suggestedNextWindowHours * 60 * 60 * 1000);

    const exhaustedSearch = posts.length === 0 && !options.timeWindowEnd;

    return {
      documents: posts,
      nextCursor: exhaustedSearch
        ? undefined
        : JSON.stringify({
            start: nextWindowStart.toISOString(),
            end: nextWindowEnd.toISOString(),
            windowHours: suggestedNextWindowHours,
          }),
      prevCursor: undefined,
    };
  } catch (error) {
    logger.error('Error getting following feed:', error);
    return { documents: [], nextCursor: undefined, prevCursor: undefined };
  }
}

export async function fetchUniqueAuthorCount(contractId: string): Promise<number> {
  const result = await retryAsync(
    async () => {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();
      const uniqueAuthors = new Set<string>();
      let startAfter: string | undefined = undefined;
      const PAGE_SIZE = 100;

      while (true) {
        const queryParams: DocumentsQuery = {
          dataContractId: contractId,
          documentTypeName: 'post',
          where: [
            ['language', '==', 'en'],
            ['$createdAt', '>', 0],
          ],
          orderBy: [['language', 'asc'], ['$createdAt', 'asc']],
          limit: PAGE_SIZE,
          startAfter,
        };

        const response = await sdk.documents.query(queryParams);
        const documents = normalizeSDKResponse(response);

        for (const doc of documents) {
          if (doc.$ownerId) {
            uniqueAuthors.add(doc.$ownerId as string);
          }
        }

        if (documents.length < PAGE_SIZE) break;

        const lastDoc = documents[documents.length - 1];
        if (!lastDoc.$id) break;
        startAfter = lastDoc.$id as string;
      }

      return uniqueAuthors.size;
    },
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    }
  );

  if (!result.success || result.data === undefined) {
    logger.error('Error counting unique authors after retries:', result.error);
    throw result.error || new Error('Failed to count unique authors');
  }

  return result.data;
}

export async function fetchTopPostsByLikes(
  limit: number,
  getTimeline: (options: QueryOptions & { language?: string }) => Promise<DocumentResult<Post>>,
  getBatchPostStats: (postIds: string[]) => Promise<Map<string, PostStats>>,
  enrichPostsBatch: (posts: Post[]) => Promise<Post[]>
): Promise<Post[]> {
  try {
    const result = await getTimeline({ limit: 50 });
    const posts = result.documents;

    if (posts.length === 0) return [];

    const postIds = posts.map((post) => post.id);
    const statsMap = await getBatchPostStats(postIds);

    const postsWithLikes = posts.map((post) => ({
      post,
      likes: statsMap.get(post.id)?.likes || 0,
    }));

    postsWithLikes.sort((a, b) => b.likes - a.likes);
    const topPosts = postsWithLikes.slice(0, limit).map((item) => item.post);

    return enrichPostsBatch(topPosts);
  } catch (error) {
    logger.error('Error getting top posts by likes:', error);
    return [];
  }
}

export async function fetchAuthorPostCounts(contractId: string): Promise<Map<string, number>> {
  const authorCounts = new Map<string, number>();

  try {
    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();
    let startAfter: string | undefined = undefined;
    const PAGE_SIZE = 100;
    let totalProcessed = 0;
    const MAX_POSTS = 10_000;

    while (totalProcessed < MAX_POSTS) {
      const queryParams: DocumentsQuery = {
        dataContractId: contractId,
        documentTypeName: 'post',
        where: [
          ['language', '==', 'en'],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['language', 'asc'], ['$createdAt', 'desc']],
        limit: PAGE_SIZE,
        startAfter,
      };

      const response = await sdk.documents.query(queryParams);
      const documents = normalizeSDKResponse(response);

      for (const doc of documents) {
        if (doc.$ownerId) {
          const ownerId = doc.$ownerId as string;
          authorCounts.set(ownerId, (authorCounts.get(ownerId) || 0) + 1);
        }
      }

      totalProcessed += documents.length;

      if (documents.length < PAGE_SIZE) break;

      const lastDoc = documents[documents.length - 1];
      if (!lastDoc.$id) break;
      startAfter = lastDoc.$id as string;
    }

    return authorCounts;
  } catch (error) {
    logger.error('Error getting author post counts:', error);
    return authorCounts;
  }
}

export async function fetchQuotePosts(
  quotedPostId: string,
  contractId: string,
  transformDocument: (doc: Record<string, unknown>) => Post,
  options: { limit?: number } = {}
): Promise<Post[]> {
  const limit = options.limit || 50;

  try {
    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();

    const response = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: 'post',
      where: [
        ['language', '==', 'en'],
        ['$createdAt', '>', 0],
      ],
      orderBy: [['language', 'asc'], ['$createdAt', 'desc']],
      limit: 100,
    });

    const documents = normalizeSDKResponse(response);

    return documents
      .map((doc) => transformDocument(doc))
      .filter((post) => post.quotedPostId === quotedPostId)
      .slice(0, limit);
  } catch (error) {
    logger.error('Error getting quote posts:', error);
    return [];
  }
}

export async function fetchQuotesOfMyPosts(
  userId: string,
  contractId: string,
  transformDocument: (doc: Record<string, unknown>) => Post,
  since?: Date
): Promise<Post[]> {
  try {
    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();

    const sinceTimestamp = since?.getTime() || 0;

    const response = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: 'post',
      where: [
        ['quotedPostOwnerId', '==', userId],
        ['$createdAt', '>', sinceTimestamp],
      ],
      orderBy: [['quotedPostOwnerId', 'asc'], ['$createdAt', 'asc']],
      limit: 100,
    });

    const documents = normalizeSDKResponse(response);

    return documents
      .map((doc) => transformDocument(doc))
      .filter((post) => post.content && post.content.trim() !== '');
  } catch (error) {
    logger.error('Error getting quotes of my posts:', error);
    return [];
  }
}
