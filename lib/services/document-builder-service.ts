/**
 * Document Builder Service - Builds WASM Document objects for the typed state transition API
 *
 * This service provides utilities for constructing Document objects
 * for use with the new typed state transition APIs in @dashevo/evo-sdk
 *
 * The new API requires Document WASM objects instead of plain data objects.
 * Binary properties on this path should stay as `Uint8Array`; this layer does not convert them
 * into JSON-style `number[]`.
 *
 * IMPORTANT: We import the Document class from @dashevo/evo-sdk which re-exports
 * from the shared @dashevo/wasm-sdk module. By calling getEvoSdk() first, we ensure
 * the WASM module is initialized before creating any Document objects.
 */
import { getEvoSdk } from './evo-sdk-service';
import { documentToPlainObject, identifierToBase58, requireDocumentIdentifierBytes } from './sdk-helpers';
import { Document, PlatformVersion } from '@dashevo/evo-sdk';
import type { DocumentObject } from '@dashevo/evo-sdk';
import { networkPlatformVersion } from '@/lib/platform-version';
import bs58 from 'bs58';

/**
 * Ensure WASM module is initialized by connecting SDK
 * This guarantees the shared WASM module is ready before creating objects
 */
async function ensureWasmReady(): Promise<void> {
  await getEvoSdk();
}

/**
 * The tagged object `Document.fromObject` takes. The `Document` constructor
 * turns `Uint8Array` properties into integer arrays on wasm-sdk 4.1+, which
 * Platform refuses ("not a byte"), so writes build through `fromObject`.
 */
function toCanonicalDocumentObject(fields: {
  id: string;
  ownerId: string;
  contractId: string;
  documentTypeName: string;
  revision: number;
  entropy?: Uint8Array;
  data: Record<string, unknown>;
}): DocumentObject {
  return {
    $formatVersion: '0',
    $id: requireDocumentIdentifierBytes(fields.id, 'document id'),
    $ownerId: requireDocumentIdentifierBytes(fields.ownerId, 'ownerId'),
    $dataContractId: requireDocumentIdentifierBytes(fields.contractId, 'dataContractId'),
    $type: fields.documentTypeName,
    $revision: BigInt(fields.revision),
    ...(fields.entropy ? { $entropy: fields.entropy } : {}),
    ...fields.data,
  } as unknown as DocumentObject;
}

/**
 * The entropy-only id the `Document` constructor used to assign. From protocol 14
 * a create's real id also commits to its identity contract nonce, and
 * `DocumentCreateTransition` derives and writes it back when signing. This id
 * only keys the pending-transition cache before the nonce is read, so it uses
 * the pre-14 derivation, which needs no nonce.
 */
const PROVISIONAL_ID_VERSION = 13;

function provisionalDocumentId(documentTypeName: string, ownerId: string, contractId: string, entropy: Uint8Array): string {
  return bs58.encode(
    Document.generateId(documentTypeName, ownerId, contractId, entropy, null, new PlatformVersion(PROVISIONAL_ID_VERSION))
  );
}

class DocumentBuilderService {
  async generateDocumentIdentity(
    contractId: string,
    documentTypeName: string,
    ownerId: string
  ): Promise<{ id: string; entropy: Uint8Array }> {
    await ensureWasmReady();

    const entropy = crypto.getRandomValues(new Uint8Array(32));

    return {
      id: provisionalDocumentId(documentTypeName, ownerId, contractId, entropy),
      entropy,
    };
  }

  /**
   * Build a Document object for document creation
   *
   * Creates a new WASM Document with the provided data. The document ID
   * will be generated automatically based on entropy.
   *
   * @param contractId - The data contract ID
   * @param documentTypeName - The document type name (e.g., 'post', 'profile')
   * @param ownerId - The identity ID that owns this document
   * @param data - The document data fields (`Uint8Array` for binary fields on typed writes)
   * @returns A WASM Document object ready for creation
   */
  async buildDocumentForCreate(
    contractId: string,
    documentTypeName: string,
    ownerId: string,
    data: Record<string, unknown>,
    options?: {
      id?: string;
      entropy?: Uint8Array;
    }
  ): Promise<InstanceType<typeof Document>> {
    const platformVersion = networkPlatformVersion(PlatformVersion, await getEvoSdk());
    const entropy = options?.entropy ?? crypto.getRandomValues(new Uint8Array(32));
    const id = options?.id ?? provisionalDocumentId(documentTypeName, ownerId, contractId, entropy);

    return Document.fromObject(
      toCanonicalDocumentObject({ id, ownerId, contractId, documentTypeName, revision: 1, entropy, data }),
      platformVersion
    );
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
   * @param data - The updated document data fields (`Uint8Array` for binary fields on typed writes)
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
    const platformVersion = networkPlatformVersion(PlatformVersion, await getEvoSdk());

    return Document.fromObject(
      toCanonicalDocumentObject({ id: documentId, ownerId, contractId, documentTypeName, revision: newRevision, data }),
      platformVersion
    );
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
    // Check if it's a WASM Document and extract its JSON-like normalized form.
    if (document && typeof (document as Document).toObject === 'function') {
      return documentToPlainObject(document);
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
    // Fallback: convert via toObject() and extract the id field
    const obj = document.toObject() as { $id?: unknown };
    if (obj.$id) {
      const rawId = obj.$id;
      if (typeof rawId === 'string') return rawId;
      const base58 = identifierToBase58(rawId);
      if (base58) return base58;
    }
    throw new Error('Unable to extract document ID from Document object');
  }
}

// Singleton instance
export const documentBuilderService = new DocumentBuilderService();
