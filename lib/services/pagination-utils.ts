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

import bs58 from 'bs58';
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

      const entries = groupedCountEntries(raw);

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
 * Base58 of 32 zero bytes — sorts below every real identifier, so
 * `[field, '>', MIN_IDENTIFIER]` is a full range over an identifier field.
 */
const MIN_IDENTIFIER = '1'.repeat(32);

/** The SDK returns grouped counts as a Map or (older shapes) a plain object. */
function groupedCountEntries(raw: unknown): [string, unknown][] {
  return raw instanceof Map ? Array.from(raw.entries()) : Object.entries((raw ?? {}) as Record<string, unknown>);
}

/** Decode a 64-char hex grouped-count key to base58. Hex ONLY — some hex strings
 * are also valid base58, so the permissive `identifierToBase58` cannot be used. */
function hexKeyToBase58(key: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
  }
  return bs58.encode(bytes);
}

/**
 * Count documents per DISTINCT value of an identifier field, in one round trip —
 * a full-range count query grouped by the same field (Drive's "RangeDistinct"
 * grouped-count mode). The returned map is keyed by base58 identifier; its size
 * is the number of distinct values.
 *
 * Requires the document type to declare a `rangeCountable: true` index whose
 * last property is `groupField` (protocol v14+). When Drive rejects the query
 * as unanswerable by the contract's indexes, this returns null so callers can
 * fall back to a scan AND remember not to retry; any other failure (transport
 * blip, unexpected response shape) is thrown, because it says nothing about
 * whether the contract supports the query. Unlike `groupedDocumentCount` there
 * is no per-id fallback — the caller does not know the value set in advance.
 */
export async function rangeDistinctCount(
  sdk: SDK,
  query: { dataContractId: unknown; documentTypeName: string; groupField: string }
): Promise<Map<string, number> | null> {
  let raw: unknown;
  try {
    raw = await sdk.documents.count({
      dataContractId: query.dataContractId,
      documentTypeName: query.documentTypeName,
      where: [[query.groupField, '>', MIN_IDENTIFIER]],
      orderBy: [[query.groupField, 'asc']],
      groupBy: [query.groupField],
    });
  } catch (error) {
    // The index-grammar rejection a contract without the flag produces every
    // time, e.g. "range count requires a `range_countable: true` index whose
    // last property matches the range field" (InvalidArgument).
    const message = error instanceof Error ? error.message : String(error);
    if (/range_countable|non indexed property|invalid argument/i.test(message)) {
      logger.warn('rangeDistinctCount: contract cannot answer this query (caller falls back to scan)', {
        documentTypeName: query.documentTypeName,
        groupField: query.groupField,
        error: message,
      });
      return null;
    }
    throw error;
  }

  const result = new Map<string, number>();
  for (const [key, value] of groupedCountEntries(raw)) {
    if (key === '') continue; // aggregate-mode key; shouldn't appear once groupBy is set
    const id = hexKeyToBase58(key);
    if (!id) {
      throw new Error(`rangeDistinctCount: group key is not a hex identifier: ${key.slice(0, 16)}…`);
    }
    result.set(id, Number(value as bigint | number));
  }
  return result;
}

/**
 * Which of `postIds` appear in the caller's OWN documents of a type indexed
 * uniquely on `$ownerId` + a target field — the "did I like/repost this?" lookup.
 *
 * Queries only the user's own docs. A unique (owner, target) index yields at most
 * one doc per target id, so nothing can truncate. `ownerFirst` selects the
 * where/orderBy ordering to match how the contract declares that index
 * (`true` = [$ownerId, field], `false` = [field, $ownerId]) — and, crucially,
 * also decides whether the whole batch fits in ONE query:
 *
 * Drive treats `in` as a RANGE. A query may only range over the LAST index
 * property it constrains, so `[$ownerId ==, field in [...]]` (repost, bookmark)
 * is a valid single query, while `[field in [...], $ownerId ==]` (like,
 * likeReply) is not — and Drive answers that one with an empty result set rather
 * than an error, which is why it read as "you have not liked anything" instead of
 * as a bug. Verified against both testnet and the moutai devnet: swapping the
 * target's `in` for `==` returns the document every time.
 *
 * So a target-first index is queried once per target, with bounded concurrency.
 *
 * `field` names the identifier property holding the target id. It defaults to
 * `postId`, which is what every v2 doctype uses; the v3 topology's `likeReply`
 * names it `replyId` instead.
 *
 * Returns the set of matching target ids; on error logs `errorLabel` and returns
 * an empty set (fail closed).
 */
export async function queryOwnedPostIds(
  params: {
    getSdk: () => Promise<SDK>;
    dataContractId: unknown;
    documentTypeName: string;
    userId: string;
    postIds: string[];
    ownerFirst: boolean;
    /** Identifier property naming the target. Default: `postId`. */
    field?: string;
    getPostId: (doc: Record<string, unknown>) => string | undefined;
    errorLabel: string;
  }
): Promise<Set<string>> {
  if (params.postIds.length === 0) return new Set();
  const field = params.field ?? 'postId';
  const found = new Set<string>();
  const ownerClause = ['$ownerId', '==', params.userId];
  const ownerOrder = ['$ownerId', 'asc'];
  const postOrder = [field, 'asc'];

  try {
    const sdk = await params.getSdk();

    const collect = async (where: unknown[][], limit: number) => {
      const response = await sdk.documents.query({
        dataContractId: params.dataContractId,
        documentTypeName: params.documentTypeName,
        where,
        orderBy: params.ownerFirst ? [ownerOrder, postOrder] : [postOrder, ownerOrder],
        limit,
      });
      for (const doc of normalizeSDKResponse(response)) {
        const postId = params.getPostId(doc);
        if (postId) found.add(postId);
      }
    };

    if (params.ownerFirst) {
      // One query per 100-id batch: the range sits on the last property, so this
      // is a shape Drive can answer.
      await mapLimit(chunk(params.postIds, MAX_IN_CLAUSE_VALUES), 2, (batch) =>
        collect([ownerClause, [field, 'in', batch]], batch.length)
      );
    } else {
      // Target-first index: equality on both properties, one target at a time.
      await mapLimit(params.postIds, 6, (postId) =>
        collect([[field, '==', postId], ownerClause], 1)
      );
    }

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
