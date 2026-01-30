import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import { YAPPR_CONTRACT_ID } from '../constants';
import { queryDocuments, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers';

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
   * Query documents
   */
  async query(options: QueryOptions = {}): Promise<DocumentResult<T>> {
    try {
      const sdk = await getEvoSdk();

      console.log(`Querying ${this.documentType} documents:`, {
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

      console.log(`${this.documentType} query returned ${rawDocuments.length} documents`);

      const documents = rawDocuments.map(doc => this.transformDocument(doc));

      return {
        documents,
        nextCursor: undefined,
        prevCursor: undefined
      };
    } catch (error) {
      console.error(`Error querying ${this.documentType} documents:`, error);
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

      // Document has toJSON method
      const doc = response as { toJSON?: () => Record<string, unknown> };
      const docData = typeof doc.toJSON === 'function' ? doc.toJSON() : response as Record<string, unknown>;
      const transformed = this.transformDocument(docData);

      // Cache the result
      this.cache.set(documentId, {
        data: transformed,
        timestamp: Date.now()
      });

      return transformed;
    } catch (error) {
      console.error(`Error getting ${this.documentType} document:`, error);
      return null;
    }
  }

  /**
   * Create a new document
   */
  async create(ownerId: string, data: Record<string, unknown>): Promise<T> {
    try {
      console.log(`Creating ${this.documentType} document:`, data);

      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        data
      );

      if (!result.success || !result.document) {
        throw new Error(result.error || 'Failed to create document');
      }

      // Clear relevant caches
      this.clearCache();

      return this.transformDocument(result.document);
    } catch (error) {
      console.error(`Error creating ${this.documentType} document:`, error);
      throw error;
    }
  }

  /**
   * Update a document
   */
  async update(documentId: string, ownerId: string, data: Record<string, unknown>): Promise<T> {
    try {
      console.log(`Updating ${this.documentType} document ${documentId}:`, data);

      // Clear cache to ensure we get fresh revision from network
      this.cache.delete(documentId);

      // Get current document to find revision
      const currentDoc = await this.get(documentId);
      if (!currentDoc) {
        throw new Error('Document not found');
      }
      const revision = (currentDoc as Record<string, unknown>).$revision as number || 0;
      console.log(`Current revision for ${this.documentType} document ${documentId}: ${revision}`);

      const result = await stateTransitionService.updateDocument(
        this.contractId,
        this.documentType,
        documentId,
        ownerId,
        data,
        revision
      );

      if (!result.success || !result.document) {
        throw new Error(result.error || 'Failed to update document');
      }

      // Clear cache for this document
      this.cache.delete(documentId);

      return this.transformDocument(result.document);
    } catch (error) {
      console.error(`Error updating ${this.documentType} document:`, error);
      throw error;
    }
  }

  /**
   * Delete a document
   */
  async delete(documentId: string, ownerId: string): Promise<boolean> {
    try {
      console.log(`Deleting ${this.documentType} document ${documentId}`);

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
      console.error(`Error deleting ${this.documentType} document:`, error);
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
