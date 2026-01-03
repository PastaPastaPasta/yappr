import { getEvoSdk, evoSdkService } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import { YAPPR_CONTRACT_ID } from '../constants';

export interface QueryOptions {
  where?: Array<[string, string, any]>;
  orderBy?: Array<[string, 'asc' | 'desc']>;
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

  constructor(documentType: string) {
    this.contractId = YAPPR_CONTRACT_ID;
    this.documentType = documentType;
  }

  /**
   * Query documents
   */
  async query(options: QueryOptions = {}): Promise<DocumentResult<T>> {
    try {
      const sdk = await getEvoSdk();

      // Build query params for EvoSDK facade
      const queryParams: {
        contractId: string;
        type: string;
        where?: unknown;
        orderBy?: unknown;
        limit?: number;
        startAfter?: string;
        startAt?: string;
      } = {
        contractId: this.contractId,
        type: this.documentType,
      };

      if (options.where) {
        queryParams.where = options.where;
      }

      if (options.orderBy) {
        queryParams.orderBy = options.orderBy;
      }

      if (options.limit) {
        queryParams.limit = options.limit;
      }

      if (options.startAfter) {
        queryParams.startAfter = options.startAfter;
      } else if (options.startAt) {
        queryParams.startAt = options.startAt;
      }

      console.log(`Querying ${this.documentType} documents:`, queryParams);

      // Use EvoSDK documents facade
      const response = await sdk.documents.query(queryParams);

      // get_documents returns an object directly, not JSON string
      let result = response;
      
      // Handle different response formats
      if (response && typeof response.toJSON === 'function') {
        result = response.toJSON();
      }
      
      console.log(`${this.documentType} query result:`, result);
      console.log(`${this.documentType} result type:`, typeof result);
      console.log(`${this.documentType} result keys:`, result ? Object.keys(result) : 'null');
      
      // Check if result is an array (direct documents response)
      if (Array.isArray(result)) {
        console.log(`${this.documentType} result is array, transforming...`);
        const documents = result.map((doc: any) => {
          console.log(`Transforming ${this.documentType} document:`, doc);
          return this.transformDocument(doc);
        });

        return {
          documents,
          nextCursor: undefined,
          prevCursor: undefined
        };
      }

      // Otherwise expect object with documents property
      const documents = result?.documents?.map((doc: any) => {
        console.log(`Transforming ${this.documentType} document:`, doc);
        return this.transformDocument(doc);
      }) || [];
      
      return {
        documents,
        nextCursor: result?.nextCursor,
        prevCursor: result?.prevCursor
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

      // Use EvoSDK documents facade
      const response = await sdk.documents.get(
        this.contractId,
        this.documentType,
        documentId
      );

      if (!response) {
        return null;
      }

      // get_document returns an object directly
      const doc = response;
      const transformed = this.transformDocument(doc);

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
  async create(ownerId: string, data: any): Promise<T> {
    try {
      const sdk = await getEvoSdk();
      
      console.log(`Creating ${this.documentType} document:`, data);
      
      // Use state transition service for document creation
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        data
      );
      
      if (!result.success) {
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
  async update(documentId: string, ownerId: string, data: any): Promise<T> {
    try {
      const sdk = await getEvoSdk();
      
      console.log(`Updating ${this.documentType} document ${documentId}:`, data);
      
      // Get current document to find revision
      const currentDoc = await this.get(documentId);
      if (!currentDoc) {
        throw new Error('Document not found');
      }
      const revision = (currentDoc as any).$revision || 0;
      
      // Use state transition service for document update
      const result = await stateTransitionService.updateDocument(
        this.contractId,
        this.documentType,
        documentId,
        ownerId,
        data,
        revision
      );
      
      if (!result.success) {
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
      const sdk = await getEvoSdk();
      
      console.log(`Deleting ${this.documentType} document ${documentId}`);
      
      // Use state transition service for document deletion
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
  protected abstract transformDocument(doc: any): T;

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