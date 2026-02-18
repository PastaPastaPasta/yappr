/**
 * Document Builder Service - Builds WASM Document objects for the typed state transition API
 *
 * This service provides utilities for constructing Document objects
 * for use with the new typed state transition APIs in @dashevo/evo-sdk
 *
 * The new API requires Document WASM objects instead of plain data objects.
 *
 * IMPORTANT: We import the Document class from @dashevo/evo-sdk which re-exports
 * from the shared @dashevo/wasm-sdk module. By calling getEvoSdk() first, we ensure
 * the WASM module is initialized before creating any Document objects.
 */
import { getEvoSdk } from './evo-sdk-service';
import { Document } from '@dashevo/evo-sdk';

/**
 * Ensure WASM module is initialized by connecting SDK
 * This guarantees the shared WASM module is ready before creating objects
 */
async function ensureWasmReady(): Promise<void> {
  await getEvoSdk();
}

class DocumentBuilderService {
  /**
   * Build a Document object for document creation
   *
   * Creates a new WASM Document with the provided data. The document ID
   * will be generated automatically based on entropy.
   *
   * @param contractId - The data contract ID
   * @param documentTypeName - The document type name (e.g., 'post', 'profile')
   * @param ownerId - The identity ID that owns this document
   * @param data - The document data fields
   * @returns A WASM Document object ready for creation
   */
  async buildDocumentForCreate(
    contractId: string,
    documentTypeName: string,
    ownerId: string,
    data: Record<string, unknown>
  ): Promise<InstanceType<typeof Document>> {
    // Ensure WASM is initialized before creating objects
    await ensureWasmReady();

    // v3.1: Document constructor takes a single DocumentOptions object
    const document = new Document({
      properties: data,
      documentTypeName,
      dataContractId: contractId,
      ownerId,
      revision: BigInt(1),
      // id omitted = auto-generated from entropy
    });

    return document;
  }

  /**
   * Build a Document object for document replacement (update)
   *
   * Creates a WASM Document with updated data for replacing an existing document.
   * The revision must be incremented from the current revision.
   *
   * @param contractId - The data contract ID
   * @param documentTypeName - The document type name
   * @param documentId - The existing document's ID
   * @param ownerId - The identity ID that owns this document
   * @param data - The updated document data fields
   * @param newRevision - The new revision number (current revision + 1)
   * @returns A WASM Document object ready for replacement
   */
  async buildDocumentForReplace(
    contractId: string,
    documentTypeName: string,
    documentId: string,
    ownerId: string,
    data: Record<string, unknown>,
    newRevision: number
  ): Promise<InstanceType<typeof Document>> {
    // Ensure WASM is initialized before creating objects
    await ensureWasmReady();

    // v3.1: Document constructor takes a single DocumentOptions object
    const document = new Document({
      properties: data,
      documentTypeName,
      dataContractId: contractId,
      ownerId,
      revision: BigInt(newRevision),
      id: documentId,
    });

    return document;
  }

  /**
   * Build a document identifier object for deletion
   *
   * For delete operations, we can use either a full Document object
   * or a simple object with the identifying fields. This method creates
   * the simpler object format.
   *
   * @param contractId - The data contract ID
   * @param documentTypeName - The document type name
   * @param documentId - The document ID to delete
   * @param ownerId - The identity ID that owns this document
   * @returns An object with document identifiers for deletion
   */
  buildDocumentForDelete(
    contractId: string,
    documentTypeName: string,
    documentId: string,
    ownerId: string
  ): {
    id: string;
    ownerId: string;
    dataContractId: string;
    documentTypeName: string;
  } {
    return {
      id: documentId,
      ownerId: ownerId,
      dataContractId: contractId,
      documentTypeName: documentTypeName,
    };
  }

  /**
   * Extract document info from a WASM Document or query result
   *
   * Normalizes document data from various SDK response formats.
   *
   * @param document - A WASM Document or document-like object
   * @returns Normalized document data with $ prefixed fields
   */
  normalizeDocumentResponse(document: Document | Record<string, unknown>): Record<string, unknown> {
    // Check if it's a WASM Document with toJSON method
    if (document && typeof (document as Document).toJSON === 'function') {
      return (document as Document).toJSON();
    }

    // Handle raw objects - normalize field names
    const raw = document as Record<string, unknown>;
    return {
      $id: raw.$id ?? raw.id,
      $ownerId: raw.$ownerId ?? raw.ownerId,
      $dataContractId: raw.$dataContractId ?? raw.dataContractId,
      $type: raw.$type ?? raw.documentTypeName,
      $revision: raw.$revision ?? raw.revision,
      $createdAt: raw.$createdAt ?? raw.createdAt,
      $updatedAt: raw.$updatedAt ?? raw.updatedAt,
      ...Object.fromEntries(
        Object.entries(raw).filter(([key]) =>
          !['$id', 'id', '$ownerId', 'ownerId', '$dataContractId', 'dataContractId',
            '$type', 'documentTypeName', '$revision', 'revision',
            '$createdAt', 'createdAt', '$updatedAt', 'updatedAt'].includes(key)
        )
      ),
    };
  }

  /**
   * Get the document ID from a newly created document
   *
   * After calling documentCreate, the document object has its ID populated.
   * This helper extracts the ID in string format.
   *
   * @param document - The WASM Document after creation
   * @returns The document ID as a string
   */
  getDocumentId(document: Document): string {
    // The document.id property returns an Identifier which can be converted to string
    const id = document.id;
    if (typeof id === 'string') {
      return id;
    }
    if (id && typeof (id as { toString?: () => string }).toString === 'function') {
      return (id as { toString: () => string }).toString();
    }
    // Fallback: try to get from JSON
    const json = document.toJSON();
    return json.$id || '';
  }
}

// Singleton instance
export const documentBuilderService = new DocumentBuilderService();
