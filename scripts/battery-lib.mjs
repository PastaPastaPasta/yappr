/**
 * Shared harness for the registration-day contract batteries
 * (verify-storefront.mjs, verify-blog.mjs, verify-dm.mjs, verify-pollr.mjs,
 * verify-tips.mjs — see docs/NON_SOCIAL_CONTRACTS.md).
 *
 * Every helper decides a write's outcome by READING IT BACK from the chain,
 * never from the SDK's throw/no-throw: DAPI 504s on confirmation waits for
 * transitions that landed, and indexOnly creates can throw post-broadcast.
 *
 * Actors are seed-ledger personas (`.seed-identities.local.json`, see
 * scripts/seed/provision-seed-identities.mjs); `personaActor` signs with the
 * persona's CRITICAL auth key, which also covers the YAPP starter claim.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataContract, IdentitySigner, PlatformVersion, TokenPaymentInfo, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import { signerFor } from './owner-keys.mjs';
import { contractSource, registrationJson } from './register-lib.mjs';
import { devnetName, envValue, network } from './sdk-env.mjs';
import { resolveMakerOwner } from './social-battery-lib.mjs';
import { CLEANUP_CLOCK_SLACK_MS } from './verify-lib.mjs';
import {
  ALREADY_CLAIMED,
  REPO_ROOT,
  RETRYABLE,
  TRANSPORT_COLLAPSE,
  WAIT_MAYBE_LANDED,
  STARTER_GRANT,
  YAPP_TOKEN_POSITION,
  buildDocument,
  createDocument,
  createSdkHandle,
  createWithAgreement,
  createdId,
  describeErr,
  findRecentByValues,
  ledgerEntry,
  loadLedger,
  randomEntropy,
  readback as readbackWith,
  sleep,
  socialContractId,
  tokenBalance,
  wifFromHex,
  writePrivateFile,
} from './seed/seed-lib.mjs';

export const SETTLE_MS = 3000;
export const POLL_ATTEMPTS = 3;

// ---- Expected consensus rejection shapes (matched against describeErr text) ----
export const REFERENCE_NOT_FOUND = /\b40120\b|referenced .*not found/i;
/**
 * ReferencedDocumentPropertyMismatchError. Covers BOTH `where` shapes: a value
 * pair that disagrees with the referenced document, and a WRITER GATE (a
 * `where` entry valued `"$ownerId"`) refusing a signer who may not write the
 * document at all — the gate is an entry with the signing identity on the
 * referring side, so consensus reports it the same way.
 */
export const PROPERTY_MISMATCH = /\b40127\b|does not agree with the referenced document/i;
/** DocumentImmutablePropertyChangedError: a replace touched a frozen property. */
export const IMMUTABLE_CHANGED = /\b40128\b|is immutable and cannot be changed/i;
export const DELETE_FORBIDDEN = /can ?not be deleted/i;
/**
 * DocumentDeleteConstraintViolatedError (5.0.0-beta.3): the owner's delete
 * breaks a `deleteConstraints` rule. Its message also says "can not be
 * deleted", so DELETE_FORBIDDEN matches it too; this one does not match a
 * `canBeDeleted: false` refusal.
 */
export const DELETE_CONSTRAINT = /\b40147\b|deleteConstraints rule/i;
export const DUPLICATE_UNIQUE = /\b40105\b|duplicate unique properties/i;
export const TOKEN_AGREEMENT_MISSING = /token|payment|agree/i;
export const FOREIGN_SIGNATURE = /invalid.{0,40}signature|signature.{0,40}(invalid|mismatch)|4020\d/i;
/**
 * A ranked read on a grid bucket no document ever landed in fails proof
 * generation instead of proving an empty ranking; that error IS the empty
 * answer (lib/services/ranked-likes.ts isColdBucketError).
 */
export const COLD_BUCKET = /single-path axis read must produce exactly one axis descent/i;

export const id32 = (base58) => bs58.decode(base58);
export const settle = () => sleep(SETTLE_MS);

/** Base64 query operand for a plain byte-array property (what the client's `bytesToBase64QueryOperand` emits). */
export const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** A 32-byte identifier that is not an identity or a document on this devnet. */
export const ghostIdentity = () => bs58.encode(randomEntropy());

/**
 * Integer group keys come back in two forms, and both are live:
 * `documents.count({groupBy})` keys by the HEX of the platform-encoded byte
 * while `documents.ranked` hands back the decoded number. The byte depends on
 * the chain: older chains key an UNSIGNED integer index value as 0x80 + value
 * ('80'..'89'), while PV14 on beta.5 (platform #5350) keys it as the plain
 * big-endian byte ('00'..'09'). The two are unambiguous below 128 (a plain
 * byte stays under 0x80, an offset one is at or above it), so this decodes
 * both: byte >= 0x80 ? byte - 0x80 : byte. Anything else stays `null`, so a
 * mismatch fails a check instead of quietly reading as group 0.
 */
export function decodeIntGroupKey(key) {
  if (typeof key === 'number') return key;
  if (typeof key === 'bigint') return Number(key);
  if (typeof key !== 'string' || !/^[0-9a-f]+$/i.test(key)) return null;
  const byte = parseInt(key, 16);
  return byte >= 0x80 ? byte - 0x80 : byte;
}

/** Any identifier shape (bytes, base58 string, Identifier) → base58. */
export function normalizeId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array || Array.isArray(value)) return bs58.encode(Uint8Array.from(value));
  if (typeof value.base58 === 'function') return value.base58();
  if (typeof value.toString === 'function') return value.toString();
  return '';
}

/**
 * Drive's "internal error" payloads arrive base64-encoded CBOR, so the actual
 * consensus reason never reaches the log. Splices the decoded text in.
 */
export function decodeDriveError(text) {
  return text.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, (blob) => {
    try {
      const decoded = Buffer.from(blob, 'base64').toString('utf8').replace(/[^\x20-\x7e]+/g, ' ').trim();
      return decoded.length > 12 ? `${blob.slice(0, 12)}… ("${decoded}")` : blob;
    } catch { return blob; }
  });
}

