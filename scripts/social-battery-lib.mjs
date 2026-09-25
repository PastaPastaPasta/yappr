/**
 * What the moderated social-contract batteries (verify-v8, verify-v9) share:
 * the hand-built create that carries `$actionFeeAgreement`, the moderator
 * signer, and the small helpers around them. verify-lib is the machinery both
 * run on; this is the v8+ layer above it.
 */
import bs58 from 'bs58';
import {
  BatchTransition,
  BatchedTransition,
  DocumentActionFeeAgreement,
  DocumentCreateTransition,
  Identifier,
  PrivateKey,
} from '@dashevo/evo-sdk';
import {
  NONCE_SEQUENCE_MASK,
  actionFeeAgreementOptions,
  deriveDocumentIdBytes,
  feeMultiplierPermille,
} from './seed/seed-lib.mjs';
import { join } from 'node:path';
import { REPO_ROOT, criticalAuthKey, deriveIdentityKeys, readEnvFile } from './derive-identities.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { network } from './sdk-env.mjs';
import { buildDocument, fetchDocument, randomIdBytes, readback } from './verify-lib.mjs';

const SETTLE_MS = 3000;
export const settle = (ms = SETTLE_MS) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `action` and answers the described error, or null when it landed — the
 * half of a battery outcome the cases that bypass verify-lib's `attemptCreate`
 * have to assemble themselves.
 */
export async function errorOf(action) {
  try {
    await action();
    return null;
  } catch (e) {
    return describeErr(e);
  }
}

/**
 * `JSON.stringify` that survives BigInt. `moderationStatus.suspendedUntil` and
 * a warning's `warnedAt` are u64 and reach JS as BigInt, so stringifying a
 * status straight threw "Do not know how to serialize a BigInt".
 */
export const describeValue = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));

/** An id as base58, whichever of the three shapes the SDK handed back. */
export function idOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.toBase58 === 'function') return value.toBase58();
  return bs58.encode(Uint8Array.from(value));
}

/**
 * Takes a battery-only flag out of process.argv before verify-lib parses it
 * (runBattery refuses flags it does not know).
 */
export function takeFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const [, value] = process.argv.splice(index, 2);
  if (value === undefined) throw new Error(`${name} takes a value`);
  return value;
}

/** The WIF a bot signs manual batches with: the same CRITICAL key verify-lib's signer holds. */
export function wifForBot(index) {
  return criticalAuthKey(deriveIdentityKeys(index)).wif;
}

/** The devnet contract maker is seed index 9 of the deployment seed (.env.devnet DEVNET_MAKER_IDENTITY_ID). */
const DEVNET_MAKER_SEED_INDEX = 9;

/**
 * `maker` names the identity that published the contract. On testnet that is
 * the contract-maker key file; on devnet it is DEVNET_MAKER_IDENTITY_ID at seed
 * index 9. The key file is a different identity that does not exist on the
 * devnet, and verify-v9 accepts only `maker`, so it could not run there at all.
 */
function resolveMakerOwner() {
  if (network() !== 'devnet') return resolveOwner({ maker: true });
  const ownerId = process.env.DEVNET_MAKER_IDENTITY_ID
    || readEnvFile(join(REPO_ROOT, '.env.devnet')).DEVNET_MAKER_IDENTITY_ID;
  if (!ownerId) throw new Error('--moderator maker on devnet needs DEVNET_MAKER_IDENTITY_ID (.env.devnet)');
  return resolveOwner({ botIndex: DEVNET_MAKER_SEED_INDEX, ownerId });
}

/** The moderating identity, its signer and (fetched) Identity, from a `maker` | `bot:<n>` spec. */
export async function resolveModerator(sdk, spec) {
  const owner = spec === 'maker'
    ? resolveMakerOwner()
    : resolveOwner({ botIndex: Number(spec.replace(/^bot:/, '')) });
  const { identityKey, signer } = await signerFor(sdk, owner);
  const identity = await sdk.identities.fetch(owner.ownerId);
  return { ownerId: owner.ownerId, identity, identityKey, signer, label: owner.label };
}

