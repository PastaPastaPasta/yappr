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
 *
 * BINARY FIELDS: documents are assembled with `Document.fromObject`, never with
 * `new Document({ properties })`. The constructor converts its `properties` through JSON
 * (`Uint8Array` → array of numbers), and since wasm-sdk 4.1 those arrays stay
 * `Value::Array` of `Value::U64` instead of collapsing back into `Value::Bytes`. Drive then
 * rejects the write with "structure error: not an array of bytes", which breaks every
 * document type with a byteArray/identifier field. `fromObject` uses the byte-preserving
 * converter, so `Uint8Array` properties survive as `Value::Bytes`.
 */
import { getEvoSdk } from './evo-sdk-service';
import { documentToPlainObject, identifierToBase58, requireDocumentIdentifierBytes } from './sdk-helpers';
import { Document, PlatformVersion } from '@dashevo/evo-sdk';
import type { DocumentObject } from '@dashevo/evo-sdk';
import bs58 from 'bs58';

/**
 * Assemble the canonical tagged object shape `Document.fromObject` expects.
 *
 * `$formatVersion` is mandatory on wasm-sdk 4.1+ and ignored by 4.0, and the identifier
 * fields are passed as raw bytes because that is the one form both accept — 4.0 rejects
 * base58 strings, and every version rejects `Identifier` instances even though the
 * generated `DocumentObject` type asks for them (hence the cast below).
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
  const canonical: Record<string, unknown> = {
    $formatVersion: '0',
    $id: requireDocumentIdentifierBytes(fields.id, 'document id'),
    $ownerId: requireDocumentIdentifierBytes(fields.ownerId, 'ownerId'),
    $dataContractId: requireDocumentIdentifierBytes(fields.contractId, 'dataContractId'),
    $type: fields.documentTypeName,
    $revision: BigInt(fields.revision),
    ...(fields.entropy ? { $entropy: fields.entropy } : {}),
    ...fields.data,
  };

  return canonical as unknown as DocumentObject;
}

/**
 * Ensure WASM module is initialized by connecting SDK
 * This guarantees the shared WASM module is ready before creating objects
 */
async function ensureWasmReady(): Promise<void> {
  await getEvoSdk();
}

class DocumentBuilderService {
  async generateDocumentIdentity(
    contractId: string,
    documentTypeName: string,
    ownerId: string
  ): Promise<{ id: string; entropy: Uint8Array }> {
    await ensureWasmReady();

    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const idBytes = Document.generateId(documentTypeName, ownerId, contractId, entropy);

    return {
      id: bs58.encode(idBytes),
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
    // Ensure WASM is initialized before creating objects
    await ensureWasmReady();

    // The constructor generated missing entropy and derived the id from it; `fromObject`
    // takes both as given, so fill them in the same way here.
    const entropy = options?.entropy ?? crypto.getRandomValues(new Uint8Array(32));
    const id = options?.id ?? bs58.encode(
      Document.generateId(documentTypeName, ownerId, contractId, entropy)
    );

    return Document.fromObject(
      toCanonicalDocumentObject({
        id,
        ownerId,
        contractId,
        documentTypeName,
        revision: 1,
        entropy,
        data,
      }),
      PlatformVersion.current()
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
    // Ensure WASM is initialized before creating objects
    await ensureWasmReady();

    // Replacements keep the existing id and carry no entropy — only creates need it.
    return Document.fromObject(
      toCanonicalDocumentObject({
        id: documentId,
        ownerId,
        contractId,
        documentTypeName,
        revision: newRevision,
        data,
      }),
      PlatformVersion.current()
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
