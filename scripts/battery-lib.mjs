/**
 * Shared harness for the registration-day contract batteries
 * (verify-storefront.mjs, verify-blog.mjs, verify-dm.mjs, …).
 *
 * Every helper decides a write's outcome by READING IT BACK from the chain,
 * never from the SDK's throw/no-throw: DAPI 504s on confirmation waits for
 * transitions that landed, and indexOnly creates can throw post-broadcast.
 *
 * Actors are seed-ledger personas (`.seed-identities.local.json`, see
 * scripts/seed/provision-seed-identities.mjs); `personaActor` signs with the
 * persona's CRITICAL auth key, which also covers YAPP direct purchases.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdentitySigner, TokenPaymentInfo } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import {
  REPO_ROOT,
  YAPP_TOKEN_POSITION,
  buildDocument,
  describeErr,
  ledgerEntry,
  loadLedger,
  randomEntropy,
  readback as readbackWith,
  sleep,
  wifFromHex,
} from './seed/seed-lib.mjs';

export const SETTLE_MS = 3000;
export const POLL_ATTEMPTS = 3;
export const MIN_YAPP_PURCHASE = 100n;

// ---- Expected consensus rejection shapes (matched against describeErr text) ----
export const REFERENCE_NOT_FOUND = /\b40120\b|referenced .*not found/i;
/**
 * ReferencedDocumentPropertyMismatchError. Covers BOTH agreement shapes: a value
 * pair that disagrees with the referenced document, and a WRITER GATE
 * (`propertyAgreement: {"$ownerId": …}`) refusing a signer who may not write the
 * document at all — the gate is an agreement pair with the signing identity on
 * the referring side, so consensus reports it the same way.
 */
export const PROPERTY_MISMATCH = /\b40127\b|does not agree with the referenced document/i;
/** DocumentImmutablePropertyChangedError: a replace touched a frozen property. */
export const IMMUTABLE_CHANGED = /\b40128\b|is immutable and cannot be changed/i;
export const DELETE_FORBIDDEN = /can ?not be deleted/i;
export const DUPLICATE_UNIQUE = /\b40105\b|duplicate unique properties/i;
export const TOKEN_AGREEMENT_MISSING = /token|payment|agree/i;
export const FOREIGN_SIGNATURE = /invalid.{0,40}signature|signature.{0,40}(invalid|mismatch)|4020\d/i;

export const id32 = (base58) => bs58.decode(base58);
export const settle = () => sleep(SETTLE_MS);

