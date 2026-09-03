import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import { documentBuilderService } from './document-builder-service';
import { YAPPR_CONTRACT_ID, POST_RECOVERY_POLL_ATTEMPTS, POST_RECOVERY_POLL_ATTEMPTS_ENCRYPTED, POST_RECOVERY_POLL_DELAY_MS } from '../constants';
import { isDefiniteRejectionError, PostCreationIndeterminateError } from '../retry-utils';
import { documentToPlainObject, queryDocuments, type QueryDocumentsOptions, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers';

/**
 * Error thrown when a document create fails, preserving whether the
 * broadcast stage was reached so callers can classify the failure:
 * - `broadcastAttempted === false`: definite failure, safe to retry.
 * - `broadcastAttempted === true`: ambiguous — the state transition may
 *   still commit on Platform; retrying with fresh entropy risks duplicates.
 */
export class DocumentCreateError extends Error {
  readonly documentId?: string;
  readonly broadcastAttempted: boolean;

  constructor(message: string, options: { documentId?: string; broadcastAttempted?: boolean } = {}) {
    super(message);
    this.name = 'DocumentCreateError';
    this.documentId = options.documentId;
    this.broadcastAttempted = options.broadcastAttempted ?? false;
    // Restore prototype chain for environments that transpile class extends
    Object.setPrototypeOf(this, DocumentCreateError.prototype);
  }
}

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
 * Query posts by owner IDs newer than a timestamp.
 */
export async function queryPostsByOwnersSince(
  ownerIds: string[],
  sinceTimestamp: number,
  limit = 50,
  contractId = YAPPR_CONTRACT_ID
): Promise<Record<string, unknown>[]> {
  if (ownerIds.length === 0) return [];

  return queryRawDocuments({
    dataContractId: contractId,
    documentTypeName: 'post',
    where: [
      ['$ownerId', 'in', ownerIds],
      ['$createdAt', '>', sinceTimestamp],
    ],
    orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
    limit,
  });
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
  const where: DocumentWhereClause[] = [['$createdAt', '>', sinceTimestamp]];
  const orderBy: DocumentOrderByClause[] = [['$createdAt', 'desc']];

  if (language) {
    where.unshift(['language', '==', language]);
    orderBy.unshift(['language', 'asc']);
  }

  return queryRawDocuments({
    dataContractId: contractId,
    documentTypeName: 'post',
    where,
    orderBy,
    limit,
  });
}

export abstract class BaseDocumentService<T> {
  protected readonly contractId: string;
  protected readonly documentType: string;
  protected cache: Map<string, { data: T; timestamp: number }> = new Map();
  protected readonly CACHE_TTL = 120000; // 2 minutes cache (reduced query frequency)

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

      logger.info(`Querying ${this.documentType} documents:`, {
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

      logger.info(`${this.documentType} query returned ${rawDocuments.length} documents`);

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
   * Get a single document by ID
   */
  async get(documentId: string): Promise<T | null> {
    try {
      // Check cache
      const cached = this.cache.get(documentId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.data;
      }

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
      this.cache.set(documentId, {
        data: transformed,
        timestamp: Date.now()
      });

      return transformed;
    } catch (error) {
      logger.error(`Error getting ${this.documentType} document:`, error);
      return null;
    }
  }

  /**
   * Create a new document through the typed `Document` path.
   * Binary fields should already be `Uint8Array` when they reach this layer.
   */
  async create(ownerId: string, data: Record<string, unknown>): Promise<T> {
    return this.createWithOptions(ownerId, data)
  }

  async createWithOptions(
    ownerId: string,
    data: Record<string, unknown>,
    options?: {
      documentId?: string;
      entropy?: Uint8Array;
    }
  ): Promise<T> {
    try {
      logger.info(`Creating ${this.documentType} document:`, data);

      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        data,
        options
      );

      if (!result.success || !result.document) {
        throw new DocumentCreateError(result.error || 'Failed to create document', {
          documentId: result.documentId ?? options?.documentId,
          broadcastAttempted: result.broadcastAttempted,
        });
      }

      // Clear relevant caches
      this.clearCache();

      const transformed = this.transformDocument(result.document);

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

  /**
   * Create a document with recovery from ambiguous broadcast failures.
   *
   * The document ID is generated deterministically BEFORE broadcasting
   * (from ownerId + contractId + documentType + entropy). If the create
   * fails after the broadcast stage with an ambiguous error (timeout,
   * gateway 5xx, "tenderdash not available", ...), the transition may still
   * have committed — so we poll Platform for that exact document ID instead
   * of rebroadcasting a new document.
   *
   * Outcomes:
   * - Success: the created (or recovered) document.
   * - Definite failure (pre-broadcast, or a hard rejection): original error
   *   is rethrown; retrying is safe.
   * - Ambiguous failure with no recovery: PostCreationIndeterminateError is
   *   thrown. It is non-retryable — rebroadcasting would create a NEW
   *   document with fresh entropy (and a fresh nonce for encrypted content),
   *   risking duplicates if the original transition later commits.
   */
  protected async createWithAmbiguityRecovery(ownerId: string, data: Record<string, unknown>): Promise<T> {
    const { id: documentId, entropy } = await documentBuilderService.generateDocumentIdentity(
      this.contractId,
      this.documentType,
      ownerId
    );

    try {
      return await this.createWithOptions(ownerId, data, { documentId, entropy });
    } catch (error) {
      const broadcastAttempted = error instanceof DocumentCreateError && error.broadcastAttempted;
      // Once a broadcast has been attempted, DEFAULT to treating the failure
      // as ambiguous: only errors that prove Platform rejected the transition
      // (validation/consensus rejections) are definite. An unrecognized error
      // message must not be allowed to invite a retry — a rebroadcast with
      // fresh entropy would duplicate the document if the original commits.
      if (broadcastAttempted && !isDefiniteRejectionError(error)) {
        logger.warn(`${this.documentType} create failed ambiguously — polling for document ${documentId}`);
        // Encrypted documents get a longer recovery window: their ciphertext
        // is not queryable, so the compose duplicate pre-check cannot protect
        // against a manual re-post. If the user retries anyway, the content is
        // re-encrypted with a fresh nonce and the duplicate cannot be detected
        // at all — finding the original here is the only safety net.
        const attempts = data.encryptedContent
          ? POST_RECOVERY_POLL_ATTEMPTS_ENCRYPTED
          : POST_RECOVERY_POLL_ATTEMPTS;
        const recovered = await this.pollForCreatedDocument(documentId, attempts);
        if (recovered) {
          logger.info(`Recovered ${this.documentType} ${documentId} after ambiguous create error`);
          this.clearCache();
          return recovered;
        }
        logger.warn(`Could not confirm ${this.documentType} ${documentId} — surfacing indeterminate outcome`);
        throw new PostCreationIndeterminateError(this.documentType, documentId, error);
      }
      throw error;
    }
  }

  /**
   * Poll Platform for a document by its exact ID after an ambiguous
   * create failure. Returns null if it never becomes visible.
   */
  private async pollForCreatedDocument(documentId: string, maxAttempts: number): Promise<T | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, POST_RECOVERY_POLL_DELAY_MS));
      }
      // get() returns null on lookup errors, so a flaky network during
      // recovery degrades to the indeterminate outcome rather than throwing.
      const document = await this.get(documentId);
      if (document) {
        return document;
      }
    }
    return null;
  }

  /**
   * Extract content fields from a transformed document, stripping system metadata.
   * Used to build the full document data for replacements (updates).
   * Subclasses can override for custom extraction logic.
   */
  protected extractContentFields(doc: T): Record<string, unknown> {
    const systemFields = new Set([
      'id', 'ownerId', 'createdAt', 'updatedAt',
      '$id', '$ownerId', '$createdAt', '$updatedAt', '$revision', '$type', 'revision',
    ]);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
      if (!systemFields.has(key) && value !== undefined) {
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
      logger.info(`Updating ${this.documentType} document ${documentId}:`, data);

      // Clear cache to ensure we get fresh revision from network
      this.cache.delete(documentId);

      // Get current document to find revision and existing data
      const currentDoc = await this.get(documentId);
      if (!currentDoc) {
        throw new Error('Document not found');
      }
      const revision = (currentDoc as Record<string, unknown>).$revision as number || 0;
      logger.info(`Current revision for ${this.documentType} document ${documentId}: ${revision}`);

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
      logger.info(`Deleting ${this.documentType} document ${documentId}`);

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

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of Array.from(this.cache.entries())) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }
}