/** The personal account's slot in the private seed ledger (docs/PLATFORM_BETA4_UPGRADE.md). */
const PERSONAL_PERSONA_IDX = 900;

/** A `--moderator` value: a ledger persona index, `maker` or `personal`. */
export const MODERATOR_FLAG = { parse: (raw) => raw };

/**
 * A seed-ledger persona as an actor that signs with its CRITICAL auth key:
 * `{ ownerId, identityKey, signer, wif, label, starterClaimed }`.
 */
export async function personaActor(handle, personaIdx) {
  const entry = ledgerEntry(loadLedger(), personaIdx);
  if (!entry) throw new Error(`persona ${personaIdx} is not in the seed ledger`);
  const identity = await readbackWith(handle, () => handle.sdk.identities.fetch(entry.identityId));
  if (!identity) throw new Error(`identity ${entry.identityId} not found on this devnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
  if (!identityKey || !authKey) throw new Error(`persona ${personaIdx} has no CRITICAL auth key`);
  const wif = wifFromHex(authKey.privateKeyHex);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wif);
  // `wif` is what a hand-built batch signs with — the only shape that can
  // carry an `$actionFeeAgreement` (v8 post/reply); the signer covers the rest.
  return { ownerId: entry.identityId, identityKey, signer, wif, label: `${entry.handle}(${personaIdx})`, starterClaimed: entry.starterClaimed === true };
}

/** Creates a battery context: SDK handle, reporting state, and the helper set bound to it. */
export function createBattery({ handle, contractId, socialId, agreementFor = undefined }) {
  let failures = 0;
  const capturedErrors = [];
  const createdDocuments = new Map();
  const workingShapes = [];
  const sdk = handle.sdk;
  const readback = (fn) => readbackWith(handle, fn);

  function check(name, condition, detail = '') {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
  }

  const actorOf = (personaIdx) => personaActor(handle, personaIdx);

  /**
   * The moderator a `--moderator` spec names, with the Identity the moderation
   * calls sign as: a seed-ledger persona index; `maker`, the devnet maker
   * (DEVNET_MAKER_IDENTITY_ID at seed index 9), which publishes and is
   * appointed on every moderated cut; or `personal`, the personal account
   * (ledger persona 900). A contract's appointed set is fixed at publish, so
   * this must name one of those identities or its owner.
   */
  async function moderatorActor(spec) {
    const value = String(spec).trim();
    let actor;
    if (value === 'maker') {
      const owner = resolveMakerOwner();
      actor = { ownerId: owner.ownerId, label: `maker(${owner.ownerId})`, ...(await signerFor(sdk, owner)) };
    } else if (value === 'personal') {
      if (!ledgerEntry(loadLedger(), PERSONAL_PERSONA_IDX)) {
        throw new Error(`--moderator personal is seed-ledger persona ${PERSONAL_PERSONA_IDX}, which this ledger does not hold`);
      }
      actor = await actorOf(PERSONAL_PERSONA_IDX);
    } else if (/^\d+$/.test(value)) {
      actor = await actorOf(Number(value));
    } else {
      throw new Error(`--moderator must be a persona index, maker or personal (got "${value}")`);
    }
    return { ...actor, identity: await readback(() => sdk.identities.fetch(actor.ownerId)) };
  }

  const yappBalance = (tokenId, ownerId) => tokenBalance(readback, sdk, tokenId, ownerId);

  /** An identity's CREDIT balance — what a cost measurement diffs. */
  async function balanceOf(ownerId) {
    const balances = await readback(() => sdk.identities.balances([ownerId]));
    return (balances instanceof Map ? balances.get(ownerId) : undefined) ?? 0n;
  }

  let minterPromise = null;
  let socialContractPromise = null;
  const socialContract = () => (socialContractPromise ??= readback(() => sdk.contracts.fetch(socialId)));
  let mintDisabledPromise = null;
  const mintDisabled = () => (mintDisabledPromise ??= socialContract().then(contract =>
    contract.toJSON(PlatformVersion.current()).tokens['0'].manualMintingRules?.authorizedToMakeChange?.$type === 'noOne'));
  /**
   * The devnet maker (seed index 9), who mints YAPP as the social contract's
   * owner. Says so loudly when the maker does NOT own the contract: every mint
   * would then be refused (40701), and the fix is the env, not a retry.
   */
  const minter = () => (minterPromise ??= (async () => {
    const owner = resolveMakerOwner();
    const contract = await socialContract();
    const contractOwner = contract?.ownerId?.toBase58?.() ?? String(contract?.ownerId ?? '');
    if (contractOwner !== owner.ownerId) {
      console.log(`     WARNING: the maker ${owner.ownerId} (DEVNET_MAKER_IDENTITY_ID) is not the owner ${contractOwner} of social ${socialId}; YAPP mints will be refused`);
    }
    return { ownerId: owner.ownerId, ...(await signerFor(sdk, owner)) };
  })());
  /** Identities known to have claimed their starter grant (the ledger's record, or this run's claim or 40722). */
  const claimed = new Set();

  /**
   * Tops an actor up to `target` YAPP: its own once-per-identity starter claim
   * first (a claim is not a transfer, so the paused v10 token pays it; a second
   * claim is 40722 and harmless), then, only on a cut permitting it, an owner mint of the rest. v17
   * has no mint authority; callers must budget the starter grant or pay credits. YAPP can no longer be bought or transferred (v10: paused, no price).
   * Failures are reported, not thrown: the balance read back is what callers trust.
   */
  async function ensureYapp(tokenId, actor, target) {
    let balance = await yappBalance(tokenId, actor.ownerId);
    if (balance >= target) return balance;
    // The ledger may describe another contract; the chain is the source of claim state.
    if (!claimed.has(actor.ownerId)) {
      try {
        await sdk.tokens.claim({ dataContractId: socialId, tokenPosition: YAPP_TOKEN_POSITION, identityId: actor.ownerId, distributionType: 'oncePerIdentity', identityKey: actor.identityKey, signer: actor.signer });
        console.log(`     ${actor.label} claimed its ${STARTER_GRANT} starter YAPP`);
      } catch (e) {
        if (!ALREADY_CLAIMED.test(describeErr(e))) console.log(`     (starter claim reported: ${describeErr(e).slice(0, 140)})`);
      }
      // Either way it is spent: a landed claim or 40722 both mean never again.
      claimed.add(actor.ownerId);
      await settle();
      balance = await yappBalance(tokenId, actor.ownerId);
      if (balance >= target) return balance;
    }
    if (await mintDisabled()) {
      console.log(`     ${actor.label}: ${balance} YAPP after its own starter claim; minting is disabled (use credits for further writes)`);
      return balance;
    }
    const amount = target - balance;
    console.log(`     minting ${amount} YAPP to ${actor.label} from the contract owner`);
    try {
      const owner = await minter();
      await sdk.tokens.mint({ dataContractId: socialId, tokenPosition: YAPP_TOKEN_POSITION, amount, identityId: owner.ownerId, recipientId: actor.ownerId, identityKey: owner.identityKey, signer: owner.signer });
    } catch (e) {
      console.log(`     (mint reported: ${describeErr(e).slice(0, 140)})`);
    }
    await settle();
    return yappBalance(tokenId, actor.ownerId);
  }

  async function fetchDocument(docType, id, contract = contractId) {
    return readback(async () => (await sdk.documents.get(contract, docType, id)) ?? null);
  }

  /**
   * A stored document's current revision, as the BigInt `attemptReplace` wants.
   * Falls back to 1n when the document does not read back, so a replace built
   * on it still reaches consensus and fails with the reason under test rather
   * than with a revision error.
   */
  async function revisionOf(docType, id, contract = contractId) {
    const stored = await fetchDocument(docType, id, contract);
    return BigInt(stored?.revision ?? 1);
  }

  /** `write()` may resolve to a value (the created Document); it is handed back as `result` when the write is accepted. */
  async function attemptWrite({ accepted }, write) {
    let error = null;
    let result;
    try {
      result = await write();
    } catch (e) {
      error = describeErr(e);
    }
    for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
      await settle();
      if (await accepted(result)) return { ok: true, error: null, result };
    }
    return { ok: false, error: error ?? 'the SDK reported no error, but the write is not on chain' };
  }

  /** Token-payment agreement for a doctype priced in YAPP from the SOCIAL contract (cross-contract tokenCost). */
  function paymentInfo(cost) {
    return cost
      ? { tokenPaymentInfo: new TokenPaymentInfo({ paymentTokenContractId: socialId, tokenContractPosition: YAPP_TOKEN_POSITION, maximumTokenCost: BigInt(cost) }) }
      : {};
  }

  /**
   * Creates a stored document; accepted = it reads back by id (or `accepted` for indexOnly types).
   * Protocol 14: the stored id is derived from the nonce the SDK picks, so it is read off the
   * Document `create()` returns. A create that threw (504 after broadcast) has no known id: for a
   * stored type it is reconciled by value against the owner's documents created since this call
   * began (so an identical document from an earlier run cannot score a refused write as accepted).
   * For an indexOnly type `id` is whatever the returned Document carries — it addresses no stored
   * row and is reported for the log only; `document` is the SDK's confirmed instance when the
   * create returned (it carries the consensus `$createdAt` a delete-by-values needs), else the
   * local placeholder.
   *
   * A create on the battery's contract carries the agreement the battery's `agreementFor(sdk,
   * docType)` returns (a `DocumentActionFeeAgreement`, or undefined when the type is unpriced),
   * unless the case names its own `agreement` or opts out with `noAgreement`. One is sent as a
   * hand-built batch (seed-lib `createDocument`), the only shape that carries
   * `$actionFeeAgreement`; the facade has no option for it, and a priced type created without
   * one is a paid 40132.
   */
  async function attemptCreate(who, docType, data, { tokenCost, noPayment, noAgreement, agreement: named, accepted, contract = contractId } = {}) {
    const agreement = named ?? (noAgreement || contract !== contractId ? undefined : await agreementFor?.(sdk, docType));
    const entropy = randomEntropy();
    const { document } = buildDocument({ contractId: contract, docType, ownerId: who.ownerId, data, entropy });
    let id = null;
    const since = Date.now();
    // A value-identical document that existed BEFORE this create cannot be
    // evidence that this create landed — and that is precisely the shape of a
    // unique-index probe, where the document making the create fail is the one
    // the value search finds. `since` alone does not exclude it: the floor
    // allows 120 s of clock skew, so a fixture written seconds earlier in the
    // same run matched and scored refused writes as ACCEPTED (BAD) — DM d1c
    // (duplicate conversationInvite) and d3d (duplicate readReceipt).
    const preExisting = accepted
      ? null
      : await readback(() => findRecentByValues(sdk, { contractId: contract, docType, ownerId: who.ownerId, data }));
    const storedById = async (created) => {
      const found = createdId(created) ?? id
        ?? await readback(() => findRecentByValues(sdk, { contractId: contract, docType, ownerId: who.ownerId, data, since }));
      if (found !== null && found === preExisting) return false;
      id = found;
      return id !== null && (await fetchDocument(docType, id, contract)) !== null;
    };
    const payment = noPayment ? {} : paymentInfo(tokenCost);
    const onDerivedId = (derived) => { id = derived; };
    const outcome = await attemptWrite(
      { accepted: accepted ?? storedById },
      () => (agreement
        // The derived id is kept before the broadcast, so a create whose wait throws after it
        // landed is still found by id (v7 blogPost/blogComment have no owner index to search).
        ? createDocument(sdk, { contractId: contract, actor: who, docType, document, data, entropy, agreement, payment, onDerivedId })
        // Unpriced creates and agreement-refusal probes also retain the derived id before
        // broadcast. This recovers landed writes on types with no queryable indexes (poll v8)
        // and reads the chain nonce after agreed creates instead of reusing a facade cache.
        : who.wif
          ? createWithAgreement(sdk, { contractId: contract, docType, ownerId: who.ownerId, wif: who.wif, identityKey: who.identityKey, data, entropy, payment, onDerivedId })
          : sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer, ...payment }))
    );
    if (accepted && outcome.ok) id = createdId(outcome.result);
    if (outcome.ok && id && contract === contractId) {
      if (!createdDocuments.has(docType)) createdDocuments.set(docType, new Set());
      createdDocuments.get(docType).add(id);
    }
    return { ...outcome, id, document: outcome.result ?? document };
  }

  async function attemptReplace(who, docType, id, data, revision, contract = contractId) {
    const nextRevision = BigInt(revision) + 1n;
    const { document } = buildDocument({ contractId: contract, docType, ownerId: who.ownerId, data, revision: nextRevision, id: id32(id) });
    return attemptWrite(
      { accepted: async () => { const d = await fetchDocument(docType, id, contract); return d?.revision !== undefined && BigInt(d.revision) >= nextRevision; } },
      () => sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer })
    );
  }

  async function attemptDelete(who, docType, id, contract = contractId) {
    return attemptWrite(
      { accepted: async () => (await fetchDocument(docType, id, contract)) === null },
      () => sdk.documents.delete({ document: { id, ownerId: who.ownerId, dataContractId: contract, documentTypeName: docType }, identityKey: who.identityKey, signer: who.signer })
    );
  }

  /** indexOnly delete-by-values: the Document carries the whole value tuple; `accepted` = the entry is gone. */
  async function attemptDeleteByValues(who, document, accepted) {
    return attemptWrite({ accepted }, () => sdk.documents.delete({ document, identityKey: who.identityKey, signer: who.signer }));
  }

  /**
   * An indexOnly type has no id-addressable row, so acceptance can only be a
   * VALUE query on one of its index paths.
   */
  async function entryExists(docType, where, contract = contractId) {
    return (await queryDocs(docType, { where }, contract)).length > 0;
  }

  /** Creates an indexOnly document; accepted = an entry matching `where` appears. */
  /**
   * An INDEX-ONLY create: there is no primary tree, so acceptance is decided by
   * the index entry existing.
   *
   * **This default cannot express a duplicate probe.** An entry that PREDATES
   * the write satisfies `entryExists` exactly as it did before the write, so a
   * create refused for colliding with it scores as ACCEPTED — the same trap
   * `attemptCreate` guards against for stored types, which it cannot do here
   * because an index entry carries no id to compare. A case asserting that a
   * duplicate is refused MUST pass its own `accepted` that measures a CHANGE,
   * e.g. a count delta across the write (the pollr v4 battery's `probeRecast`
   * did this; it is in git history since pollr v5 made ballots stored documents).
   */
  function attemptCreateByValues(who, docType, data, where, options = {}) {
    const contract = options.contract ?? contractId;
    return attemptCreate(who, docType, data, {
      ...options,
      accepted: options.accepted ?? (() => entryExists(docType, where, contract)),
    });
  }

  function expectAccepted(label, outcome) {
    check(label, outcome.ok, outcome.ok ? (outcome.id ? `id=${outcome.id}` : '') : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
    return outcome;
  }

  function expectRejected(label, outcome, pattern) {
    const reason = outcome.error ?? '';
    if (outcome.ok) { check(label, false, 'ACCEPTED (BAD)'); return outcome; }
    capturedErrors.push({ label, message: reason });
    // Consensus refusals can arrive inside a "failed to wait for state transition"
    // wrapper too. Its explicit consensus code/schema error still establishes a refusal.
    const consensus = /\bcode=[124]\d{4}\b|\bJsonSchemaError\b/i.test(reason);
    const transient = RETRYABLE.test(reason) || TRANSPORT_COLLAPSE.test(reason) || (!consensus && WAIT_MAYBE_LANDED.test(reason));
    const matched = !transient && pattern.test(reason);
    check(label, matched, matched ? reason.slice(0, 200) : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 180)}`);
    return outcome;
  }

  /** A write and its verdict in one call, so case tables can be data. */
  const verdict = (label, expect, outcome) => (expect ? expectRejected(label, outcome, expect) : expectAccepted(label, outcome));
  /** `expect` is the rejection pattern the write must produce, or null when it must land. */
  const probeCreate = async (label, expect, who, docType, data, options) =>
    verdict(label, expect, await attemptCreate(who, docType, data, options));
  const probeReplace = async (label, expect, who, docType, id, data, revision, contract) =>
    verdict(label, expect, await attemptReplace(who, docType, id, data, revision, contract));
  const probeDelete = async (label, expect, who, docType, id, contract) =>
    verdict(label, expect, await attemptDelete(who, docType, id, contract));

  // ---- Reads ------------------------------------------------------------------

  async function countBy(docType, where, contract = contractId) {
    return readback(async () => {
      const raw = await sdk.documents.count({ dataContractId: contract, documentTypeName: docType, where });
      const total = raw instanceof Map ? raw.get('') : raw?.[''];
      return total === undefined || total === null ? 0 : Number(total);
    });
  }

  /** Grouped count keyed by the group value's hex key; `decodeKey` maps hex → your key. */
  async function groupedCount(docType, where, groupBy, decodeKey = (k) => k, contract = contractId) {
    return readback(async () => {
      const raw = await sdk.documents.count({ dataContractId: contract, documentTypeName: docType, where, groupBy });
      const out = new Map();
      for (const [key, value] of raw.entries()) { if (key !== '') out.set(decodeKey(key), Number(value)); }
      return out;
    });
  }

  async function averageBy(docType, property, where, contract = contractId) {
    return readback(async () => {
      const raw = await sdk.documents.average({ dataContractId: contract, documentTypeName: docType, where }, property);
      const entry = raw instanceof Map ? raw.get('') : raw?.[''];
      return entry ? { count: Number(entry.count), sum: Number(entry.sum) } : { count: 0, sum: 0 };
    });
  }

  async function sumBy(docType, property, where, contract = contractId) {
    return readback(async () => {
      const raw = await sdk.documents.sum({ dataContractId: contract, documentTypeName: docType, where }, property);
      const entry = raw instanceof Map ? raw.get('') : raw?.[''];
      return entry === undefined || entry === null ? 0 : Number(entry);
    });
  }

  async function ranked(docType, groupBy, aggregate, extra = {}, contract = contractId) {
    const shape = { dataContractId: contract, documentTypeName: docType, groupBy, aggregate, limit: 100, ...extra };
    const page = await readback(() => sdk.documents.ranked(shape));
    return { page, shape };
  }

  /**
   * Asserts one group's count on a ranked page. A WINDOWED read (`timeRange`) on a
   * grid bucket nothing landed in throws instead of proving an empty page, and that
   * error IS the empty answer — but ONLY for a windowed read. An all-time axis that
   * fails proof generation is a real fault and stays a FAIL, which is the whole
   * point of the cases that read it.
   */
  async function checkRanked(label, docType, groupBy, key, expected, extra = {}, contract = contractId) {
    try {
      const result = await ranked(docType, groupBy, { type: 'count' }, extra, contract);
      const entry = groupValueOf(result.page, key);
      check(label, Number(entry?.value ?? -1) === expected, `value=${entry?.value} groups=${result.page.entries.length}`);
      return result;
    } catch (e) {
      const message = describeErr(e);
      const coldBucket = Boolean(extra.timeRange) && COLD_BUCKET.test(message);
      check(label, coldBucket, coldBucket ? `cold bucket (the empty answer): ${message.slice(0, 160)}` : message.slice(0, 200));
      return null;
    }
  }

  async function queryDocs(docType, query, contract = contractId) {
    return readback(async () => {
      const r = await sdk.documents.query({ dataContractId: contract, documentTypeName: docType, ...query });
      return [...r.values()].map((d) => d.toObject());
    });
  }

  const groupValueOf = (page, key) => page.entries.find((entry) => entry.groupValue === key);
  const avgOf = (page, key) => { const e = groupValueOf(page, key); return e ? Number(e.value) / Number(page.valueScale) : undefined; };
  const approx = (a, b) => a !== undefined && b !== undefined && Math.abs(a - b) < 1e-6;
  const b58 = (bytes) => bs58.encode(Uint8Array.from(bytes));

  function report(summaryLine) {
    if (capturedErrors.length > 0) {
      console.log('\n--- captured rejection texts (verbatim) ---');
      for (const { label, message } of capturedErrors) console.log(`\n[${label}]\n${message.slice(0, 400)}`);
    }
    if (workingShapes.length > 0) {
      console.log('\n--- working query shapes ---');
      for (const { label, shape } of workingShapes) console.log(`\n# ${label}\n${JSON.stringify(shape)}`);
    }
    if (summaryLine) console.log(`\n${summaryLine}`);
    console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
    return failures;
  }

  return {
    sdk, readback, check, personaActor: actorOf, moderatorActor, yappBalance, balanceOf, ensureYapp, mintDisabled, fetchDocument, revisionOf,
    attemptWrite, paymentInfo, attemptCreate, attemptReplace, attemptDelete, attemptDeleteByValues,
    attemptCreateByValues, entryExists, expectAccepted, expectRejected, probeCreate, probeReplace, probeDelete,
    countBy, groupedCount, averageBy, sumBy, ranked, checkRanked, queryDocs, groupValueOf, avgOf, approx, b58,
    workingShapes, createdDocuments, report, get failures() { return failures; },
  };
}

