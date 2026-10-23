/**
 * Document ids and identity contract nonces for Dash Platform protocol 14.
 *
 * A new document's id commits to the identity contract nonce of its create
 * transition (`generate_document_id` v1, dashpay/platform#4859); consensus
 * recomputes it for every create and refuses a mismatch with
 * `InvalidDocumentTransitionIdError` (10405).
 *
 * From 4.2.0-beta.4 wasm-dpp2 derives that id itself (dashpay/platform#4868):
 * `Document.generateId(type, owner, contract, entropy, nonce)` returns it, and
 * `new DocumentCreateTransition({ document, identityContractNonce })`
 * re-derives it and writes it back onto `document.id`. Yappr no longer carries
 * its own copy of the hash; {@link documentIdForCreate} is a thin wrapper over
 * the wasm derivation for a caller that needs the id before the transition
 * exists (data that commits to the id).
 *
 * Consequences the callers live with:
 *  - the id exists only once the nonce is assigned, and changes if the
 *    transition is rebuilt with another nonce;
 *  - a nonce is consumed at most once per identity and contract, so an id can
 *    be produced at most once — a deleted document can never be re-created
 *    under its old id.
 */
import bs58 from 'bs58'
import { Document } from '@dashevo/wasm-sdk'
import { MAX_NONCE_DISTANCE, NONCE_SEQUENCE_MASK, identityContractNonceConsumed } from './nonce-rules.mjs'

export { identityContractNonceConsumed }

/**
 * The nonce the next transition against a contract must carry, from the value
 * `identities.contractNonce` returned (`undefined` when the identity has never
 * written to the contract).
 */
export function nextIdentityContractNonce(current: bigint | undefined | null): bigint {
  return ((current ?? BigInt(0)) & NONCE_SEQUENCE_MASK) + BigInt(1)
}

/**
 * The nonce the next transition should carry, given the value
 * `identities.contractNonce` returned and the last nonce this browser
 * broadcast against the same contract (null when none): one past whichever is
 * further along, so a write never takes the nonce of one that has not executed
 * yet. A reservation too far ahead for Drive to accept belongs to transitions
 * that were dropped, and is ignored.
 */
export function allocateIdentityContractNonce(current: bigint | undefined | null, reserved: bigint | null): bigint {
  const next = nextIdentityContractNonce(current)
  if (reserved === null || reserved < next) return next
  const tip = next - BigInt(1)
  return reserved + BigInt(1) - tip > MAX_NONCE_DISTANCE ? next : reserved + BigInt(1)
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

/**
 * The id a create transition with these inputs will carry, base58 — the form
 * the rest of the app addresses documents by. Derived by wasm-dpp2 at the
 * latest platform version, which is the one the transition is built for.
 * Requires the wasm module to be initialized (any `getEvoSdk()` call has).
 */
export function documentIdForCreate(inputs: DocumentIdInputs): string {
  return bs58.encode(
    Document.generateId(
      inputs.documentTypeName,
      inputs.ownerId,
      inputs.contractId,
      inputs.entropy,
      inputs.identityContractNonce
    )
  )
}
