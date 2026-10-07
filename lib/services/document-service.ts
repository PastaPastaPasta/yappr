import { logger } from '@/lib/logger';
import { TtlMap } from '@/lib/caches/ttl-map';
import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import { YAPPR_CONTRACT_ID } from '../constants';
import { postOwnerIndexOrderPrefix, postOwnerIndexPrefix, postsHaveLanguage } from '@/lib/contract-topology';
import { documentToPlainObject, queryDocuments, type QueryDocumentsOptions, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers';
import { chunk, mapLimit, MAX_IN_CLAUSE_VALUES, paginateFetchAll, type PaginateFetchResult } from './pagination-utils';

export interface QueryOptions {
  where?: DocumentWhereClause[];
  orderBy?: DocumentOrderByClause[];
  limit?: number;
  startAfter?: string;
  startAt?: string;
}

export interface DocumentResult<T> {
  documents: T[];
  nextCursor?: string;
  prevCursor?: string;
}

/**
 * Query raw documents through the shared document-service path.
 * This keeps the raw `sdk.documents.query(...)` behavior centralized in one layer.
 */
export async function queryRawDocuments(options: QueryDocumentsOptions): Promise<Record<string, unknown>[]> {
  const sdk = await getEvoSdk();
  return queryDocuments(sdk, options);
}

/**
 * How many posts one batch of owners may contribute to a new-posts check.
 * The check covers seconds to minutes, so reaching this is unusual; when it
 * happens the walk is logged and the newest posts read so far are kept.
 */
const NEW_POSTS_BATCH_CAP = 1000;

/** `docs` de-duplicated by `$id`, newest `$createdAt` first, at most `limit`. */
export function newestDistinctDocuments(
  docs: Record<string, unknown>[],
  limit: number
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const doc of docs) {
    const id = doc.$id as string | undefined;
    if (id && !byId.has(id)) byId.set(id, doc);
  }
  return Array.from(byId.values())
    .sort((a, b) => Number(b.$createdAt ?? 0) - Number(a.$createdAt ?? 0))
    .slice(0, limit);
}

/**
 * The newest `limit` posts by any of `ownerIds` created after
 * `sinceTimestamp`. Platform caps `in` at 100 values and the
 * `[$ownerId, $createdAt]` index returns owner by owner, so one capped query
 * would be refused past 100 owners and would drop the newest posts of
 * high-id owners. Instead each batch of at most 100 owners is read to the
 * end, and the limit applies after merging.
 *
 * `complete` is false when a batch stopped early (a continuation page
 * failed, or it reached NEW_POSTS_BATCH_CAP) and kept only the posts read
 * before that: owners later in that batch may have newer posts than some
 * returned, so a caller must not treat the scan as covering everything up
 * to the newest post it got.
 */
export async function queryPostsByOwnersSince(
  ownerIds: string[],
  sinceTimestamp: number,
  limit = 50,
  contractId = YAPPR_CONTRACT_ID
): Promise<{ posts: Record<string, unknown>[]; complete: boolean }> {
  const owners = Array.from(new Set(ownerIds.filter(Boolean)));
  if (owners.length === 0) return { posts: [], complete: true };
  let complete = true;

  const sdk = await getEvoSdk();
  const batches = await mapLimit(chunk(owners, MAX_IN_CLAUSE_VALUES), 3, async (batch) => {
    const query = {
      dataContractId: contractId,
      documentTypeName: 'post',
      // v13's `ownerAndTime` starts at `live`: pin it first (tombstones are not new posts).
      where: [
        ...postOwnerIndexPrefix(),
        ['$ownerId', 'in', batch],
        ['$createdAt', '>', sinceTimestamp],
      ] as DocumentWhereClause[],
      orderBy: [...postOwnerIndexOrderPrefix(), ['$ownerId', 'asc'], ['$createdAt', 'asc']] as DocumentOrderByClause[],
    };
    // Read to the end, collecting as it goes: a continuation that fails keeps
    // the pages already read, so the check never comes back empty for that.
    const read: Record<string, unknown>[] = [];
    try {
      const { reachedLimit } = await paginateFetchAll(sdk, () => ({ ...query }), (doc) => {
        read.push(doc);
        return doc;
      }, { maxResults: NEW_POSTS_BATCH_CAP, inClause: true });
      // Owner-ordered: a capped batch may have left newer posts of later owners unread.
      if (reachedLimit) complete = false;
    } catch (error) {
      if (read.length === 0) throw error;
      complete = false;
      logger.warn('queryPostsByOwnersSince: a continuation page failed; keeping the posts read so far', error);
    }
    return read;
  });

  return { posts: newestDistinctDocuments(batches.flat(), limit), complete };
}

