/**
 * The charters writes both the release CLI (scripts/file-release-charters.mjs)
 * and the app's Moderation teams page build, sign and prove the same way:
 *
 * - a charters document create, signed locally with a known nonce, so the
 *   exact signed bytes can be broadcast again after an uncertain outcome and
 *   never re-signed under a fresh nonce;
 * - the application's contest fund, checked against the reviewed 0.5 DASH;
 * - a charter key to add to an identity (bound to one charters document type);
 * - the proof that a create landed, including an application, which lives in
 *   the contest (not in the document type's storage) until it is awarded.
 *
 * `w` is the wasm SDK module the caller signs with (Node's `@dashevo/evo-sdk`
 * in the CLI, the app's shared `@dashevo/wasm-sdk` instance in the browser);
 * `sdk` is a connected EvoSDK. Types: transitions.d.mts.
 */
import { CHARTERS_CONTRACT_ID, CONTEST_FUND_CREDITS, assertContestFund } from './rules.mjs'
import { NONCE_SEQUENCE_MASK, identityContractNonceConsumed } from '../nonce-rules.mjs'

const CONTEST_INDEX = 'byTargetContract'
const NONCE_READ_ATTEMPTS = 13
const NONCE_READ_PAUSE_MS = 5000

const idBytes = (w, id) => w.Identifier.fromBase58(id).toBytes()

/** `ownerId`'s raw charters nonce (sequence and missing-revision bits), as the node reports it now. */
async function readCharterNonce(sdk, ownerId) {
  return BigInt(await sdk.wasm.getIdentityContractNonce(ownerId, CHARTERS_CONTRACT_ID) ?? 0)
}

/**
 * The charters nonce `ownerId`'s next create takes: one past the proved tip,
 * never at or below `floor` (the last nonce this caller saw proved), so a read
 * lagging behind a write just made cannot hand that nonce out again. Waits
 * for a lagging read (about a minute), then gives up without a nonce.
 */
export async function nextCharterNonce(sdk, ownerId, floor = 0n) {
  for (let attempt = 0; attempt < NONCE_READ_ATTEMPTS; attempt++) {
    const current = (await readCharterNonce(sdk, ownerId)) & NONCE_SEQUENCE_MASK
    if (current >= BigInt(floor)) return current + 1n
    if (attempt < NONCE_READ_ATTEMPTS - 1) await new Promise((done) => setTimeout(done, NONCE_READ_PAUSE_MS))
  }
  throw new Error('nonce reads remain behind this journal’s proved writes; retry after the node catches up (no new transition prepared)')
}

/**
 * Whether `nonce` (a create's) can no longer execute: it is the tip, was
 * filled in behind it, or fell out of the window. A nonce behind the tip whose
 * missing bit is still set can execute yet (Drive's gap-filling rule).
 */
export async function charterNonceConsumed(sdk, ownerId, nonce) {
  return identityContractNonceConsumed(await readCharterNonce(sdk, ownerId), nonce)
}

/** A charters document of `type` owned by `ownerId`; its id is derived from its entropy when it is signed. */
function charterDocument(w, type, ownerId, data) {
  return w.Document.fromObject({
    $formatVersion: '0', $id: new Uint8Array(32), $ownerId: idBytes(w, ownerId), $dataContractId: idBytes(w, CHARTERS_CONTRACT_ID),
    $type: type, $revision: 1n, $entropy: globalThis.crypto.getRandomValues(new Uint8Array(32)), ...data,
  }, w.PlatformVersion.latest())
}

/**
 * Builds and signs the create of one charters document under
 * `identityContractNonce` with `privateKey` (whose identity key is
 * `identityKey`). An application (`fund`) states the contest fund, which must
 * be exactly the reviewed 0.5 DASH. Returns the step to broadcast and prove:
 * the document id consensus derives, and the signed bytes.
 */
export async function signCharterCreate(w, sdk, { type, ownerId, data, nonce, privateKey, identityKey, fund = false }) {
  const doc = charterDocument(w, type, ownerId, data)
  if (fund) {
    const required = await sdk.documents.contestFundToJoin(doc)
    try { assertContestFund(required?.credits) } finally { required?.free?.() }
  }
  const create = new w.DocumentCreateTransition({ document: doc, identityContractNonce: nonce,
    ...(fund ? { prefundedVotingBalance: new w.PrefundedVotingBalance({ indexName: CONTEST_INDEX, credits: CONTEST_FUND_CREDITS }) } : {}) })
  const id = create.base.id.toBase58()
  const batch = w.BatchTransition.fromBatchedTransitions([new w.BatchedTransition(create.toDocumentTransition())], ownerId, 0)
  const st = batch.toStateTransition()
  st.setIdentityContractNonce(nonce)
  st.sign(privateKey, identityKey)
  return { id, type, owner: ownerId, nonce: String(nonce), bytes: st.toBytes(), hash: st.hash(false) }
}

/** The identity key to add for a charter key: MEDIUM secp256k1, bound to one charters document type. */
export function charterKeyInCreation(w, { keyId, purpose, documentType, publicKey }) {
  return new w.IdentityPublicKeyInCreation({ keyId, purpose, securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1', isReadOnly: false,
    data: publicKey, contractBounds: w.ContractBounds.SingleContractDocumentType(CHARTERS_CONTRACT_ID, documentType) })
}

/**
 * Whether the create `step` ({ id, type, owner }) is proved on chain. An
 * application lives in the contest for `targetContractId` until it is
 * awarded, so it is found there by its owner (any page of contenders), or as
 * the seated charter once it won.
 */
export async function charterStepExists(w, sdk, step, targetContractId) {
  if (step.type !== 'electedCharter') return Boolean(await sdk.documents.get(CHARTERS_CONTRACT_ID, step.type, step.id))
  const state = await sdk.voting.contestedResourceVoteState({ dataContractId: CHARTERS_CONTRACT_ID, documentTypeName: 'electedCharter', indexName: CONTEST_INDEX,
    indexValues: [targetContractId], resultType: 'documentsAndVoteTally', includeLockedAndAbstaining: true,
    startAtContenderId: step.owner, startAtIncluded: true, limit: 1 })
  try {
    const contender = state.contenders.find((c) => c.identityId.toBase58() === step.owner)
    if (contender?.serializedDocument) {
      const contract = await sdk.contracts.fetch(CHARTERS_CONTRACT_ID)
      try {
        const doc = w.Document.fromBytes(contender.serializedDocument, contract, 'electedCharter', w.PlatformVersion.latest())
        try { return doc.id.toBase58() === step.id && doc.ownerId.toBase58() === step.owner } finally { doc.free() }
      } finally { contract.free() }
    }
    const seated = await sdk.moderationCharters.seatedCharter(targetContractId)
    try { return seated?.id.toBase58() === step.id && seated?.ownerId.toBase58() === step.owner } finally { seated?.free() }
  } finally { state.free() }
}

/** Identifier bytes for a document property (`targetContractId`, `submittedCharterId`, `members`, ...). */
export { idBytes as charterIdBytes }