/** Runs the selected cases, catching per-case aborts as failures. */
export async function runCases(battery, cases, only, ctx) {
  for (const key of [...cases.keys()].filter((k) => !only || only.includes(k))) {
    try {
      await cases.get(key)(ctx);
    } catch (e) {
      battery.check(`${key} completed`, false, `aborted: ${describeErr(e).slice(0, 220)}`);
    }
  }
}

export function parseOnly(value, cases) {
  if (!value) return null;
  const only = value.split(',').map((s) => s.trim());
  for (const key of only) if (!cases.has(key)) throw new Error(`unknown case ${key}`);
  return only;
}

// ---- Test contracts ----------------------------------------------------------

/**
 * A battery whose cases leave content nobody can remove (pollr: a poll with a
 * ballot is permanent) runs them on a TEST contract by default: one copy of the
 * checked-in file, registered once by a battery persona and reused run after
 * run. The app never reads it, so what the cases leave there stays out of
 * sight. Its id is recorded per network in this gitignored file beside the
 * sha256 of the file it was registered from, so a schema change asks for a new
 * one (`--register-test-contract`) instead of running the cases against an old
 * schema. Shape: `{ "<network>": { "<name>": { contractId, sha256, file, ownerId, registeredAt, credits } } }`.
 */
export const TEST_CONTRACTS_FILE = join(REPO_ROOT, '.test-contracts.local.json');
/** What 1M credits cost at $60/DASH (1 DASH = 10^11 credits), in US cents. */
export const CENTS_PER_MILLION_CREDITS = 0.06;
const centsOf = (credits) => (Number(credits) * CENTS_PER_MILLION_CREDITS / 1e6).toFixed(2);