/** Creates a battery context: SDK handle, reporting state, and the helper set bound to it. */
export function createBattery({ handle, contractId, socialId }) {
  let failures = 0;
  const capturedErrors = [];
  const workingShapes = [];
  const sdk = handle.sdk;
  const readback = (fn) => readbackWith(handle, fn);

  function check(name, condition, detail = '') {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
  }

  async function personaActor(personaIdx) {
    const entry = ledgerEntry(loadLedger(), personaIdx);
    if (!entry) throw new Error(`persona ${personaIdx} is not in the seed ledger`);
    const identity = await readback(() => sdk.identities.fetch(entry.identityId));
    if (!identity) throw new Error(`identity ${entry.identityId} not found on this devnet`);
    const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
    const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
    if (!identityKey || !authKey) throw new Error(`persona ${personaIdx} has no CRITICAL auth key`);
    const signer = new IdentitySigner();
    signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));
    return { ownerId: entry.identityId, identityKey, signer, label: `${entry.handle}(${personaIdx})` };
  }

  async function yappBalance(tokenId, ownerId) {
    const balances = await readback(() => sdk.tokens.balances([ownerId], tokenId));
    return (balances instanceof Map ? balances.get(ownerId) : undefined) ?? 0n;
  }

  /** Buys YAPP for an actor up to `target` (direct purchase, CRITICAL key). */
  async function ensureYapp(tokenId, actor, target) {
    const balance = await yappBalance(tokenId, actor.ownerId);
    if (balance >= target) return balance;
    const prices = await readback(() => sdk.tokens.directPurchasePrices([tokenId]));
    const info = prices instanceof Map ? prices.get(tokenId) : prices?.[tokenId];
    const price = BigInt(info?.currentPrice ?? 0);
    if (price === 0n) throw new Error(`YAPP ${tokenId} has no direct-purchase price`);
    const amount = MIN_YAPP_PURCHASE > target - balance ? MIN_YAPP_PURCHASE : target - balance;
    console.log(`     buying ${amount} YAPP for ${actor.label} (${amount * price} credits)`);
    try {
      await sdk.tokens.directPurchase({
        dataContractId: socialId, tokenPosition: YAPP_TOKEN_POSITION, buyerId: actor.ownerId,
        amount, maxTotalCost: amount * price, identityKey: actor.identityKey, signer: actor.signer,
      });
    } catch (e) {
      console.log(`     (purchase reported: ${describeErr(e).slice(0, 140)})`);
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

  async function attemptWrite({ accepted }, write) {
    let error = null;
    try {
      await write();
    } catch (e) {
      error = describeErr(e);
    }
    for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
      await settle();
      if (await accepted()) return { ok: true, error: null };
    }
    return { ok: false, error: error ?? 'the SDK reported no error, but the write is not on chain' };
  }

  /** Token-payment agreement for a doctype priced in YAPP from the SOCIAL contract (cross-contract tokenCost). */
  function paymentInfo(cost) {
    return cost
      ? { tokenPaymentInfo: new TokenPaymentInfo({ paymentTokenContractId: socialId, tokenContractPosition: YAPP_TOKEN_POSITION, maximumTokenCost: BigInt(cost) }) }
      : {};
  }

  /** Creates a stored document; accepted = it reads back by id (or `accepted` for indexOnly types). */
  async function attemptCreate(who, docType, data, { tokenCost, noPayment, accepted, contract = contractId } = {}) {
    const { document, id } = buildDocument({ contractId: contract, docType, ownerId: who.ownerId, data, entropy: randomEntropy() });
    const outcome = await attemptWrite(
      { accepted: accepted ?? (async () => (await fetchDocument(docType, id, contract)) !== null) },
      () => sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer, ...(noPayment ? {} : paymentInfo(tokenCost)) })
    );
    return { ...outcome, id, document };
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

  function expectAccepted(label, outcome) {
    check(label, outcome.ok, outcome.ok ? (outcome.id ? `id=${outcome.id}` : '') : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
    return outcome;
  }

  function expectRejected(label, outcome, pattern) {
    const reason = outcome.error ?? '';
    if (outcome.ok) { check(label, false, 'ACCEPTED (BAD)'); return outcome; }
    capturedErrors.push({ label, message: reason });
    const matched = pattern.test(reason);
    check(label, matched, matched ? reason.slice(0, 200) : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 180)}`);
    return outcome;
  }

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
    sdk, readback, check, personaActor, yappBalance, ensureYapp, fetchDocument, revisionOf, attemptWrite, paymentInfo,
    attemptCreate, attemptReplace, attemptDelete, attemptDeleteByValues, expectAccepted, expectRejected,
    countBy, groupedCount, averageBy, sumBy, ranked, queryDocs, groupValueOf, avgOf, approx, b58,
    workingShapes, report, get failures() { return failures; },
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
 *   agreements: { <property>: { <referring>: <referenced>, … } }  exact match
 *   immutable / immutableAllowSetting: property names, order-insensitive
 *
 * Returns a process exit code.
 */
export function selfTest(file, expect) {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', file), 'utf8'));
  const schemas = parsed.documentSchemas ?? parsed;
  const problems = [];
  // Both comparisons are order-insensitive: a propertyAgreement is a SET of
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
    for (const [property, agreement] of Object.entries(rules.agreements ?? {})) {
      compare(`${docType}.${property} propertyAgreement`,
        sortedPairs(schema.properties?.[property]?.refersTo?.propertyAgreement), sortedPairs(agreement));
    }
    for (const key of ['immutable', 'immutableAllowSetting']) {
      if (rules[key] === undefined) continue;
      compare(`${docType} ${key}`, sortedNames(schema[key]), sortedNames(rules[key]));
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
