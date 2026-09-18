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
 * persona's CRITICAL auth key, which also covers YAPP direct purchases.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdentitySigner, TokenPaymentInfo, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import {
  REPO_ROOT,
  YAPP_TOKEN_POSITION,
  buildDocument,
  createSdkHandle,
  describeErr,
  ledgerEntry,
  loadLedger,
  randomEntropy,
  readback as readbackWith,
  sleep,
  socialContractId,
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
 * (0x80 + value) while `documents.ranked` hands back the decoded number.
 * Anything else stays `null`, so a mismatch fails a check instead of quietly
 * reading as group 0.
 */
export function decodeIntGroupKey(key) {
  if (typeof key === 'number') return key;
  if (typeof key === 'bigint') return Number(key);
  if (typeof key !== 'string' || !/^[0-9a-f]+$/i.test(key)) return null;
  return parseInt(key, 16) - 0x80;
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

  /** An identity's CREDIT balance — what a cost measurement diffs. */
  async function balanceOf(ownerId) {
    const balances = await readback(() => sdk.identities.balances([ownerId]));
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

  /**
   * An indexOnly type has no id-addressable row, so acceptance can only be a
   * VALUE query on one of its index paths.
   */
  async function entryExists(docType, where, contract = contractId) {
    return (await queryDocs(docType, { where }, contract)).length > 0;
  }

  /** Creates an indexOnly document; accepted = an entry matching `where` appears. */
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
    const matched = pattern.test(reason);
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
    sdk, readback, check, personaActor, yappBalance, balanceOf, ensureYapp, fetchDocument, revisionOf,
    attemptWrite, paymentInfo, attemptCreate, attemptReplace, attemptDelete, attemptDeleteByValues,
    attemptCreateByValues, entryExists, expectAccepted, expectRejected, probeCreate, probeReplace, probeDelete,
    countBy, groupedCount, averageBy, sumBy, ranked, checkRanked, queryDocs, groupValueOf, avgOf, approx, b58,
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

// ---- Entrypoint --------------------------------------------------------------

/**
 * `flags` and `actors` map a flag name to its default, and the default's TYPE is
 * the coercion (number → Number, bigint → BigInt, anything else → the raw
 * string). Pass `{ default, parse }` when a flag needs its own.
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
  if (spec.contract?.env) define('contract', process.env[spec.contract.env]?.trim() || null);
  if (spec.yapp?.default !== undefined) define('yapp', spec.yapp.default);
  for (const [name, value] of Object.entries({ ...spec.actors, ...spec.flags })) define(name, value);

  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (name === 'only') { args.only = parseOnly(argv[++i], spec.cases); continue; }
    const entry = name === null ? undefined : specs.get(name);
    if (!entry) throw new Error(`Unknown argument: ${argv[i]}`);
    args[name] = coerceFlag(entry, argv[++i]);
  }
  if (spec.contract?.env && !args.contract) throw new Error(`Pass --contract <id> or set ${spec.contract.env}`);
  spec.validate?.(args);
  return args;
}

/**
 * The whole battery entrypoint: `--self-test` guard, argument parsing, connect,
 * persona actors, the optional YAPP pre-flight, the case run and the exit code.
 * `setup` returns the extra ctx a battery's cases need; `battery`, `contractId`,
 * `socialId`, `tokenId`, `args`, `run` and every actor are merged in for free.
 */
export async function runBattery(spec) {
  if (spec.selfTest && process.argv.includes('--self-test')) process.exit(spec.selfTest());
  try {
    const args = parseBatteryArgs(process.argv.slice(2), spec);
    await ensureInitialized();
    const socialId = socialContractId();
    const contractId = spec.contract.fixed ?? args.contract;
    const extra = (spec.extraContracts?.(args) ?? []).filter(Boolean);
    const handle = createSdkHandle({ contractIds: [socialId, contractId, ...extra] });
    const { protocolVersion } = await handle.connect();
    const battery = createBattery({ handle, contractId, socialId });
    console.log(`connected (PV${protocolVersion}); ${spec.label} ${contractId}${spec.banner?.({ args, socialId }) ?? ''}`);

    const names = Object.keys(spec.actors ?? {});
    const resolved = await Promise.all(names.map((name) => battery.personaActor(args[name])));
    const actors = Object.fromEntries(names.map((name, index) => [name, resolved[index]]));
    if (names.length > 0) console.log(names.map((name) => `${name}=${actors[name].label}`).join(' '));

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

    const base = { battery, contractId, socialId, tokenId, args, run: Date.now().toString(36), ...actors };
    const ctx = { ...base, ...(await spec.setup?.({ ...base, protocolVersion }) ?? {}) };
    await runCases(battery, spec.cases, args.only, ctx);
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
