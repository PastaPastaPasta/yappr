/**
 * The hand-built document create: one `DocumentCreateTransition` in a
 * `BatchTransition`, signed as a `StateTransition`.
 *
 * `stateTransitionService.createDocument` builds creates here rather than
 * through `sdk.documents.create`, because the SDK's `DocumentCreateOptions`
 * (still, at 4.2.0-beta.5) has no `actionFeeAgreement` and no affected-state
 * wait: social v9 charges post and reply creates an action fee (40132 without
 * the agreement), and indexOnly likes confirm only through affected state.
 *
 * Kept free of the SDK connection and of storage so the exact bytes it signs
 * can be pinned offline (`manual-batch.test.ts`): from protocol 14 at beta.5
 * the node refuses bytes left over after a transition (platform#5011).
 */
import {
  BatchedTransition,
  BatchTransition,
  DocumentCreateTransition,
  type Document,
  type DocumentActionFeeAgreement,
  type IdentityPublicKey,
  type PrivateKey,
  type StateTransition,
  type TokenPaymentInfo,
} from '@dashevo/evo-sdk'

export interface ManualCreateInput {
  /** The document to create, carrying its entropy; its id is re-derived from the nonce. */
  document: Document
  ownerId: string
  identityContractNonce: bigint
  tokenPaymentInfo?: TokenPaymentInfo
  actionFeeAgreement?: DocumentActionFeeAgreement
  privateKey: PrivateKey
  identityKey: IdentityPublicKey
}

/**
 * Builds and signs the create. The transition re-derives the id from the
 * document's entropy and the nonce (wasm-dpp2, beta.4+) and writes it back onto
 * `document`, so after this call `document.id` is the id consensus derives.
 */
export function buildSignedCreateTransition(input: ManualCreateInput): StateTransition {
  const createTransition = new DocumentCreateTransition({
    document: input.document,
    identityContractNonce: input.identityContractNonce,
    ...(input.tokenPaymentInfo ? { tokenPaymentInfo: input.tokenPaymentInfo } : {}),
    ...(input.actionFeeAgreement ? { actionFeeAgreement: input.actionFeeAgreement } : {}),
  })
  const batched = new BatchedTransition(createTransition.toDocumentTransition())
  const stateTransition = BatchTransition.fromBatchedTransitions([batched], input.ownerId, 0).toStateTransition()
  stateTransition.setIdentityContractNonce(input.identityContractNonce)
  stateTransition.sign(input.privateKey, input.identityKey)
  return stateTransition
}