/** A network's key in the registry: a devnet by its name, since each devnet is a different chain. */
export function testContractNetworkKey(net, devnet) {
  return net === 'devnet' ? `devnet:${devnet}` : net;
}

/** The sha256 (hex) of a checked-in contract file's bytes. */
export function contractFileSha256(file) {
  return createHash('sha256').update(readFileSync(join(REPO_ROOT, 'contracts', file))).digest('hex');
}

/**
 * The test contract `name` recorded for `networkKey`, judged against the
 * file's current `sha256`: `current`, `stale` (registered from another version
 * of the file) or `missing`.
 */
export function recordedTestContract(registry, { networkKey, name, sha256 }) {
  const entry = registry?.[networkKey]?.[name] ?? null;
  if (!entry) return { state: 'missing', entry: null };
  return { state: entry.sha256 === sha256 ? 'current' : 'stale', entry };
}

/** `registry` with `entry` recorded as the test contract `name` of `networkKey`. */
export function withTestContract(registry, { networkKey, name, entry }) {
  return { ...registry, [networkKey]: { ...registry?.[networkKey], [name]: entry } };
}

/**
 * Where a battery with a test contract runs: `{ live: false }`, the test
 * contract (the default), or with `--live-contract` `{ live: true, contractId }`,
 * the contract `--contract` names, else the battery's env var, else the
 * deployment's (`deployed`). `--contract` alone is refused, so a stray id
 * cannot quietly aim the cases at a published contract.
 */