/**
 * The newest-first post timeline after `sinceTimestamp`: the per-language
 * `languageTimeline [language, $createdAt]` where posts carry a language (v2,
 * v9), the one global `timeline [$createdAt]` where they do not (v10, which
 * ignores `language`). An empty `language` drops the language pin.
 */
export function postTimelineClauses(
  language: string,
  sinceTimestamp = 0
): { where: DocumentWhereClause[]; orderBy: DocumentOrderByClause[] } {
  const where: DocumentWhereClause[] = [['$createdAt', '>', sinceTimestamp]];
  const orderBy: DocumentOrderByClause[] = [['$createdAt', 'desc']];

  if (language && postsHaveLanguage()) {
    where.unshift(['language', '==', language]);
    orderBy.unshift(['language', 'asc']);
  }
  return { where, orderBy };
}

/**
 * Query all posts newer than a timestamp.
 */
export async function queryPostsSince(
  sinceTimestamp: number,
  limit = 50,
  language = 'en',
  contractId = YAPPR_CONTRACT_ID
): Promise<Record<string, unknown>[]> {
  const { where, orderBy } = postTimelineClauses(language, sinceTimestamp);

  return queryRawDocuments({
    dataContractId: contractId,
    documentTypeName: 'post',
    where,
    orderBy,
    limit,
  });
}

/**
 * A created document as the service transforms it. Platform stamps
 * `$createdAt` with the block time, so the document a write returns without
 * reading it back (the one it built) has none, and `new Date(undefined)` is
 * an Invalid Date that renders as no time at all. Until a read returns the
 * real one, `startedAt` (when the write began) stands in for it: it is no
 * later than the block time, so a feed's newer-than cursor built from it
 * never skips another post that landed while the write was confirming.
 */
export function withCreationTime(doc: Record<string, unknown>, startedAt: number): Record<string, unknown> {
  return doc.$createdAt == null && doc.createdAt == null ? { ...doc, $createdAt: startedAt } : doc;
}

export abstract class BaseDocumentService<T> {
  protected readonly contractId: string;
  protected readonly documentType: string;
  /** Documents by id, held for two minutes. */
  protected cache = new TtlMap<string, T>(2 * 60 * 1000);

  constructor(documentType: string, contractId?: string) {
    this.contractId = contractId ?? YAPPR_CONTRACT_ID;
    this.documentType = documentType;
  }

  /**
   * Query documents through the raw query path.
   * `where` operands must already use the correct query encoding for each field.
   */
  async query(options: QueryOptions = {}): Promise<DocumentResult<T>> {
    try {
      const sdk = await getEvoSdk();

      logger.debug(`Querying ${this.documentType} documents:`, {
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        ...options
      });

      const rawDocuments = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: options.where,
        orderBy: options.orderBy,
        limit: options.limit,
        startAfter: options.startAfter,
        startAt: options.startAt,
      });

      logger.debug(`${this.documentType} query returned ${rawDocuments.length} documents`);

      const documents = rawDocuments.map(doc => this.transformDocument(doc));

