/**
 * Pagination utilities for Dash Platform document queries.
 *
 * The SDK's startAfter cursor-based pagination requires:
 * - An orderBy clause on the query
 * - The last document's $id as the startAfter value
 *
 * These utilities handle automatic pagination through all results
 * for both counting and fetching complete lists.
 */

import { normalizeSDKResponse } from './sdk-helpers';

export interface PaginateOptions {
  /** Maximum results to return (safety limit). Default: 1000 */
  maxResults?: number;
  /** Page size per query. Default: 100 */
  pageSize?: number;
}

export interface PaginateCountResult {
  count: number;
  /** True if we hit maxResults before exhausting all documents */
  reachedLimit: boolean;
}

export interface PaginateFetchResult<T> {
  documents: T[];
  /** True if we hit maxResults before exhausting all documents */
  reachedLimit: boolean;
}

// Use any for SDK type since EvoSDK has complex generic typing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDK = any;

/**
 * Paginate through all documents matching a query and return the count.
 * Used for count methods that need accurate totals.
 *
 * @param sdk - The EvoSDK instance
 * @param queryBuilder - Function that returns the query object, accepting optional startAfter cursor
 * @param options - Pagination options
 * @returns Count result with total and whether limit was reached
 *
 * @example
 * ```typescript
 * const { count } = await paginateCount(sdk, (startAfter) => ({
 *   dataContractId: contractId,
 *   documentTypeName: 'like',
 *   where: [['$ownerId', '==', userId]],
 *   orderBy: [['$createdAt', 'asc']],
 * }));
 * ```
 */
export async function paginateCount(
  sdk: SDK,
  queryBuilder: (startAfter?: string) => Record<string, unknown>,
  options: PaginateOptions = {}
): Promise<PaginateCountResult> {
  const { maxResults = 1000, pageSize = 100 } = options;

  let totalCount = 0;
  let startAfter: string | undefined = undefined;
  let reachedLimit = false;

  while (totalCount < maxResults) {
    const query = queryBuilder(startAfter);
    query.limit = pageSize;
    if (startAfter) {
      query.startAfter = startAfter;
    }

    const response = await sdk.documents.query(query);
    const documents = normalizeSDKResponse(response);

    totalCount += documents.length;

    // Check if we've reached the end (fewer documents than requested)
    if (documents.length < pageSize) {
      break;
    }

    // Check if we've hit the safety limit
    if (totalCount >= maxResults) {
      reachedLimit = true;
      break;
    }

    // Get cursor for next page
    const lastDoc = documents[documents.length - 1];
    if (!lastDoc.$id) break;
    startAfter = lastDoc.$id as string;
  }

  return { count: totalCount, reachedLimit };
}

/**
 * Paginate through all documents and return them.
 * Used for list methods that need complete data.
 *
 * @param sdk - The EvoSDK instance
 * @param queryBuilder - Function that returns the query object, accepting optional startAfter cursor
 * @param transformFn - Function to transform raw documents to typed objects
 * @param options - Pagination options
 * @returns Fetch result with documents array and whether limit was reached
 *
 * @example
 * ```typescript
 * const { documents } = await paginateFetchAll(
 *   sdk,
 *   (startAfter) => ({
 *     dataContractId: contractId,
 *     documentTypeName: 'follow',
 *     where: [['followingId', '==', userId]],
 *     orderBy: [['$createdAt', 'asc']],
 *   }),
 *   (doc) => transformDocument(doc)
 * );
 * ```
 */
export async function paginateFetchAll<T>(
  sdk: SDK,
  queryBuilder: (startAfter?: string) => Record<string, unknown>,
  transformFn: (doc: Record<string, unknown>) => T,
  options: PaginateOptions = {}
): Promise<PaginateFetchResult<T>> {
  const { maxResults = 1000, pageSize = 100 } = options;

  const allDocuments: T[] = [];
  let startAfter: string | undefined = undefined;
  let reachedLimit = false;

  while (allDocuments.length < maxResults) {
    const query = queryBuilder(startAfter);
    query.limit = pageSize;
    if (startAfter) {
      query.startAfter = startAfter;
    }

    const response = await sdk.documents.query(query);
    const documents = normalizeSDKResponse(response);

    // Transform and collect documents
    allDocuments.push(...documents.map(transformFn));

    // Check if we've reached the end (fewer documents than requested)
    if (documents.length < pageSize) {
      break;
    }

    // Check if we've hit the safety limit
    if (allDocuments.length >= maxResults) {
      reachedLimit = true;
      break;
    }

    // Get cursor for next page
    const lastDoc = documents[documents.length - 1];
    if (!lastDoc.$id) break;
    startAfter = lastDoc.$id as string;
  }

  return { documents: allDocuments, reachedLimit };
}
