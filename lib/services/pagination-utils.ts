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

import { logger } from '@/lib/logger';
import { normalizeSDKResponse, identifierToHex } from './sdk-helpers';

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
 * Dash Platform caps `in` clauses (and per-query limits) at 100 values —
 * queries over larger id lists must be split into batches of at most this size.
 */
export const MAX_IN_CLAUSE_VALUES = 100;

/** Split items into consecutive batches of at most `size` items. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Map over items with bounded concurrency (a tiny promise pool). Prevents a
 * whole feed page from firing an unbounded burst of DAPI requests at once.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)
  );
  return results;
}

/**
 * Count documents matching a query using the Platform count-tree (O(1)).
 *
 * Requires the queried document type to declare a `countable` index covering the
 * `where` clause (see yappr-social-contract-v2). The query must NOT include a
 * `limit`/`startAfter` — counts are over the whole matching set.
 *
 * Returns the grand total (the `''` key of the SDK's grouped count map). For
 * grouped counts (e.g. `groupBy: ['postId']` with `postId in [...]`), call
 * `sdk.documents.count` directly and read per-key entries.
 *
 * @example
 * const likes = await documentCount(sdk, {
 *   dataContractId: contractId,
 *   documentTypeName: 'like',
 *   where: [['postId', '==', postId]],
 * });
 */
export async function documentCount(
  sdk: SDK,
  query: Record<string, unknown>
): Promise<number> {
  const result = await sdk.documents.count(query);
  // SDK returns Map<string, bigint>; '' is the grand total when no groupBy is set.
  const total = result instanceof Map ? result.get('') : result?.['']; // tolerate plain-object shape
  if (total === undefined || total === null) {
    // Zero-count branches aren't materialized in the platform's count trees, so
    // a genuine 0 comes back as an EMPTY map with no grand-total key. Only warn
    // when the map has entries but none of them is the grand total — that shape
    // would mean a grouped response leaked into the aggregate path.
    const entryCount = result instanceof Map ? result.size : Object.keys(result ?? {}).length;
    if (entryCount > 0) {
      logger.warn('documentCount: non-empty count result without grand-total key; treating as 0', {
        documentTypeName: (query as { documentTypeName?: string }).documentTypeName,
      });
    }
    return 0;
  }
  return Number(total);
}

/**
 * Batch-count documents grouped by an identifier `In`-field's count-tree, in one
 * DAPI round-trip instead of one `documentCount` call per id.
 *
 * Requires the queried document type to declare a `countable` index whose sole
 * property is `groupField` (e.g. `byPost`/`byParent` in yappr-social-contract-v2).
 * `ids` are base58 identifier strings; the returned map is keyed the same way.
 *
 * The SDK's raw grouped-count map is keyed by hex-encoded property bytes — an
 * encoding not otherwise exercised by this app, so on any response that doesn't
 * decode against our expected hex keys, this transparently falls back to
 * `fallbackCount` per id (bounded concurrency) rather than risk silently
 * reporting every id as a 0 count.
 */
export async function groupedDocumentCount(
  sdk: SDK,
  query: { dataContractId: unknown; documentTypeName: string; groupField: string },
  ids: string[],
  fallbackCount: (id: string) => Promise<number>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (ids.length === 0) return result;
  ids.forEach((id) => result.set(id, 0));

  // Platform caps `in` clauses at 100 values, so oversized id lists (e.g. a
  // profile page's merged posts + reposts) must be batched or the query errors.
  await mapLimit(chunk(ids, MAX_IN_CLAUSE_VALUES), 2, async (batch) => {
    const hexToId = new Map<string, string>();
    batch.forEach((id) => {
      const hex = identifierToHex(id);
      if (hex) hexToId.set(hex, id);
    });

    try {
      // NOTE: no `limit` — Drive rejects any limit on In-grouped COUNT queries
      // with InvalidLimit (the result is already bounded by the In array).
      const raw: unknown = await sdk.documents.count({
        dataContractId: query.dataContractId,
        documentTypeName: query.documentTypeName,
        where: [[query.groupField, 'in', batch]],
        groupBy: [query.groupField],
      });

      const entries: [string, unknown][] =
        raw instanceof Map ? Array.from(raw.entries()) : Object.entries((raw ?? {}) as Record<string, unknown>);

      let matched = 0;
      for (const [key, value] of entries) {
        if (key === '') continue; // aggregate-mode key; shouldn't appear once groupBy is set
        const id = hexToId.get(key);
        if (id) {
          result.set(id, Number(value as bigint | number));
          matched++;
        }
      }

      if (entries.length > 0 && matched === 0) {
        throw new Error('groupedDocumentCount: no group keys matched expected hex ids');
      }
    } catch (error) {
      logger.warn('groupedDocumentCount: falling back to per-id counts', {
        documentTypeName: query.documentTypeName,
        error: error instanceof Error ? error.message : String(error),
      });
      const counts = await mapLimit(batch, 6, fallbackCount);
      batch.forEach((id, i) => result.set(id, counts[i]));
    }
  });

  return result;
}

/**
 * Which of `postIds` appear in the caller's OWN documents of a type indexed
 * uniquely on `$ownerId` + `postId` — the "did I like/repost this?" lookup.
 *
 * Queries only the user's own docs, batched to respect the 100-value `in` cap.
 * A unique (owner, postId) index yields at most one doc per postId, so
 * `limit: batch.length` can never truncate a batch. `ownerFirst` selects the
 * where/orderBy ordering to match how the contract declares that index
 * (`true` = [$ownerId, postId], `false` = [postId, $ownerId]).
 *
 * Returns the set of matching postIds; on error logs `errorLabel` and returns
 * whatever was collected so far.
 */
export async function queryOwnedPostIds(
  params: {
    getSdk: () => Promise<SDK>;
    dataContractId: unknown;
    documentTypeName: string;
    userId: string;
    postIds: string[];
    ownerFirst: boolean;
    getPostId: (doc: Record<string, unknown>) => string | undefined;
    errorLabel: string;
  }
): Promise<Set<string>> {
  if (params.postIds.length === 0) return new Set();
  const found = new Set<string>();
  try {
    const sdk = await params.getSdk();
    const ownerClause = ['$ownerId', '==', params.userId];
    const ownerOrder = ['$ownerId', 'asc'];
    await mapLimit(chunk(params.postIds, MAX_IN_CLAUSE_VALUES), 2, async (batch) => {
      const postClause = ['postId', 'in', batch];
      const postOrder = ['postId', 'asc'];
      const response = await sdk.documents.query({
        dataContractId: params.dataContractId,
        documentTypeName: params.documentTypeName,
        where: params.ownerFirst ? [ownerClause, postClause] : [postClause, ownerClause],
        orderBy: params.ownerFirst ? [ownerOrder, postOrder] : [postOrder, ownerOrder],
        limit: batch.length,
      });
      for (const doc of normalizeSDKResponse(response)) {
        const postId = params.getPostId(doc);
        if (postId) found.add(postId);
      }
    });
    return found;
  } catch (error) {
    // Fail closed: a failed batch/SDK acquisition returns an empty set rather
    // than partial results, so callers never highlight a subset of posts.
    logger.error(params.errorLabel, error);
    return new Set();
  }
}

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