      return {
        documents,
        nextCursor: undefined,
        prevCursor: undefined
      };
    } catch (error) {
      logger.error(`Error querying ${this.documentType} documents:`, error);
      throw error;
    }
  }

  /**
   * Every document matching `options`, walked 100 at a time with `startAfter`
   * (`paginateFetchAll`). `maxResults` bounds the walk (default: none); a
   * walk it stops reports `reachedLimit`. `orderBy` must name an index.
   */
  protected async queryAll(
    options: Pick<QueryOptions, 'where' | 'orderBy'>,
    maxResults = Infinity
  ): Promise<PaginateFetchResult<T>> {
    const sdk = await getEvoSdk();
    return paginateFetchAll(
      sdk,
      () => ({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        ...(options.where && { where: options.where }),
        ...(options.orderBy && { orderBy: options.orderBy }),
      }),
      (doc) => this.transformDocument(doc),
      { maxResults }
    );
  }

  /**
   * Get a single document by ID
   */
  async get(documentId: string): Promise<T | null> {
    try {
      // Check cache
      const cached = this.cache.get(documentId);
      if (cached !== undefined) return cached;

      const sdk = await getEvoSdk();

      const response = await sdk.documents.get(
        this.contractId,
        this.documentType,
        documentId
      );

      if (!response) {
        return null;
      }

      // Normalize zero-arg toObject() output back to the JSON-like shape Yappr expects.
      const docData = documentToPlainObject(response);
      const transformed = this.transformDocument(docData);

      // Cache the result
      this.cache.set(documentId, transformed);

      return transformed;
    } catch (error) {
      logger.error(`Error getting ${this.documentType} document:`, error);
      return null;
    }
  }

  /**
   * Get several documents by ID in one `$id in [...]` query per 100 ids,
   * instead of a `get()` round trip each. Fresh cache entries are served
   * without a query; fetched documents are cached like `get()` caches them.
   * Missing ids are simply absent from the result (order not guaranteed).
   */
  async getMany(documentIds: string[]): Promise<T[]> {
    const uniqueIds = Array.from(new Set(documentIds.filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    const results: T[] = [];
    const uncachedIds: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.cache.get(id);
      if (cached !== undefined) {
        results.push(cached);
      } else {
        uncachedIds.push(id);
      }
    }
    if (uncachedIds.length === 0) return results;

    try {
      const sdk = await getEvoSdk();

      await mapLimit(chunk(uncachedIds, MAX_IN_CLAUSE_VALUES), 2, async (batch) => {
        try {
          // Primary-key in-query: returns exactly the existing documents among
          // `batch` (results arrive in $id byte order; orderBy is optional and
          // omitted). Goes through the same transformDocument path as query().
          const rawDocuments = await queryDocuments(sdk, {
            dataContractId: this.contractId,
            documentTypeName: this.documentType,
            where: [['$id', 'in', batch]],
            limit: batch.length,
          });

          for (const doc of rawDocuments) {
            const transformed = this.transformDocument(doc);
            const id = doc.$id as string | undefined;
            if (id) {
              this.cache.set(id, transformed);
            }
            results.push(transformed);
          }
        } catch (error) {
          // Transport blip: degrade to per-id fetches for just this chunk (same
          // shape as getPostsByIds' fallback) rather than dropping up to 100
          // documents from the result on one failed query.
          logger.warn(`getMany: batched $id-in ${this.documentType} query failed, falling back to per-id fetches:`, error);
          const fetched = await mapLimit(batch, 5, (id) => this.get(id));
          for (const doc of fetched) {
            if (doc !== null) results.push(doc);
          }
        }
      });

      return results;
    } catch (error) {
      logger.error(`Error batch getting ${this.documentType} documents:`, error);
      return results;
    }
  }

  /**
   * Create a new document through the typed `Document` path.
   * Binary fields should already be `Uint8Array` when they reach this layer.
   */
  async create(ownerId: string, data: Record<string, unknown>): Promise<T> {
    return this.createWithOptions(ownerId, data)
  }

  /**
   * `data` may be a function of the new document's id, for content that must
   * commit to the id before the document exists (see
   * `stateTransitionService.createDocument`). From protocol 14 the id is only
   * known once the create transition's nonce is, so this is the ONLY way to
   * learn it ahead of the write.
   */
  async createWithOptions(
    ownerId: string,
    data: Parameters<typeof stateTransitionService.createDocument>[3],
    options?: Parameters<typeof stateTransitionService.createDocument>[4]
  ): Promise<T> {
    try {
      logger.debug(`Creating ${this.documentType} document`);

      const startedAt = Date.now();
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        data,
        options
      );

      if (!result.success || !result.document) {
        throw new Error(result.error || 'Failed to create document');
      }

      // Clear relevant caches
      this.clearCache();

      const transformed = this.transformDocument(withCreationTime(result.document, startedAt));

      // Preserve creation confirmation status for callers that need UX handling.
      if (typeof result.confirmed === 'boolean' && transformed && typeof transformed === 'object') {
        (transformed as Record<string, unknown>).__createConfirmed = result.confirmed;
      }

      return transformed;
    } catch (error) {
      logger.error(`Error creating ${this.documentType} document:`, error);
      throw error;
    }
  }

  /** Transform a plain document object (e.g. a composite sub-result) into `T`. */
  fromDocument(doc: Record<string, unknown>): T {
    return this.transformDocument(doc);
  }

  /**
   * Extract content fields from a transformed document, stripping system metadata.
   * Used to build the full document data for replacements (updates).
   * Subclasses can override for custom extraction logic.
   */
  protected extractContentFields(doc: T): Record<string, unknown> {
    const systemFields = new Set(['id', 'ownerId', 'createdAt', 'updatedAt', 'revision']);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
      // Every platform system field is `$`-prefixed ($id, $revision, $formatVersion, …) and
      // no contract declares a `$` property, so the prefix is enough to filter them all.
      if (!key.startsWith('$') && !systemFields.has(key) && value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Update a document through the typed `Document` replace path.
   * Binary fields should already be `Uint8Array` when they reach this layer.
   */
  async update(documentId: string, ownerId: string, data: Record<string, unknown>): Promise<T> {
    try {
      logger.debug(`Updating ${this.documentType} document ${documentId}:`, data);

      // Clear cache to ensure we get fresh revision from network
      this.cache.delete(documentId);

      // Get current document to find revision and existing data
      const currentDoc = await this.get(documentId);
      if (!currentDoc) {
        throw new Error('Document not found');
      }
      const revision = (currentDoc as Record<string, unknown>).$revision as number || 0;
      logger.debug(`Current revision for ${this.documentType} document ${documentId}: ${revision}`);

      // Merge existing document data with partial update.
      // Document replacement requires ALL fields, not just the changed ones.
      const existingData = this.extractContentFields(currentDoc);
      const mergedData = { ...existingData, ...data };
      // Strip undefined values — they represent intentionally cleared optional fields
      for (const key of Object.keys(mergedData)) {
        if (mergedData[key] === undefined) delete mergedData[key];
      }

      const result = await stateTransitionService.updateDocument(
        this.contractId,
        this.documentType,
        documentId,
        ownerId,
        mergedData,
        revision
      );

      if (!result.success || !result.document) {
        throw new Error(result.error || 'Failed to update document');
      }

      // Clear cache for this document
      this.cache.delete(documentId);

      return this.transformDocument(result.document);
    } catch (error) {
      logger.error(`Error updating ${this.documentType} document:`, error);
      throw error;
    }
  }

  /**
   * Delete a document
   */
  async delete(documentId: string, ownerId: string): Promise<boolean> {
    try {
      logger.debug(`Deleting ${this.documentType} document ${documentId}`);

      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        documentId,
        ownerId
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to delete document');
      }

      // Clear cache
      this.cache.delete(documentId);

      return true;
    } catch (error) {
      logger.error(`Error deleting ${this.documentType} document:`, error);
      return false;
    }
  }

  /**
   * Transform raw document to typed object
   * Override in subclasses for custom transformation
   */
  protected abstract transformDocument(doc: Record<string, unknown>, options?: Record<string, unknown>): T;

  /**
   * Clear cache
   */
  clearCache(documentId?: string): void {
    if (documentId) {
      this.cache.delete(documentId);
    } else {
      this.cache.clear();
    }
  }
}