/**
 * A create built by hand so it can carry `$actionFeeAgreement` (and, when the
 * caller pays in YAPP, `$tokenPaymentInfo` with a gas offer). Returns the id
 * the PROOF RESULT names, plus the id derived locally so a battery can compare
 * them. Acceptance is decided by reading the result id back; when the
 * broadcast threw before a result existed (a gateway 504 on the wait), the
 * derived id is probed instead and the outcome says so.
 */
export async function manualCreate(ctx, who, { docType, data, agreement, payment }) {
  const { sdk, contractId } = ctx;
  // Mask before incrementing, exactly as seed-lib's `createWithAgreement` does.
  // A raw identity contract nonce carries missing-nonce marker bits above bit
  // 40 once the identity has a gap (an aborted run that signed a nonce it never
  // landed), and `raw + 1` then names a nonce far in the future: "is trying to
  // set an invalid identity nonce. The current identity nonce is
  // 2199023255558" (= 2^41 + 6), which wedged every later case on moutai.
  const rawNonce = (await readback(() => sdk.identities.contractNonce(who.ownerId, contractId))) ?? 0n;
  const nonce = (BigInt(rawNonce) & NONCE_SEQUENCE_MASK) + 1n;
  const entropy = randomIdBytes();
  const derivedId = deriveDocumentIdBytes({ contractId, ownerId: who.ownerId, docType, entropy, nonce });
  const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy, id: derivedId });
  const transition = new DocumentCreateTransition({
    document,
    identityContractNonce: nonce,
    ...(payment ? { tokenPaymentInfo: payment } : {}),
    ...(agreement ? { actionFeeAgreement: agreement } : {}),
  });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(transition.toDocumentTransition())], who.ownerId, 0);
  const stateTransition = batch.toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);
  stateTransition.sign(PrivateKey.fromWIF(who.wif), who.identityKey);

  let error = null;
  let resultId = null;
  try {
    const result = await sdk.stateTransitions.broadcastAndWait(stateTransition);
    const documents = result?.documents;
    if (documents instanceof Map) for (const key of documents.keys()) resultId = idOf(key);
  } catch (e) {
    error = describeErr(e);
  }
  // The nonce was set by hand, so the facade's cached one is now behind: the
  // next `documents.create` by this identity would reuse it ("nonce already
  // present at tip"), as w1c's bookmark after a manual post did. Same refresh
  // as seed-lib's `createWithAgreement`; the binding wants an Identifier and
  // throws synchronously, hence try/catch.
  try {
    await sdk.wasm.refreshIdentityNonce(new Identifier(who.ownerId));
  } catch (e) {
    console.log(`     (nonce cache refresh failed after ${docType} create: ${describeErr(e).slice(0, 120)})`);
  }
  const probeId = resultId ?? bs58.encode(derivedId);
  for (let poll = 0; poll < 3; poll++) {
    await settle();
    if ((await fetchDocument(sdk, contractId, docType, probeId)) !== null) {
      return { ok: true, error: null, id: probeId, derivedId: bs58.encode(derivedId), resultId, fromResult: resultId !== null };
    }
  }
  return { ok: false, error: error ?? 'the SDK reported no error, but the write is not on chain', id: probeId, derivedId: bs58.encode(derivedId), resultId };
}

/**
 * The agreement a post/reply create must carry: the declared fee at the
 * multiplier the signer read. Built by the same `actionFeeAgreementOptions`
 * the client and the seeders use, so what a battery proves live is the shape
 * the app sends.
 */
export async function feeAgreement(ctx, fee) {
  const knownPermille = await readback(() => feeMultiplierPermille(ctx.sdk));
  return { agreement: new DocumentActionFeeAgreement(actionFeeAgreementOptions(fee, knownPermille)), knownPermille };
}