export function contractTarget({ liveContract, registerTestContract, contract, fromEnv, deployed, envName }) {
  if (!liveContract) {
    if (contract) throw new Error('--contract names the contract for --live-contract; without it the cases run on the test contract');
    return { live: false };
  }
  if (registerTestContract) throw new Error('--register-test-contract registers the test contract, which --live-contract does not use');
  const contractId = contract ?? fromEnv ?? deployed;
  if (!contractId) throw new Error(`--live-contract: pass --contract <id>, or set ${envName}`);
  return { live: true, contractId };
}

const loadTestContracts = () => (existsSync(TEST_CONTRACTS_FILE) ? JSON.parse(readFileSync(TEST_CONTRACTS_FILE, 'utf8')) : {});
/** How many of the registrar's newest identity nonces are searched for an earlier registration. */
const REGISTRATION_SCAN = 32;
/** A contract create can land well after the gateway gave up on it: this many settles before it counts as lost. */
const REGISTRATION_POLLS = 10;

/** `file` as a contract owned by `ownerId` at identity nonce `nonce` (its id derives from both). */
function testContractDraft(file, ownerId, nonce) {
  const text = readFileSync(join(REPO_ROOT, 'contracts', file), 'utf8');
  if (text.includes('"SOCIAL_CONTRACT_ID"')) throw new Error(`contracts/${file} prices a type in the social contract's YAPP; a test copy cannot carry that`);
  const id = DataContract.generateId(ownerId, nonce).toBase58();
  return DataContract.fromJSON(registrationJson(contractSource(text), { id, ownerId }), true, PlatformVersion.current());
}

