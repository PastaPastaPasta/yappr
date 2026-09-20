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
import { documentToPlainObject, requireDocumentIdentifierBytes } from './sdk-helpers';
import { deriveDocumentId } from '@/lib/document-id';
import { Document, PlatformVersion } from '@dashevo/evo-sdk';
import type { DocumentObject } from '@dashevo/evo-sdk';

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
  createdAtMs?: number;
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
    ...(fields.createdAtMs !== undefined ? { $createdAt: BigInt(fields.createdAtMs) } : {}),
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
  /**
   * Build a Document object for document creation.
   *
   * From protocol 14 a new document's id commits to the identity contract
   * nonce of its create transition (`lib/document-id.ts`), so the id is
   * derived HERE from the nonce the caller is about to sign with, never
   * precomputed. The wasm `Document` constructor and `Document.generateId`
   * still return the pre-14 entropy-only id, which consensus now refuses
   * (InvalidDocumentTransitionIdError), so neither is used on this path.
   *
   * @param contractId - The data contract ID
   * @param documentTypeName - The document type name (e.g., 'post', 'profile')
   * @param ownerId - The identity ID that owns this document
   * @param data - The document data fields (`Uint8Array` for binary fields on typed writes)
   * @param identity.entropy - The 32 bytes of entropy the create transition will carry
   * @param identity.identityContractNonce - The nonce the create transition will carry
   * @returns The WASM Document and its base58 id
   */
  async buildDocumentForCreate(
    contractId: string,
    documentTypeName: string,
    ownerId: string,
    data: Record<string, unknown>,
    identity: {
      entropy: Uint8Array;
      identityContractNonce: bigint;
    }
  ): Promise<{ document: InstanceType<typeof Document>; id: string }> {
    // Ensure WASM is initialized before creating objects
    await ensureWasmReady();

    const id = deriveDocumentId({
      contractId,
      ownerId,
      documentTypeName,
      entropy: identity.entropy,
      identityContractNonce: identity.identityContractNonce,
    });

    const document = Document.fromObject(
      toCanonicalDocumentObject({
        id,
        ownerId,
        contractId,
        documentTypeName,
        revision: 1,
        entropy: identity.entropy,
        data,
      }),
      PlatformVersion.current()
    );
    return { document, id };
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
   * Build a fully-populated Document for an indexOnly delete-by-values.
   *
   * An indexOnly doctype has no id-addressable stored row: its index entries
   * ARE the document, and a delete transition must therefore carry every
   * property value plus the consensus `$createdAt` so Drive can locate and
   * remove each entry. Passing this Document into the delete path (rather than
   * the identifier-only shape below) is what selects the from_document /
   * index-only-delete route in the SDK.
   *
   * @param createdAtMs - The like's consensus `$createdAt` (ms). Not knowable
   *   client-side at create time — recovered from a `$createdAt`-carrying index
   *   projection (e.g. `byAuthorTimePost`).
   */
  async buildDocumentForValuesDelete(
    contractId: string,
    documentTypeName: string,
    documentId: string,
    ownerId: string,
    data: Record<string, unknown>,
    createdAtMs: number
  ): Promise<InstanceType<typeof Document>> {
    await ensureWasmReady();

    return Document.fromObject(
      toCanonicalDocumentObject({
        id: documentId,
        ownerId,
        contractId,
        documentTypeName,
        // indexOnly doctypes are documentsMutable: false — revision stays 1.
        revision: 1,
        createdAtMs,
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
}

// Singleton instance
export const documentBuilderService = new DocumentBuilderService();
