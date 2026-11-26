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
import { documentToPlainObject, requireDocumentIdentifierBytes } from './sdk-helpers';
import { Document, PlatformVersion } from '@dashevo/evo-sdk';
import type { DocumentObject } from '@dashevo/evo-sdk';
import { networkPlatformVersion } from '@/lib/platform-version';
import bs58 from 'bs58';

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

class DocumentBuilderService {
  /**
   * The id a create transition signed with `identityContractNonce` will carry. From
   * protocol 14 it commits to that nonce, so derive it before building the payload.
   */
  async documentIdForCreate(
    contractId: string,
    documentTypeName: string,
    ownerId: string,
    entropy: Uint8Array,
    identityContractNonce: bigint
  ): Promise<string> {
    const platformVersion = networkPlatformVersion(PlatformVersion, await getEvoSdk());
    return bs58.encode(
      Document.generateId(documentTypeName, ownerId, contractId, entropy, identityContractNonce, platformVersion)
    );
  }

  /**
   * Build a Document object for document creation
   *
   * Creates a new WASM Document with the provided data under the id
   * `documentIdForCreate` derived for the transition's nonce.
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
    identity: {
      id: string;
      entropy: Uint8Array;
    }
  ): Promise<InstanceType<typeof Document>> {
    const platformVersion = networkPlatformVersion(PlatformVersion, await getEvoSdk());
    return Document.fromObject(
      toCanonicalDocumentObject({ id: identity.id, ownerId, contractId, documentTypeName, revision: 1, entropy: identity.entropy, data }),
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

}

// Singleton instance
export const documentBuilderService = new DocumentBuilderService();