/** A contract's document schemas as parsed JSON: equal for the file and every contract registered from it. */
const schemasJson = (contract) => JSON.stringify(contract.toJSON(PlatformVersion.current()).documentSchemas, (_key, value) => (typeof value === 'bigint' ? String(value) : value));

/**
 * The newest contract `owner` registered with exactly `file`'s schemas, or
 * null. A contract's id derives from its owner's identity nonce, so the
 * registrar's recent nonces name every contract it could have registered:
 * a registration whose record was never written (a 504 that landed late,
 * another checkout) is found again instead of being paid for twice.
 */
async function findRegistered(handle, { file, owner }) {
  const nonce = BigInt((await readbackWith(handle, () => handle.sdk.identities.nonce(owner.ownerId))) ?? 0n);
  const want = schemasJson(testContractDraft(file, owner.ownerId, 1n));
  for (let n = nonce; n >= 1n && n > nonce - BigInt(REGISTRATION_SCAN); n--) {
    const id = DataContract.generateId(owner.ownerId, n).toBase58();
    const found = await readbackWith(handle, () => handle.sdk.contracts.fetch(id));
    if (found && schemasJson(found) === want) return id;
  }
  return null;
}

/**
 * Registers `file` as a new contract owned by `owner`. Never the maker: it must
 * not spend an identity nonce on a test contract. Decided by reading the
 * contract back, since the gateway 504s waits that landed.
 */
async function registerTestContract(handle, { file, owner }) {
  const { sdk } = handle;
  if (owner.ownerId === envValue('DEVNET_MAKER_IDENTITY_ID')) throw new Error(`${owner.label} is the devnet maker, which never registers a test contract`);
  const nonce = ((await readbackWith(handle, () => sdk.identities.nonce(owner.ownerId))) ?? 0n) + 1n;
  const dataContract = testContractDraft(file, owner.ownerId, nonce);
  const balance = async () => BigInt(await readbackWith(handle, () => sdk.identities.balance(owner.ownerId)));
  const before = await balance();
  let contractId = DataContract.generateId(owner.ownerId, nonce).toBase58();
  let error = null;
  try {
    contractId = (await sdk.contracts.publish({ dataContract, identityKey: owner.identityKey, signer: owner.signer })).id.toBase58();
  } catch (e) {
    error = describeErr(e);
  }
  for (let poll = 0; poll < REGISTRATION_POLLS; poll++) {
    await settle();
    if (await readbackWith(handle, () => sdk.contracts.fetch(contractId)).catch(() => null)) {
      const credits = before - await balance();
      console.log(`registered ${contractId} from contracts/${file}, paid by ${owner.label}: ${credits} credits (${centsOf(credits)}¢)`);
      return { contractId, ownerId: owner.ownerId, registeredAt: new Date().toISOString(), credits: String(credits) };
    }
  }
  throw new Error(`registering contracts/${file} failed: ${error ?? 'the contract does not read back'}. If it lands later, the next run finds it without registering again`);
}

/**
 * The id of the battery's test contract (`test`: `{ name, file, registrar, cost }`)
 * on this network: the recorded one when it matches the file and is on chain,
 * else one `registrar` registered from the same schemas earlier (recorded on
 * the spot), else, only with `register`, a new one paid by `registrar`.
 * Without `register` there is no new registration, so a run never spends
 * `cost` by surprise.
 */
