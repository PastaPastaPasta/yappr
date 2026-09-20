/**
 * Document id derivation for Dash Platform protocol 14 (4.2.0-beta.3+).
 *
 * From `generate_document_id` v1 (dashpay/platform#4859) a new document's id
 * commits to the identity contract nonce of its create transition:
 *
 *   dsha256("dash:document-id:v1" || contractId || ownerId || typeName(utf8) || entropy || nonce as u64 BE)
 *
 * Consensus recomputes the id for every create and refuses a mismatch with
 * `InvalidDocumentTransitionIdError` (10405). The wasm-dpp2 `Document`
 * constructor and `Document.generateId` still return the entropy-only v0 id and
 * `new DocumentCreateTransition({ document })` copies `document.id` verbatim, so
 * every create Yappr signs by hand must carry an id derived HERE, from the nonce
 * the transition is about to use.
 *
 * Consequences the callers live with:
 *  - the id exists only once the nonce is assigned, and changes if the
 *    transition is rebuilt with another nonce;
 *  - a nonce is consumed at most once per identity and contract, so an id can
 *    be produced at most once — a deleted document can never be re-created
 *    under its old id.
 *
 * `scripts/seed/seed-lib.mjs` carries the same derivation for the Node seeders
 * (they cannot import this TypeScript module); both are pinned to the platform's
 * test vector (`PINNED_V1_ID` in rs-dpp `generate_document_id.rs`).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import bs58 from 'bs58'

const utf8 = new TextEncoder()
const DOCUMENT_ID_V1_DOMAIN_TAG = utf8.encode('dash:document-id:v1')

/**
 * DIP-30: an identity contract nonce is a u64 whose lower 40 bits are the
 * sequence number; the upper 24 bits are the missing-revision bitset Platform
 * reports back and a client must never echo.
 */
const NONCE_SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1)

/**
 * The nonce the next transition against a contract must carry, from the value
 * `getIdentityContractNonce` returned (`undefined` when the identity has never
 * written to the contract).
 */
export function nextIdentityContractNonce(current: bigint | undefined | null): bigint {
  return ((current ?? BigInt(0)) & NONCE_SEQUENCE_MASK) + BigInt(1)
}

export interface DocumentIdInputs {
  /** Data contract id, base58 or 32 raw bytes. */
  contractId: string | Uint8Array
  /** Owner identity id, base58 or 32 raw bytes. */
  ownerId: string | Uint8Array
  documentTypeName: string
  /** The 32 bytes of entropy the create transition carries. */
  entropy: Uint8Array
  /** The identity contract nonce the create transition carries. */
  identityContractNonce: bigint
}

function identifierBytes(value: string | Uint8Array, label: string): Uint8Array {
  const bytes = typeof value === 'string' ? bs58.decode(value) : value
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes, got ${bytes.length}`)
  return bytes
}

/** The protocol-14 document id as 32 raw bytes. */
export function deriveDocumentIdBytes(inputs: DocumentIdInputs): Uint8Array {
  if (inputs.entropy.length !== 32) throw new Error(`entropy must be 32 bytes, got ${inputs.entropy.length}`)
  if (inputs.identityContractNonce < BigInt(0) || inputs.identityContractNonce >> BigInt(64) !== BigInt(0)) {
    throw new Error('identityContractNonce must fit in a u64')
  }
  const nonce = new Uint8Array(8)
  new DataView(nonce.buffer).setBigUint64(0, inputs.identityContractNonce)

  const parts = [
    DOCUMENT_ID_V1_DOMAIN_TAG,
    identifierBytes(inputs.contractId, 'contractId'),
    identifierBytes(inputs.ownerId, 'ownerId'),
    utf8.encode(inputs.documentTypeName),
    inputs.entropy,
    nonce,
  ]
  const preimage = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    preimage.set(part, offset)
    offset += part.length
  }
  return sha256(sha256(preimage))
}

/** The protocol-14 document id, base58 — the form the rest of the app addresses documents by. */
export function deriveDocumentId(inputs: DocumentIdInputs): string {
  return bs58.encode(deriveDocumentIdBytes(inputs))
}
