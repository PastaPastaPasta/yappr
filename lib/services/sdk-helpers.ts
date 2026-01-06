/**
 * SDK helper utilities for working with the v3 EvoSDK
 *
 * The v3 SDK returns Map<Identifier, Document> from queries.
 * This helper converts that to a simple array of document data.
 */

import type { EvoSDK } from '@dashevo/evo-sdk';
import type {
  DocumentsQuery,
  DocumentWhereClause,
  DocumentOrderByClause,
} from '@dashevo/wasm-sdk';
import bs58 from 'bs58';

export type { DocumentWhereClause, DocumentOrderByClause };

/**
 * Convert any identifier value to a base58 string.
 *
 * SDK v3 toJSON() returns different formats:
 * - System fields ($id, $ownerId): base58 strings
 * - Byte array fields (postId, replyToPostId, etc): base64 strings
 *
 * This function normalizes both to base58 for consistent handling.
 */
export function identifierToBase58(value: unknown): string | null {
  if (!value) return null;

  // Already a string - try various formats
  if (typeof value === 'string') {
    // First try as base58
    try {
      const decoded = bs58.decode(value);
      return bs58.encode(decoded);
    } catch {
      // Not valid base58
    }

    // Try as base64 (SDK v3 returns base64 for byte array fields)
    if (value.includes('+') || value.includes('/') || value.endsWith('=')) {
      try {
        const bytes = base64ToBytes(value);
        if (bytes.length === 32) { // Identifiers are 32 bytes
          return bs58.encode(bytes);
        }
      } catch {
        // Not valid base64
      }
    }

    // Try as hex (64 hex chars = 32 bytes)
    if (/^[0-9a-fA-F]+$/.test(value) && value.length === 64) {
      try {
        const bytes = hexToBytes(value);
        return bs58.encode(bytes);
      } catch {
        // Not valid hex
      }
    }

    return null;
  }

  // Uint8Array
  if (value instanceof Uint8Array) {
    return bs58.encode(value);
  }

  // Number array (from JSON serialization of byte arrays)
  if (Array.isArray(value) && value.every(n => typeof n === 'number')) {
    return bs58.encode(new Uint8Array(value));
  }

  // Identifier object from SDK (has toBuffer or bytes method)
  const obj = value as { toBuffer?: () => Uint8Array; bytes?: Uint8Array; toJSON?: () => unknown };
  if (typeof obj.toBuffer === 'function') {
    return bs58.encode(obj.toBuffer());
  }
  if (obj.bytes instanceof Uint8Array) {
    return bs58.encode(obj.bytes);
  }

  // Try toJSON which might return bytes
  if (typeof obj.toJSON === 'function') {
    const json = obj.toJSON();
    if (json instanceof Uint8Array) {
      return bs58.encode(json);
    }
    if (Array.isArray(json) && json.every(n => typeof n === 'number')) {
      return bs58.encode(new Uint8Array(json));
    }
  }

  return null;
}

/**
 * Convert a base58 string to Uint8Array for SDK queries
 * Returns null if the value is invalid
 */
export function base58ToBytes(value: string): Uint8Array | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return bs58.decode(value);
  } catch {
    return null;
  }
}

/**
 * Convert an array of identifier strings to array of Uint8Array
 * For use in 'in' queries on system identifier fields ($id, $ownerId)
 * Handles base58, base64, and hex formats. Filters out invalid values.
 */
export function base58ArrayToBytes(values: string[]): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (const v of values) {
    if (!v || typeof v !== 'string') continue;

    // Try base58 first
    try {
      result.push(bs58.decode(v));
      continue;
    } catch {
      // Not base58
    }

    // Try base64 (SDK v3 sometimes returns identifiers as base64)
    if (v.includes('+') || v.includes('/') || v.endsWith('=')) {
      try {
        const bytes = base64ToBytes(v);
        if (bytes.length === 32) {
          result.push(bytes);
          continue;
        }
      } catch {
        // Not base64
      }
    }

    // Try hex
    if (/^[0-9a-fA-F]+$/.test(v) && v.length === 64) {
      try {
        result.push(hexToBytes(v));
        continue;
      } catch {
        // Not hex
      }
    }

    console.warn('sdk-helpers: Unrecognized identifier format skipped:', v.substring(0, 20) + '...');
  }
  return result;
}

/**
 * Convert hex string to bytes
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert base64 string to bytes
 */
function base64ToBytes(base64: string): Uint8Array {
  // Handle both browser and Node.js environments
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } else {
    // Node.js fallback
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
}

export interface QueryDocumentsOptions {
  dataContractId: string;
  documentTypeName: string;
  where?: DocumentWhereClause[];
  orderBy?: DocumentOrderByClause[];
  limit?: number;
  startAfter?: string;
  startAt?: string;
}

/**
 * Query documents and return as an array of plain objects
 * Handles the v3 SDK Map response format
 */
export async function queryDocuments(
  sdk: EvoSDK,
  options: QueryDocumentsOptions
): Promise<Record<string, unknown>[]> {
  const query: DocumentsQuery = {
    dataContractId: options.dataContractId,
    documentTypeName: options.documentTypeName,
  };

  if (options.where) {
    query.where = options.where;
  }
  if (options.orderBy) {
    query.orderBy = options.orderBy;
  }
  if (options.limit) {
    query.limit = options.limit;
  }
  if (options.startAfter) {
    query.startAfter = options.startAfter;
  }
  if (options.startAt) {
    query.startAt = options.startAt;
  }

  const response = await sdk.documents.query(query);

  return mapToDocumentArray(response);
}

/**
 * Convert SDK Map response to array of document data
 */
export function mapToDocumentArray(
  response: Map<unknown, unknown>
): Record<string, unknown>[] {
  const documents: Record<string, unknown>[] = [];
  const values = Array.from(response.values());

  for (const doc of values) {
    if (doc) {
      // Document has a toJSON method that returns the plain object
      const data = typeof (doc as { toJSON?: () => unknown }).toJSON === 'function'
        ? (doc as { toJSON: () => unknown }).toJSON()
        : doc;
      documents.push(data as Record<string, unknown>);
    }
  }

  return documents;
}