async function testContractId(handle, { test, registrar, register }) {
  const sha256 = contractFileSha256(test.file);
  const networkKey = testContractNetworkKey(network(), network() === 'devnet' ? devnetName() : null);
  const registry = loadTestContracts();
  const { state, entry } = recordedTestContract(registry, { networkKey, name: test.name, sha256 });
  const label = `the ${test.name}-test contract`;
  if (state === 'current' && await readbackWith(handle, () => handle.sdk.contracts.fetch(entry.contractId))) {
    if (register) console.log(`${label} ${entry.contractId} already matches contracts/${test.file}: nothing registered`);
    return entry.contractId;
  }
  const record = (found) => {
    writePrivateFile(TEST_CONTRACTS_FILE, `${JSON.stringify(withTestContract(registry, { networkKey, name: test.name, entry: { ...found, sha256, file: test.file } }), null, 2)}\n`);
    return found.contractId;
  };
  const earlier = await findRegistered(handle, { file: test.file, owner: registrar });
  if (earlier) {
    console.log(`${label}: ${registrar.label} registered ${earlier} from this contracts/${test.file} earlier; recorded it in ${TEST_CONTRACTS_FILE}`);
    return record({ contractId: earlier, ownerId: registrar.ownerId, foundAt: new Date().toISOString() });
  }
  const why = {
    missing: `no ${label} is recorded for ${networkKey}`,
    stale: `${label} ${entry?.contractId} was registered from another contracts/${test.file}`,
    current: `${label} ${entry?.contractId} is not on this chain`,
  }[state];
  if (!register) {
    throw new Error(`${why}, and ${registrar.label} registered none from this one. Pass --register-test-contract to register one (${test.cost}, paid by ${registrar.label}), or --live-contract to run on the deployed contract`);
  }
  console.log(`${why}: registering one`);
  return record(await registerTestContract(handle, { file: test.file, owner: registrar }));
}

// ---- Entrypoint --------------------------------------------------------------

/**
 * `flags` and `actors` map a flag name to its default, and the default's TYPE is
 * the coercion (number → Number, bigint → BigInt, boolean → a switch that
 * takes no value, anything else → the raw string). Pass `{ default, parse }`
 * when a flag needs its own.
 */
function coerceFlag({ default: fallback, parse }, raw) {
  if (parse) return parse(raw);
  if (typeof fallback === 'number') return Number(raw);
  if (typeof fallback === 'bigint') return BigInt(raw);
  return raw;
}

function parseBatteryArgs(argv, spec) {
  const specs = new Map();
  const args = { only: null };
  const define = (name, value) => {
    const entry = value !== null && typeof value === 'object' ? value : { default: value };
    specs.set(name, entry);
    args[name] = entry.default;
  };
  const test = spec.contract?.test;
  const fromEnv = spec.contract?.env ? process.env[spec.contract.env]?.trim() || null : null;
  // With a test contract the env var only names the contract for --live-contract.
  if (spec.contract?.env) define('contract', test ? null : fromEnv);
  if (test) {
    define('live-contract', false);
    define('register-test-contract', false);
  }
  if (spec.cleanup) define('keep-content', false);
  if (spec.yapp?.default !== undefined) define('yapp', spec.yapp.default);
  for (const [name, value] of Object.entries({ ...spec.actors, ...spec.flags })) define(name, value);

  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (name === 'only') { args.only = parseOnly(argv[++i], spec.cases); continue; }
    const entry = name === null ? undefined : specs.get(name);
    if (!entry && name === 'keep-content') throw new Error('--keep-content: this battery cleans up nothing, so there is no content to keep');
    if (!entry) throw new Error(`Unknown argument: ${argv[i]}`);
    args[name] = typeof entry.default === 'boolean' ? true : coerceFlag(entry, argv[++i]);
  }
  if (test) {
    args.target = contractTarget({
      liveContract: args['live-contract'], registerTestContract: args['register-test-contract'], contract: args.contract,
      // The deployment's id is read from .env.devnet, so only a devnet run falls back to it.
      fromEnv, deployed: network() === 'devnet' ? envValue(test.deployedEnv) ?? null : null, envName: spec.contract.env,
    });
  } else if (spec.contract?.env && !args.contract) {
    throw new Error(`Pass --contract <id> or set ${spec.contract.env}`);
  }
  spec.validate?.(args);
  return args;
}

/**
 * runBattery's end-of-run cleanup: `spec.cleanup(ctx, { since })` takes down
 * what the run left on the published surfaces, `since` being the run's start
 * less the chain-clock slack. `--keep-content` skips it. A cleanup that throws
 * prints a WARNING and never changes the verdict.
 */
async function cleanUpRun(spec, ctx, runStart) {
  if (!spec.cleanup) return;
  if (ctx.args['keep-content']) {
    console.log("\n--keep-content: the run's content stays (scripts/clean-test-content.mjs --surface takes it down later)");
    return;
  }
  console.log('\n--- cleanup of the run\'s content (skip with --keep-content) ---');
  try {
    await spec.cleanup(ctx, { since: runStart - CLEANUP_CLOCK_SLACK_MS });
  } catch (e) {
    console.log(`WARNING  cleanup did not finish: ${describeErr(e).slice(0, 220)}; run scripts/clean-test-content.mjs --surface by hand`);
  }
}

/**
 * The whole battery entrypoint: `--self-test` guard, argument parsing, connect,
 * persona actors, the test contract (`spec.contract.test`), the optional YAPP
 * pre-flight, the case run, the cleanup (`spec.cleanup`) and the exit code.
 * `setup` returns the extra ctx a battery's cases need; `battery`, `contractId`,
 * `liveContract`, `socialId`, `tokenId`, `args`, `run` and every actor are
 * merged in for free. `liveContract` is false when the cases run on the test
 * contract.
 */
