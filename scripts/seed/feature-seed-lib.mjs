/**
 * Shared plumbing for the five non-social content seeders (`scripts/seed/seed-non-social.mjs --which
 * storefront|blog|dm|pollr|tips`). Rules encoded here, each learned the expensive way:  - Acceptance is decided by
 * READBACK, never by throw/no-throw: a DAPI 504 on    `wait_for_state_transition_result` is the normal case for a
 * transition that    landed, and an indexOnly create can throw after a successful broadcast.  - A document's `$id`
 * is only known from the create that returned it (protocol 14 derives it from    the transition's nonce), so ids
 * are checkpointed under a logical key the moment they land and a resumed    run recognises its earlier write by
 * the checkpoint, by a unique-index adoption probe or by value.  - One in-flight transition per identity (identity contract nonce); actors run    in parallel behind a
 * global cap.  - A checkpoint from different wiring names documents that do not exist here,    so a provenance
 * mismatch throws rather than silently skipping the run.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { getPublicKey } from '@noble/secp256k1';
import bs58 from 'bs58';
import { ensureInitialized } from '@dashevo/evo-sdk';
import {
  DUPLICATE_UNIQUE, FEE_MULTIPLIER_NOT_TOLERATED, NONCE_DESYNC, NOT_QUERYABLE_BY_OWNER, QUORUM_GAP, QUORUM_GAP_SETTLE_MS, REPO_ROOT, RETRYABLE, SOCIAL_SHAPES, TRANSPORT_COLLAPSE, WAIT_MAYBE_LANDED,
  buildDocument, createDocument, createdId, describeErr, findRecentByValues, forgetFeeMultiplier, hashtagProps, ledgerEntry, loadLedger, network, readEnvFile, readback, sleep, writePrivateFile,
} from './seed-lib.mjs';

export const utf8 = (text) => new TextEncoder().encode(text);
export const sum = (values) => values.reduce((total, value) => total + value, 0);
export const fakeId = (key) => bs58.encode(sha256(utf8(`yappr/seed-offline/${key}`)));

/** mulberry32 — small, fast, identical on every Node version. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG for a string or integer seed: same seed, same stream, every run. */
export function rngFrom(seedLike) {
  if (typeof seedLike === 'number') return mulberry32(seedLike);
  const d = sha256(utf8(String(seedLike)));
  return mulberry32(((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0);
}

export const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
export const pick = (rng, items) => items[Math.floor(rng() * items.length) % items.length];

/** Fisher-Yates on a copy. */
export function shuffled(rng, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Draws from `[value, weight]` pairs; the last entry catches rounding. */
export function weightedPick(rng, entries) {
  const total = entries.reduce((acc, [, weight]) => acc + weight, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** Namespaced document entropy: the `$id` becomes a pure function of the key. */
export const entropySource = (namespace) => (key) => sha256(utf8(`${namespace}/${key}`));

/**
 * Bumped whenever the on-disk checkpoint shape changes. It is part of the provenance, so a file from before the bump
 * fails the same "move it aside" check — an ABSENT key is a mismatch too, which is how pre-v2 files (storefront's
 * `docs[key] = {type, id}` objects, blog's `items` map) are caught instead of crashing mid-phase.
 */
export const CHECKPOINT_VERSION = 2;

/**
 * Reads a checkpoint and REFUSES one written under different wiring. Phases skip work purely on a recorded id, so a
 * file from before a devnet wipe or contract re-cut would report everything as already present and embed ghost ids.
 */
export function loadCheckpoint(file, provenance, defaults = {}) {
  provenance = { v: CHECKPOINT_VERSION, ...provenance };
  if (!existsSync(file)) return { ...provenance, ...defaults };
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not readable JSON (${describeErr(error)}); move it aside to start over`);
  }
  if (!state || typeof state !== 'object') throw new Error(`${file} is not a checkpoint object; move it aside`);
  for (const [key, expected] of Object.entries(provenance)) {
    // `v` must be PRESENT and equal; the rest only have to agree when recorded.
    if (state[key] !== expected && (key === 'v' || state[key] !== undefined)) {
      throw new Error(`${file} was written for ${key}=${state[key] ?? '(absent)'}, this run uses ${expected}. `
        + 'The recorded document ids do not exist under this wiring — move the file aside to re-seed.');
    }
  }
  return { ...defaults, ...state, ...provenance };
}

/** Atomic (tmp + rename) and mode 0600: parallel actors save after every write. */
export function saveCheckpoint(file, state) {
  writePrivateFile(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Global in-flight cap; per-identity ordering comes from one chain per actor. */
function semaphore(limit) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    while (active >= limit) await new Promise((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

/** Buckets `items` into one sequential task queue per signing identity. */
export function groupTasks(items, actorOf, taskOf, groups = new Map()) {
  for (const item of items) {
    const actor = actorOf(item);
    if (!groups.has(actor)) groups.set(actor, []);
    groups.get(actor).push(() => taskOf(item));
  }
  return groups;
}

/** Runs each actor's queue strictly in order; actors in parallel behind `limit`. */
export async function runByActor(groups, limit) {
  const gate = semaphore(Math.max(1, limit));
  await Promise.all([...groups.values()].map(async (tasks) => {
    for (const task of tasks) await gate(task);
  }));
}

/** One dependency phase: `items` grouped by signer, each actor's list in order. */
export const phaseRunner = (limit) => (label, items, actorOf, task) => {
  if (label) console.log(`--- ${label} ---`);
  return runByActor(groupTasks(items, actorOf, task), limit);
};

const SETTLE_MS = 3_000;
const SETTLE_POLLS = 3;
/** A quorum gap hides a landed write from readback until it closes: wait that out before a retry. */
const settlePollsFor = (error) => (error && QUORUM_GAP.test(describeErr(error)) ? Math.ceil(QUORUM_GAP_SETTLE_MS / SETTLE_MS) : SETTLE_POLLS);
const MAX_ATTEMPTS = 4;

/**
 * Creates one document and decides the outcome by READING THE CHAIN. `accepted(id)` is the per-doctype probe:
 * `documents.get` for a stored type, an index-entry query for an indexOnly one (which has no row under its `$id`).
 * `duplicateIsSuccess` accepts a 40105 only when the `accepted` probe then finds the document on chain — the probe,
 * not the code, decides what counts as this write's document (pollr's ballot probe accepts any ballot in the voter's
 * slot, because the seeder replaces it to the planned choice next).
 */
export function createDocWriter({ handle, contractId, entropyFor, paymentInfo, agreementFor = () => undefined, create = createDocument, wait = sleep }) {
  const stored = (docType, id, contract) => handle.sdk.documents.get(contract, docType, id);
  const settles = async (landed, polls = SETTLE_POLLS) => {
    for (let i = 0; i < polls; i++) {
      await wait(SETTLE_MS);
      try {
        if (await landed()) return true;
      } catch { /* a read that faults here is noise, not a verdict */ }
    }
    return false;
  };

  async function createDoc(actor, docType, key, data, opts = {}) {
    const { tokenCost, accepted, duplicateIsSuccess, scope, contract = contractId, payment = paymentInfo } = opts;
    const entropy = entropyFor(key);
    const { document } = buildDocument({ contractId: contract, docType, ownerId: actor.ownerId, data, entropy });
    // Protocol 14: the stored id commits to the nonce `documents.create()` picks, so the id
    // a logical key used to determine is gone. It is learned from the create's RETURN (and
    // then checkpointed by the caller under the key); a create that threw after landing is
    // recognised by the caller's `accepted` probe, or by a value readback for a stored type.
    let id = null;
    // Every id a create derived before broadcasting, one per attempt: an
    // earlier attempt whose wait threw may land after a later one was sent.
    const derivedIds = [];
    // Unbounded in time on purpose: the pre-write probe is how a resumed run
    // with a lost checkpoint recognises its own earlier document.
    const landed = async () => {
      if (accepted) return accepted(id);
      for (const candidate of new Set([id, ...derivedIds].filter(Boolean))) {
        if ((await stored(docType, candidate, contract)) != null) { id = candidate; return true; }
      }
      const found = await readback(handle, () => findRecentByValues(handle.sdk, { contractId: contract, docType, ownerId: actor.ownerId, data, scope }));
      if (found) id = found;
      return found != null;
    };
    if (await landed()) return { id, skipped: true };
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // A doctype whose create is PRICED in credits (v8 post/reply) must agree to
        // the fee, and `sdk.documents.create` has no option for it — so those go
        // through a hand-built batch instead. Resolved per attempt: a 40134 forgets
        // the cached epoch multiplier, and only a fresh agreement can pick up the new one.
        const agreement = await agreementFor(docType, contract);
        const created = await actor.lock(() => create(handle.sdk, {
          contractId: contract, actor, docType, document, data, entropy, agreement, payment: actor.paysCredits ? {} : payment(tokenCost),
          // WIF-backed creates derive their id before broadcasting: keep it, so a create whose
          // wait throws after landing is recognised by id even on a doctype with no owner index.
          onDerivedId: (derived) => { derivedIds.push(derived); },
        }));
        id = createdId(created) ?? id;
        if (await landed()) return { id };
        if (await settles(landed)) return { id };
        lastError = new Error('create returned but the document is not on chain');
      } catch (error) {
        lastError = error;
        const text = describeErr(error);
        if (DUPLICATE_UNIQUE.test(text) && duplicateIsSuccess) {
          if (await landed()) return { id };
          throw new Error(`rejected as a duplicate, but this exact entry is not on chain — the owner already wrote a different one: ${text.slice(0, 160)}`);
        }
        const deadSdk = TRANSPORT_COLLAPSE.test(text) || NONCE_DESYNC.test(text);
        if (deadSdk) await handle.reconnect(text).catch(() => {});
        // A stale cached fee multiplier is the one consensus refusal a retry fixes; refused
        // outright, it never landed, so there is nothing to wait for.
        const staleMultiplier = FEE_MULTIPLIER_NOT_TOLERATED.test(text);
        if (!staleMultiplier && await settles(landed, settlePollsFor(error))) return { id };
        if (staleMultiplier) forgetFeeMultiplier();
        const retryable = deadSdk || staleMultiplier || RETRYABLE.test(text) || WAIT_MAYBE_LANDED.test(text);
        if (!retryable && (/code=4\d{4}/.test(text) || /consensus/i.test(text))) throw error; // Platform said no
      }
      await wait(2_000 * attempt);
    }
    throw lastError ?? new Error(`${docType} create failed after ${MAX_ATTEMPTS} attempts`);
  }

  /** A replace is a state transition too: same per-identity lock, same readback rule. */
  async function replaceDoc(actor, docType, id, data, revision, contract = contractId) {
    const next = BigInt(revision) + 1n;
    const { document } = buildDocument({ contractId: contract, docType, ownerId: actor.ownerId, data, revision: next, id: bs58.decode(id) });
    const landed = async () => {
      const doc = await stored(docType, id, contract);
      return doc?.revision !== undefined && BigInt(doc.revision) >= next;
    };
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await actor.lock(() => handle.sdk.documents.replace({ document, identityKey: actor.identityKey, signer: actor.signer }));
      } catch (error) {
        lastError = error;
        const text = describeErr(error);
        if (TRANSPORT_COLLAPSE.test(text) || NONCE_DESYNC.test(text)) await handle.reconnect(text).catch(() => {});
      }
      if (await settles(landed, settlePollsFor(lastError))) return { id };
    }
    throw lastError ?? new Error(`${docType} replace did not take effect`);
  }

  /**
   * Corrects a MUTABLE document whose stored scalars no longer match the table — a changed value, or a field the table
   * has since DROPPED (removing `countryPattern` is exactly how a shipping zone becomes the catch-all). Byte arrays are
   * index keys and never move, so they are not compared; Platform hands integers back as BigInt, so compare by value or
   * every numeric field reads as changed and every re-run rewrites the document.
   */
  async function reconcileDoc(actor, docType, id, data, contract = contractId) {
    const current = await stored(docType, id, contract);
    if (!current) return false;
    const fields = current.toObject ? current.toObject() : current;
    const scalars = (o) => Object.entries(o).filter(([name, value]) => !name.startsWith('$') && typeof value !== 'object');
    const same = (a, b) => (typeof a === 'bigint' || typeof b === 'bigint' ? BigInt(a ?? 0) === BigInt(b ?? 0) : a === b);
    const drifted = scalars(data).some(([name, value]) => !same(fields[name], value))
      || scalars(fields).some(([name]) => !(name in data));
    if (!drifted) return false;
    await replaceDoc(actor, docType, id, data, fields.$revision ?? current.revision ?? 1, contract);
    return true;
  }

  return { createDoc, replaceDoc, reconcileDoc };
}

/** One in-flight state transition per identity: the identity contract nonce forbids more. */
export function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** Seed-ledger personas as signing actors, each with its own transition lock. */
export async function actorsFor(battery, personaIndexes) {
  const actors = new Map();
  for (const idx of [...new Set(personaIndexes)]) {
    actors.set(idx, { ...(await battery.personaActor(idx)), personaIdx: idx, lock: makeMutex() });
  }
  return actors;
}

/**
 * Checkpoint-backed `createDoc`: skip what the checkpoint already names, record the id the moment it lands, and
 * collect failures instead of aborting the run. Losing the checkpoint costs one existence probe per document, never a
 * duplicate.
 */
export function createRecorder({ writer, state, file }) {
  const tally = { created: 0, skipped: 0, failed: 0 };
  const failures = [];
  const note = (key, docType, error) => {
    tally.failed += 1;
    failures.push({ key, docType, error: String(error).slice(0, 220) });
  };
  // A local arrow, not a shorthand method: callers destructure `createDoc` off
  // the returned object, so `this` is undefined inside it under ESM strict mode.
  const record = (key, id, skipped = false) => {
    state.docs[key] = id;
    saveCheckpoint(file, state);
    tally[skipped ? 'skipped' : 'created'] += 1;
    return id;
  };
  const createDoc = async (actor, docType, key, data, opts = {}) => {
    const known = state.docs[key];
    if (known && !opts.reconcile) { tally.skipped += 1; return known; }
    try {
      // A doctype with no unique index cannot be recognised by its deterministic
      // id alone once an equivalent document exists under a different id — the
      // registration batteries share these contracts — so `adopt` reconciles
      // first and returns the id to record.
      const adopted = opts.adopt ? await opts.adopt() : null;
      if (adopted) return record(key, adopted, true);
      const { id, skipped } = known ? { id: known, skipped: true } : await writer.createDoc(actor, docType, key, data, opts);
      // `reconcile` only applies to a MUTABLE doctype: it corrects a document
      // already on chain whose fields have drifted from the table.
      if (skipped && opts.reconcile && await writer.reconcileDoc(actor, docType, id, opts.reconcile(), opts.contract)) {
        console.log(`  updated ${docType} ${key}`);
      }
      return record(key, id, skipped);
    } catch (error) {
      note(key, docType, describeErr(error));
      console.log(`  FAIL ${docType} ${key}: ${describeErr(error).slice(0, 160)}`);
      return null;
    }
  };
  const summary = (extra = '') => {
    console.log(`\nwrites: ${tally.created} created, ${tally.skipped} already present, ${tally.failed} failed${extra}`);
    for (const failure of failures) console.log(`  FAILED ${failure.docType} ${failure.key}: ${failure.error}`);
    return tally.failed;
  };
  return { tally, failures, id: (key) => state.docs[key] ?? null, createDoc, record, fail: note, summary };
}

/**
 * A social v10 to v16 `post` (its only caller, pollr, refuses any other topology through `requireSeededTopology`):
 * `additionalProperties: false`, no `author`, no `language`, and the tag property omitted entirely rather than sent
 * empty when the post is untagged; v13 adds `live: true`. The tags go through seed-lib's `hashtagProps`
 * (`SOCIAL_SHAPES.tags`): one `hashtag` up to v15, the typed array `tags` on v16, holding the optional `tags` list
 * when given, else `[hashtag]`. A one-tag cut ignores `tags`.
 */
export const socialPost = ({ content, hashtag, tags, ...rest }) => SOCIAL_SHAPES.post({ content, ...hashtagProps(hashtag, tags), ...rest });

/**
 * Tops each persona up to the YAPP its share of the plan will spend (its starter claim, then an owner mint: v10's YAPP
 * cannot be bought or transferred), then RE-READS the balance: a claim or mint can report an error after it landed,
 * and `ensureYapp` swallows those failures, so trusting the call would send a batch of doomed token-priced writes.
 * `needs` is persona index -> tokens the plan will spend.
 */
export async function ensureTokens(battery, tokenId, actors, needs, { headroom = 20n } = {}) {
  const short = [];
  for (const [idx, cost] of [...needs].sort((a, b) => a[0] - b[0])) {
    if (cost <= 0n) continue;
    const actor = actors.get(idx);
    await battery.ensureYapp(tokenId, actor, cost + headroom);
    const balance = await battery.yappBalance(tokenId, actor.ownerId);
    console.log(`  ${actor.label}: ${balance} YAPP (this run spends ${cost})`);
    if (balance < cost && await battery.mintDisabled()) {
      actor.paysCredits = true;
      console.log(`  ${actor.label}: paying credits because the starter balance cannot cover the plan`);
    } else if (balance < cost) short.push(`${actor.label} holds ${balance}, needs ${cost}`);
  }
  if (short.length > 0) {
    throw new Error(`not enough YAPP after top-up, every token-priced write would be refused:\n  ${short.join('\n  ')}`);
  }
}

/**
 * Fixed-width table. `columns` is `[label, width]`; a NEGATIVE width right-aligns the column and the last column is
 * never padded.
 */
export function printTable(columns, rows, title) {
  if (title) console.log(`\n${title}`);
  const cell = (value, i) => (i === columns.length - 1 ? String(value)
    : columns[i][1] < 0 ? String(value).padStart(-columns[i][1]) : String(value).padEnd(columns[i][1]));
  const line = (cells) => cells.map(cell).join('  ');
  console.log(line(columns.map(([label]) => label)));
  console.log(columns.map(([, width]) => '-'.repeat(Math.abs(width))).join('  '));
  for (const row of rows) console.log(line(row));
}

export const bar = (value, total, width = 24) => '#'.repeat(total > 0 ? Math.round((value / total) * width) : 0);

/** A one-line `n thing, m other` count summary for the dry runs. */
export const counts = (entries, tail = '') =>
  `${Object.entries(entries).filter(([, v]) => v !== undefined).map(([k, v]) => `${v} ${k}`).join(', ')}${tail}`;

/**
 * A persona's ledger key material by purpose (`encryption`, `transfer`, …) or by key id. Offline runs fall back to a
 * deterministic stand-in so `--dry-run` can still exercise the real crypto with no ledger on disk.
 */
export function personaKeys(ledger, personaIdx, { purpose, keyId, offline = false } = {}) {
  const entry = ledgerEntry(ledger, personaIdx);
  const key = entry?.identityKeys?.find((k) => (keyId !== undefined ? k.keyId === keyId : k.purpose === purpose));
  if (!key) {
    if (!offline) throw new Error(`persona ${personaIdx} has no ${purpose ?? `key ${keyId}`} in the seed ledger`);
    const privateKey = sha256(utf8(`yappr/seed-offline-key/${personaIdx}/${purpose ?? keyId}`));
    return { privateKey, publicKey: getPublicKey(privateKey, true), identityId: fakeId(`identity/${personaIdx}`), handle: `persona${personaIdx}` };
  }
  return {
    privateKey: Uint8Array.from(Buffer.from(key.privateKeyHex, 'hex')),
    publicKey: Uint8Array.from(Buffer.from(key.publicKeyHex, 'hex')),
    identityId: entry.identityId,
    handle: entry.handle,
  };
}

/**
 * `spec` maps a flag to `[key, kind]`, kind being bool | string | number | list | numlist. Unknown flags throw, so a
 * typo never silently seeds the wrong thing.
 */
export function parseFlags(argv, spec, defaults) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const rule = spec[argv[i]];
    if (!rule) throw new Error(`Unknown flag: ${argv[i]}`);
    const [key, kind] = rule;
    if (kind === 'bool') { args[key] = true; continue; }
    const raw = argv[++i];
    if (raw === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    if (kind === 'number') {
      args[key] = Number(raw);
      if (!Number.isFinite(args[key])) throw new Error(`${argv[i - 1]} must be a number`);
    } else if (kind === 'list') args[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    else if (kind === 'numlist') args[key] = raw.split(',').map((s) => Number(s.trim()));
    else args[key] = raw;
  }
  return args;
}

const QUORUM_KEY_GAP = 'Proof verification error: quorum key unavailable for quorum 107:1c64a92f: invalid quorum: Quorum not found in cache for hash: 1c64a92f';

/**
 * Offline checks on the shared plumbing, run by every `--self-test`. These exist because a recorder method that lost
 * `this` when destructured reported "write failed" for documents that HAD landed, so their ids were never
 * checkpointed and every re-run wrote them again.
 */
export async function plumbingAssertions() {
  const file = join(tmpdir(), `seed-plumbing-${process.pid}.local.json`);
  try {
    const state = { docs: {} };
    const ok = { createDoc: async (actor, docType, key) => ({ id: `id/${key}`, skipped: false }) };
    // DESTRUCTURED on purpose: this is exactly how the feature modules call it.
    const { createDoc, id, tally } = createRecorder({ writer: ok, state, file });
    const wrote = await createDoc({ ownerId: 'owner' }, 'thing', 'k1', {});
    const afterWrite = { ...tally };
    const adopted = await createDoc({ ownerId: 'owner' }, 'thing', 'k2', {}, { adopt: async () => 'adopted-id' });
    const afterAdopt = { ...tally };
    const repeat = await createDoc({ ownerId: 'owner' }, 'thing', 'k1', {});
    const boom = createRecorder({ writer: { createDoc: async () => { throw new Error('refused'); } }, state: { docs: {} }, file });
    const failed = await boom.createDoc({ ownerId: 'owner' }, 'thing', 'k3', {});
    // Drive's refusal of an owner scan on a doctype with no $ownerId index, as sakura returned it for
    // storefront v8's `orderStatusUpdate`: the "(429 bytes truncated)" tail once read as a rate limit.
    const indexRefusal = `message=transport error: grpc error: code: 'Client specified an invalid argument', message: "where clause on non indexed property error: query must be for valid indexes, valid indexes are: {…} (429 bytes truncated)" | json={"__wbg_ptr":1429504}`;
    const queries = [];
    const refusing = { documents: { query: async (q) => { queries.push(q); throw new Error(indexRefusal); } } };
    const refusedProbe = await findRecentByValues(refusing, { contractId: 'c', docType: 'orderStatusUpdate', ownerId: 'owner', data: { status: 'shipped' } });
    const refusedQueries = queries.length;
    const ownerBytes = bs58.decode(fakeId('owner'));
    const scoped = { documents: { query: async (q) => { queries.push(q); return new Map([
      ['a', { $id: 'other-owners', $ownerId: bs58.decode(fakeId('someone-else')), status: 'shipped' }],
      ['b', { $id: 'mine', $ownerId: ownerBytes, status: 'shipped' }],
    ]); } } };
    const scope = { where: [['orderId', '==', 'o1']], orderBy: [['orderId', 'desc'], ['$createdAt', 'desc']] };
    const scopedProbe = await findRecentByValues(scoped, { contractId: 'c', docType: 'orderStatusUpdate', ownerId: fakeId('owner'), data: { status: 'shipped' }, scope });
    // A priced create refused 40134 (the epoch multiplier moved past the 20% tolerance) must
    // retry with a FRESH agreement; re-sending the first one is refused the same way forever.
    await ensureInitialized();
    const signer = { ownerId: fakeId('owner'), lock: (fn) => fn() };
    /** A writer over a fake chain: `visible(id, creates)` says whether a stored id is readable yet, `byValue(creates)` what the owner scan returns. */
    const fakeWriter = ({ create, visible = () => false, byValue = () => [], agreementFor }) => {
      let creates = 0;
      const writer = createDocWriter({
        handle: { sdk: { documents: {
          get: async (c, t, docId) => (visible(docId, creates) ? {} : null),
          query: async () => new Map(byValue(creates).map((doc) => [doc.$id, doc])),
        } }, reconnect: async () => {} },
        contractId: fakeId('contract'), entropyFor: (k) => sha256(utf8(k)), paymentInfo: () => ({}),
        ...(agreementFor ? { agreementFor } : {}),
        create: async (sdk, opts) => { creates += 1; return create(opts, creates); },
        wait: async () => {},
      });
      return { writer, creates: () => creates };
    };
    // A wait that throws after the broadcast landed (the DAPI 504 quirk) is not a refusal.
    const LOST_WAIT = 'wait for state transition result failed: 504 Gateway Timeout';
    const recover = async (chain, key) => {
      const docs = { docs: {} };
      const { createDoc, id } = createRecorder({ writer: chain.writer, state: docs, file });
      await createDoc(signer, 'blog', key, { name: key });
      return { recorded: id(key), creates: chain.creates() };
    };
    // A priced create refused 40134 (the epoch multiplier moved past the 20% tolerance) must
    // retry with a FRESH agreement; re-sending the first one is refused the same way forever.
    let agreements = 0;
    const offered = [];
    const priced = fakeWriter({
      agreementFor: async () => ({ permille: ++agreements }),
      visible: (docId) => docId === 'landed',
      create: ({ agreement }) => {
        offered.push(agreement.permille);
        if (agreement.permille === 1) throw new Error('consensus error code=40134: fee multiplier is 1500 permille, outside the agreement');
        return { id: 'landed' };
      },
    });
    const retried = await priced.writer.createDoc(signer, 'blog', 'priced', { name: 'x' });
    // (a) the create derives its id, lands, then its wait throws: recovered by that id.
    const derivedThenThrew = await recover(fakeWriter({
      visible: (docId) => docId === 'derived-1',
      create: ({ onDerivedId }) => { onDerivedId('derived-1'); throw new Error(LOST_WAIT); },
    }), 'a');
    // (b) attempt 1's document only shows up after attempt 2 derived a second id: attempt 1's id is the one kept.
    const lateFirst = await recover(fakeWriter({
      visible: (docId, creates) => docId === 'derived-1' && creates >= 2,
      create: ({ onDerivedId }, n) => { onDerivedId(`derived-${n}`); throw new Error(LOST_WAIT); },
    }), 'b');
    // (c) no derived id is ever readable, but the owner's value readback finds the document.
    const byValueOnly = await recover(fakeWriter({
      byValue: (creates) => (creates > 0 ? [{ $id: 'found-by-value', $ownerId: signer.ownerId, name: 'c' }] : []),
      create: ({ onDerivedId }) => { onDerivedId('never-visible'); throw new Error(LOST_WAIT); },
    }), 'c');
    return [
      ['a 40134 is retried with a freshly resolved agreement, and the retry lands', retried.id === 'landed' && JSON.stringify(offered) === '[1,2]'],
      ['a create whose wait threw after landing is recovered by its derived id, with no second create',
        derivedThenThrew.recorded === 'derived-1' && derivedThenThrew.creates === 1],
      ['an earlier attempt that lands late is recovered by ITS id after a later attempt derived another, and creates stop',
        lateFirst.recorded === 'derived-1' && lateFirst.creates === 2],
      ['when no derived id is readable the value readback still finds the document, with no second create',
        byValueOnly.recorded === 'found-by-value' && byValueOnly.creates === 1],
      ['an index refusal is not transient, whatever byte count its truncated text carries',
        NOT_QUERYABLE_BY_OWNER.test(indexRefusal) && !RETRYABLE.test(indexRefusal) && !WAIT_MAYBE_LANDED.test(indexRefusal)],
      ['real 429/503/504 statuses still read as transient', RETRYABLE.test('HTTP 429 Too Many Requests') && RETRYABLE.test('status: 503') && WAIT_MAYBE_LANDED.test('504 Gateway Time-out')],
      ['a beta.6 quorum key gap on a write is waited out by readback, not read as a refusal',
        QUORUM_GAP.test(QUORUM_KEY_GAP) && TRANSPORT_COLLAPSE.test(QUORUM_KEY_GAP) && settlePollsFor(new Error(QUORUM_KEY_GAP)) > SETTLE_POLLS],
      ['a status code inside an id is not a status', !RETRYABLE.test('document 7Hx503abc not found') && !WAIT_MAYBE_LANDED.test('id 9k504Zq refused')],
      ['a value probe on a doctype with no owner index answers null after two queries, without throwing', refusedProbe === null && refusedQueries === 2],
      ['a scoped value probe queries the scope and only adopts the owner\'s document',
        scopedProbe === 'mine' && queries[2]?.where === scope.where && queries[2]?.orderBy === scope.orderBy],

      ['a destructured recorder.createDoc records the id it wrote', wrote === 'id/k1' && id('k1') === 'id/k1'],
      ['a destructured recorder.createDoc counts the write', afterWrite.created === 1 && afterWrite.failed === 0],
      ['an adopted document is recorded as already present', adopted === 'adopted-id' && id('k2') === 'adopted-id' && afterAdopt.skipped === 1],
      ['a checkpointed key is returned without writing again', repeat === 'id/k1' && tally.skipped === 2],
      ['a refused write is collected, not thrown', failed === null && boom.tally.failed === 1],
    ];
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * True when the target cut named by `envName` (unset = the first) is `topology`
 * or later in `topologies`, which mirror lib/constants.ts's lists.
 */
export const topologyAtLeast = (topologies, envName, topology) =>
  topologies.indexOf(envValue(envName) ?? topologies[0]) >= topologies.indexOf(topology);

export const envValue = (name) => process.env[name]?.trim() || readEnvFile(join(REPO_ROOT, '.env.devnet'))[name] || undefined;

/** `--contract`, else the feature's own override, else the app's env var. */
export const resolveContractId = (explicit, envNames) => explicit ?? envNames.map(envValue).find(Boolean) ?? null;

export const stateFile = (name) => join(REPO_ROOT, name);

export { loadLedger, network, describeErr, REPO_ROOT };