export async function runBattery(spec) {
  if (spec.selfTest && process.argv.includes('--self-test')) process.exit(spec.selfTest());
  try {
    const args = parseBatteryArgs(process.argv.slice(2), spec);
    await ensureInitialized();
    const socialId = socialContractId();
    const known = spec.contract.fixed ?? (args.target ? args.target.contractId : args.contract);
    const extra = (spec.extraContracts?.(args) ?? []).filter(Boolean);
    // The handle re-fetches these on every reconnect, so a test contract registered below is pushed in.
    const contractIds = [socialId, known, ...extra].filter(Boolean);
    const handle = createSdkHandle({ contractIds });
    const { protocolVersion } = await handle.connect();
    console.log(`connected (PV${protocolVersion})`);

    const names = Object.keys(spec.actors ?? {});
    const resolved = await Promise.all(names.map((name) => personaActor(handle, args[name])));
    const actors = Object.fromEntries(names.map((name, index) => [name, resolved[index]]));
    if (names.length > 0) console.log(names.map((name) => `${name}=${actors[name].label}`).join(' '));

    const liveContract = args.target?.live ?? true;
    let contractId = known;
    if (!liveContract) {
      const { test } = spec.contract;
      contractId = await testContractId(handle, { test, registrar: actors[test.registrar], register: args['register-test-contract'] });
      contractIds.push(contractId);
      await readbackWith(handle, () => handle.sdk.contracts.fetch(contractId));
    }
    const battery = createBattery({ handle, contractId, socialId, agreementFor: spec.agreementFor });
    console.log(`${spec.label} ${contractId}${liveContract ? '' : ` (the ${spec.contract.test.name}-test contract)`}${spec.banner?.({ args, socialId }) ?? ''}`);

    let tokenId = null;
    if (spec.yapp) {
      tokenId = await battery.readback(() => battery.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
      const target = spec.yapp.target ? spec.yapp.target(args) : args.yapp;
      for (const name of spec.yapp.actors) {
        const balance = await battery.ensureYapp(tokenId, actors[name], target);
        console.log(`     ${actors[name].label}: ${balance} YAPP`);
        if (spec.yapp.require && balance < target) {
          throw new Error(`${actors[name].label} holds ${balance} YAPP, below the ${target} the battery needs`);
        }
      }
    }

    const runStart = Date.now();
    const base = { battery, contractId, liveContract, socialId, tokenId, args, run: runStart.toString(36), ...actors };
    const ctx = { ...base, ...(await spec.setup?.({ ...base, protocolVersion }) ?? {}) };
    try {
      await runCases(battery, spec.cases, args.only, ctx);
    } finally {
      await cleanUpRun(spec, ctx, runStart);
    }
    process.exit(battery.report(spec.summary?.(ctx) ?? '') === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR:', describeErr(e));
    process.exit(1);
  }
}

// ---- Offline pre-flight ------------------------------------------------------

/**
 * Asserts the checked-in contract JSON still declares the rules a battery's
 * cases are written against, without touching the network (`--self-test`).
 *
 * A battery only finds out on registration day that a contract no longer
 * carries, say, the writer gate its "a stranger cannot do this" case expects —
 * and a MISSING rule reads as a case that fails for an unexplained reason. This
 * pins the declarations in CI instead, right beside the build scripts' own
 * `--self-test`.
 *
 * `expect` is keyed by document type:
 *   where: { <property>: { <referenced>: <referring>, … } }  exact match, in
 *          the beta.7 orientation (the referenced document's property is the key)
 *   immutable:     the names `immutable` freezes unconditionally, order-insensitive
 *   immutableWhen: { <property>: <condition> } for its conditional
 *                  `{ property, when }` entries (5.0.0-beta.1, which refuses
 *                  the `immutableAllowSetting` they replaced), exact match
 *   constraints:   the names of its `propertyConstraints` rules, order-insensitive
 *   deleteConstraints: { <rule>: <body> } (5.0.0-beta.3), exact match
 *
 * Returns a process exit code.
 */
export function selfTest(file, expect) {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', file), 'utf8'));
  const schemas = parsed.documentSchemas ?? parsed;
  const problems = [];
  // Both comparisons are order-insensitive: a `where` is a SET of
  // pairs and an immutable list a set of names, so a build script that emits
  // them in a different order has changed nothing consensus can see.
  const sortedNames = (values) => [...(values ?? [])].sort();
  const sortedPairs = (pairs) => (pairs === undefined ? undefined
    : Object.fromEntries(Object.entries(pairs).sort(([a], [b]) => (a < b ? -1 : 1))));
  const compare = (what, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };

  for (const [docType, rules] of Object.entries(expect)) {
    const schema = schemas[docType];
    if (!schema) { problems.push(`${docType}: document type is missing`); continue; }
    for (const [property, where] of Object.entries(rules.where ?? {})) {
      compare(`${docType}.${property} where`,
        sortedPairs(schema.properties?.[property]?.refersTo?.where), sortedPairs(where));
    }
    const frozen = schema.immutable ?? [];
    if (rules.immutable !== undefined) {
      compare(`${docType} immutable`, sortedNames(frozen.filter((entry) => typeof entry === 'string')), sortedNames(rules.immutable));
    }
    if (rules.immutableWhen !== undefined) {
      const conditional = Object.fromEntries(frozen.filter((entry) => typeof entry !== 'string').map(({ property, when }) => [property, when]));
      compare(`${docType} conditional immutable`, sortedPairs(conditional), sortedPairs(rules.immutableWhen));
    }
    // The names of the propertyConstraints rules (property-constraint-cases.mjs holds their cases).
    if (rules.constraints !== undefined) {
      compare(`${docType} propertyConstraints`, sortedNames(Object.keys(schema.propertyConstraints ?? {})), sortedNames(rules.constraints));
    }
    if (rules.deleteConstraints !== undefined) {
      compare(`${docType} deleteConstraints`, sortedPairs(schema.deleteConstraints), sortedPairs(rules.deleteConstraints));
    }
  }

  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length > 0) {
    console.error(`contracts/${file} no longer matches what this battery asserts`);
    return 1;
  }
  console.log(`contracts/${file} declares every rule this battery asserts`);
  return 0;
}

/**
 * Reports an OFFLINE self-test built from plain assertions, for a battery whose
 * subject is not a checked-in contract (verify-tips.mjs). Returns an exit code.
 */
export function reportSelfTest(subject, assertions) {
  const problems = assertions.filter(([, ok]) => !ok).map(([what]) => what);
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length > 0) {
    console.error(`${subject} no longer behaves the way this battery asserts`);
    return 1;
  }
  console.log(`${subject} behaves the way this battery asserts (${assertions.length} checks)`);
  return 0;
}
