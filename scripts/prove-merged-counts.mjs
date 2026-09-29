/**
 * Live proof of the beta.7 social v10 count consolidation (docs/SOCIAL_V10.md,
 * "Merged count indexes"). The re-cut drops every count-only index whose list
 * twin can carry the count, and the app then counts through the twins:
 *
 *   post    ownerAndTime [$ownerId, $createdAt]   rangeCountable, ranked at $ownerId
 *           quotesOfPost / quotesOfReply [quoted…, $createdAt]  rangeCountable
 *           ownerAndQuotedPost / ownerAndQuotedReply   unique, skipIfAbsent (one repost/quote per target)
 *   reply   repliesOf [rootPostId, replyToReplyId, $createdAt]  rangeCountable, ranked at rootPostId
 *   follow  following [$ownerId, $createdAt]       rangeCountable
 *           followers [followingId, $createdAt]    rangeCountable, ranked at followingId
 *
 * rs-drive's count index picker (v4.2.0-beta.7, drive_document_count_query/
 * index_picker.rs) serves a count pinning every property but the last of a
 * rangeCountable index (the prefix-to-last form), and any contiguous pin at or
 * below the shallowest `at` level of a prefix-level ranking (the at-chain
 * form); the composite feed's count slots use the same picker. This script
 * proves each query shape the client issues against a THROWAWAY contract
 * whose post, reply and follow types are copied verbatim from
 * contracts/yappr-social-contract-v10.json (index lists, properties, rules),
 * minus what needs other documents or tokens (refersTo, action fees, token
 * costs, moderation). So what passes here is the exact index layout the
 * social contract publishes.
 *
 * Writes (3 owners A/B/C, 3 targets T1-T3), then asserts:
 *   q1-q4  quote counts: single `==`, batched `in` + groupBy, composite slot, list
 *   a1-a3  posts per author: single, batched, ranked top authors
 *   u1-u3  one quote/repost per author per target (40105), a post needs a body (10422)
 *   r1-r9  repliesOf: thread count, per-reply count, direct-to-root (null pin)
 *          list asc/desc + paging, children of a reply, whole-thread scan,
 *          batched per root, batched per reply, composite slot, ranked roots
 *   f1-f5  follower / following counts: single, batched, ranked
 *   c1-c3  composite count slots (feed page, a replies page, the author card)
 *   c2x/c3x  a bound slot extending the page's own index path is refused
 *          ("lands at the merged root"): such counts are separate queries
 *
 * Usage (NETWORK=devnet; the devnet from the env or `.env.devnet`):
 *   node scripts/prove-merged-counts.mjs --bot 1 --bot 2 --bot 3
 *   node scripts/prove-merged-counts.mjs --identity-id <id> --key-wif-file <file> (×3, in order)
 *   node scripts/prove-merged-counts.mjs --dry-run      # offline: build + validate the contract and fixture
 *
 * `--bot <n>` signs as seed index n (E2E_SEED_PHRASE) with identity id n of
 * the pool (DEVNET_IDENTITY_IDS, else E2E_IDENTITY_IDS; `--bot n:<id>` names
 * it). A `--key-wif-file` holds one WIF of a HIGH or CRITICAL authentication
 * key of the identity before it. Never the maker: the contract is throwaway.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataContract, PlatformVersion, PrivateKey, ensureInitialized } from '@dashevo/evo-sdk';
import initWasmDpp2, { DataContract as NodeRulesDataContract, PlatformVersion as NodeRulesPlatformVersion } from '@dashevo/wasm-dpp2';
import bs58 from 'bs58';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { devnetConfig, devnetSdk, envValue } from './sdk-env.mjs';
import { REPO_ROOT, createdId, findRecentByValues } from './seed/seed-lib.mjs';
import { buildDocument, randomIdBytes } from './verify-lib.mjs';

const SOCIAL_V10 = join(REPO_ROOT, 'contracts/yappr-social-contract-v10.json');
const DRY_RUN_OWNER = '11111111111111111111111111111111';
const SETTLE_MS = 3000;
const DUPLICATE_UNIQUE = /\bcode"?\s*[=:]\s*40105\b|duplicate unique properties/i;
const RULE_BROKEN = /\bcode"?\s*[=:]\s*10422\b|does not hold/i;
const CONSENSUS_CODE = /\bcode"?\s*[=:]\s*\d{4,5}\b/;

// ---- The throwaway contract -------------------------------------------------

/** Removes every `refersTo` (a reference needs its target documents or identities to exist). */
function withoutReferences(value) {
  if (Array.isArray(value)) return value.map(withoutReferences);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'refersTo').map(([key, inner]) => [key, withoutReferences(inner)]));
}

/** post, reply and follow exactly as social v10 declares their indexes and properties. */
function proofContractSource() {
  const social = JSON.parse(readFileSync(SOCIAL_V10, 'utf8'));
  const documentSchemas = {};
  for (const type of ['post', 'reply', 'follow']) {
    const schema = withoutReferences(social.documentSchemas[type]);
    for (const key of ['actionFees', 'tokenCost', 'moderatorAbilities']) delete schema[key];
    documentSchemas[type] = schema;
  }
  const config = { ...social.config };
  delete config.moderation;
  return { $formatVersion: social.$formatVersion, version: 1, config, documentSchemas };
}

function contractJson(source, { id, ownerId }) {
  return { ...source, id, ownerId };
}

// ---- Arguments --------------------------------------------------------------

function parseArgs(argv) {
  const args = { actors: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--bot': {
        const [index, id] = argv[++i].split(':');
        args.actors.push({ kind: 'bot', index: Number(index), id: id || null });
        break;
      }
      case '--identity-id': args.actors.push({ kind: 'wif', id: argv[++i], wifFile: null }); break;
      case '--key-wif-file': {
        const last = args.actors.at(-1);
        if (!last || last.kind !== 'wif' || last.wifFile) throw new Error('--key-wif-file follows its --identity-id');
        last.wifFile = argv[++i];
        break;
      }
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dryRun && args.actors.length !== 3) throw new Error('name exactly three identities (--bot <n> or --identity-id <id> --key-wif-file <file>), in the order A B C');
  for (const actor of args.actors) {
    if (actor.kind === 'bot' && !Number.isInteger(actor.index)) throw new Error('--bot takes a seed index (optionally <n>:<identityId>)');
    if (actor.kind === 'wif' && !actor.wifFile) throw new Error(`--identity-id ${actor.id} needs its --key-wif-file`);
  }
  return args;
}

function poolIds() {
  return (envValue('DEVNET_IDENTITY_IDS') || envValue('E2E_IDENTITY_IDS') || '').split(',').map((id) => id.trim()).filter(Boolean);
}

async function resolveActor(sdk, actor, label) {
  if (actor.kind === 'bot') {
    const ownerId = actor.id ?? poolIds()[actor.index];
    if (!ownerId) throw new Error(`no identity id for bot ${actor.index}: pass --bot ${actor.index}:<id> or set E2E_IDENTITY_IDS`);
    const owner = resolveOwner({ botIndex: actor.index, ownerId });
    return { label, ownerId, ...(await signerFor(sdk, owner)) };
  }
  const wif = readFileSync(actor.wifFile, 'utf8').trim();
  const hash = PrivateKey.fromWIF(wif).getPublicKeyHash();
  const identity = await sdk.identities.fetch(actor.id);
  if (!identity) throw new Error(`identity ${actor.id} not found`);
  const key = identity.publicKeys.find((candidate) => candidate.getPublicKeyHash() === hash
    && /^auth/i.test(candidate.purpose) && /^(critical|high)$/i.test(candidate.securityLevel));
  if (!key) throw new Error(`${actor.wifFile} is not a HIGH or CRITICAL authentication key of ${actor.id}`);
  return { label, ownerId: actor.id, ...(await signerFor(sdk, { ownerId: actor.id, keyId: key.keyId, wif })) };
}

// ---- Reporting --------------------------------------------------------------

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
/**
 * Grouped counts as sets: the node returns groups in key-byte order, and a
 * group with no documents is absent rather than 0.
 */
const sameCounts = (actual, expected) => {
  const nonZero = (counts) => Object.entries(counts).filter(([, n]) => n !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return same(nonZero(actual), nonZero(expected));
};
const COMPOSITE_MERGED_ROOT = /lands at the merged root/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one query, recording a thrown refusal as that query's FAIL instead of aborting the run. */
async function attempt(label, fn, verdict) {
  try {
    const value = await fn();
    verdict(value);
  } catch (e) {
    check(label, false, `refused: ${describeErr(e).slice(0, 300)}`);
  }
}

// ---- Result decoding --------------------------------------------------------

const toBase58 = (value) => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return /^[0-9a-f]{64}$/i.test(value) ? bs58.encode(Buffer.from(value, 'hex')) : value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return bs58.encode(Uint8Array.from(value));
};
/** A count answer as `{ key → number }`, keys base58 (the total is keyed ''). */
const countEntries = (map) => Object.fromEntries([...map.entries()].map(([key, value]) => [key === '' ? '' : toBase58(key), Number(value)]));
const total = (map) => Number(map.get('') ?? 0n);
const docsOf = (result) => (result instanceof Map ? [...result.values()] : Object.values(result ?? {})).filter(Boolean);
const idOf = (doc) => toBase58(doc.id ?? doc.$id ?? doc.toObject?.().$id);

// ---- The run ----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await Promise.all([ensureInitialized(), initWasmDpp2()]);
  const source = proofContractSource();

  // Offline: both parsers accept the throwaway contract, and every fixture document builds.
  DataContract.fromJSON(contractJson(source, { id: DRY_RUN_OWNER, ownerId: DRY_RUN_OWNER }), true, PlatformVersion.latest());
  NodeRulesDataContract.fromJSON(contractJson(source, { id: DRY_RUN_OWNER, ownerId: DRY_RUN_OWNER }), true, NodeRulesPlatformVersion.latest());
  const indexes = Object.fromEntries(Object.entries(source.documentSchemas).map(([type, schema]) => [type, schema.indices.map((index) => index.name)]));
  console.log(`throwaway contract parses (wasm-sdk + wasm-dpp2): ${JSON.stringify(indexes)}`);
  if (args.dryRun) {
    const id = bs58.encode(randomIdBytes());
    for (const [docType, data] of [['post', { content: 'x' }], ['post', { quotedPostId: bs58.decode(id), quotedPostOwnerId: bs58.decode(id) }], ['reply', { rootPostId: bs58.decode(id), parentOwnerId: bs58.decode(id), content: 'x' }], ['follow', { followingId: bs58.decode(id) }]]) {
      buildDocument({ contractId: DRY_RUN_OWNER, docType, ownerId: DRY_RUN_OWNER, data, entropy: randomIdBytes() });
    }
    const { devnetName, addresses } = devnetConfig();
    console.log(`fixture documents build; would register on devnet "${devnetName}" via ${addresses[0]} (+${addresses.length - 1} more)`);
    return 0;
  }

  const config = devnetConfig();
  const sdk = devnetSdk({ timeoutMs: 30000, config });
  await sdk.connect();
  await sdk.epoch.current(); // protocol-version ratchet (see verify-lib buildConnectedSdk)
  const [A, B, C] = await Promise.all(args.actors.map((actor, i) => resolveActor(sdk, actor, 'ABC'[i])));
  console.log(`devnet "${config.devnetName}"; A=${A.ownerId} B=${B.ownerId} C=${C.ownerId}`);
  if (new Set([A.ownerId, B.ownerId, C.ownerId]).size !== 3) throw new Error('A, B and C must be three different identities');

  // Register.
  const nonce = ((await sdk.identities.nonce(A.ownerId)) ?? 0n) + 1n;
  const draft = DataContract.fromJSON(contractJson(source, { id: DataContract.generateId(A.ownerId, nonce).toBase58(), ownerId: A.ownerId }), true, PlatformVersion.latest());
  const published = await sdk.contracts.publish({ dataContract: draft, identityKey: A.identityKey, signer: A.signer });
  const contractId = published.id.toBase58();
  console.log(`throwaway contract registered by A: ${contractId}`);
  await sleep(SETTLE_MS);
  await sdk.contracts.fetch(contractId);

  const id = (value) => bs58.decode(value);
  async function create(who, docType, data) {
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy: randomIdBytes() });
    const since = Date.now();
    let error = null;
    try {
      const created = await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
      const createdAs = createdId(created);
      if (createdAs) return { ok: true, id: createdAs };
    } catch (e) {
      error = describeErr(e);
      if (CONSENSUS_CODE.test(error)) return { ok: false, error };
    }
    // A confirmation-wait fault is not a verdict: the chain decides.
    for (let tries = 0; tries < 5; tries++) {
      await sleep(SETTLE_MS);
      const found = await findRecentByValues(sdk, { contractId, docType, ownerId: who.ownerId, data, since }).catch(() => null);
      if (found) return { ok: true, id: found };
    }
    return { ok: false, error: error ?? 'no document after the write' };
  }
  async function mustCreate(label, who, docType, data) {
    const outcome = await create(who, docType, data);
    if (!outcome.ok) throw new Error(`fixture write ${label} failed: ${(outcome.error ?? '').slice(0, 300)}`);
    return outcome.id;
  }

  // ---- Fixture ----
  console.log('\n--- writing the fixture ---');
  const T1 = await mustCreate('T1', A, 'post', { content: 'target one' });
  const T2 = await mustCreate('T2', A, 'post', { content: 'target two' });
  const T3 = await mustCreate('T3', A, 'post', { content: 'target three' });
  await mustCreate('q1 (B quotes T1)', B, 'post', { content: 'quote one', quotedPostId: id(T1), quotedPostOwnerId: id(A.ownerId) });
  await mustCreate('q2 (B reposts T2, no content)', B, 'post', { quotedPostId: id(T2), quotedPostOwnerId: id(A.ownerId) });
  await mustCreate('q3 (C quotes T1)', C, 'post', { content: 'quote three', quotedPostId: id(T1), quotedPostOwnerId: id(A.ownerId) });
  const r1 = await mustCreate('r1 (B → T1)', B, 'reply', { content: 'r1', rootPostId: id(T1), parentOwnerId: id(A.ownerId) });
  await sleep(1100);
  const r2 = await mustCreate('r2 (C → T1)', C, 'reply', { content: 'r2', rootPostId: id(T1), parentOwnerId: id(A.ownerId) });
  const r3 = await mustCreate('r3 (A → r1)', A, 'reply', { content: 'r3', rootPostId: id(T1), replyToReplyId: id(r1), parentOwnerId: id(B.ownerId) });
  await sleep(1100);
  const r4 = await mustCreate('r4 (C → r1)', C, 'reply', { content: 'r4', rootPostId: id(T1), replyToReplyId: id(r1), parentOwnerId: id(B.ownerId) });
  const r5 = await mustCreate('r5 (B → r3)', B, 'reply', { content: 'r5', rootPostId: id(T1), replyToReplyId: id(r3), parentOwnerId: id(A.ownerId) });
  await mustCreate('r6 (A → T2)', A, 'reply', { content: 'r6', rootPostId: id(T2), parentOwnerId: id(A.ownerId) });
  await mustCreate('qr (A reposts r1)', A, 'post', { quotedReplyId: id(r1), quotedPostOwnerId: id(B.ownerId) });
  for (const [who, whom] of [[A, B], [C, B], [A, C], [B, A]]) await mustCreate(`${who.label} follows ${whom.label}`, who, 'follow', { followingId: id(whom.ownerId) });
  await sleep(SETTLE_MS);

  const q = (documentTypeName, rest) => ({ dataContractId: contractId, documentTypeName, ...rest });
  const count = (documentTypeName, where, groupBy) => sdk.documents.count(q(documentTypeName, { where, ...(groupBy ? { groupBy } : {}) }));

  // ---- u: uniqueness and the body rule ----
  console.log('\n--- u. one quote/repost per author per target; a post needs a body ---');
  const u1 = await create(B, 'post', { content: 'quote again', quotedPostId: id(T1), quotedPostOwnerId: id(A.ownerId) });
  check('u1 B quoting T1 a second time is refused 40105 (ownerAndQuotedPost)', !u1.ok && DUPLICATE_UNIQUE.test(u1.error ?? ''), (u1.error ?? 'accepted').slice(0, 200));
  const u2 = await create(A, 'post', { quotedReplyId: id(r1), quotedPostOwnerId: id(B.ownerId) });
  check('u2 A reposting r1 a second time is refused 40105 (ownerAndQuotedReply)', !u2.ok && DUPLICATE_UNIQUE.test(u2.error ?? ''), (u2.error ?? 'accepted').slice(0, 200));
  const u3 = await create(C, 'post', { sensitive: true });
  check('u3 a post with no content, media, embed or quote is refused 10422 (notEmpty)', !u3.ok && RULE_BROKEN.test(u3.error ?? ''), (u3.error ?? 'accepted').slice(0, 200));

  // ---- q: quote (= repost) counts ----
  console.log('\n--- q. quote counts on quotesOfPost / quotesOfReply ---');
  await attempt('q1', () => count('post', [['quotedPostId', '==', T1]]), (m) => check('q1 quotes of T1: `quotedPostId ==` (prefix-to-last on quotesOfPost) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('q1b', () => count('post', [['quotedPostId', '==', T1], ['$createdAt', '>', 0]]), (m) => check('q1b same with a `$createdAt > 0` range (range-aggregate form) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('q2', () => count('post', [['quotedPostId', 'in', [T1, T2, T3]]], ['quotedPostId']), (m) => check('q2 batched `in` + groupBy: T1 2, T2 1, T3 absent (0)', sameCounts(countEntries(m), { [T1]: 2, [T2]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('q3', () => count('post', [['quotedReplyId', '==', r1]]), (m) => check('q3 reposts of reply r1 (quotesOfReply) = 1', total(m) === 1, JSON.stringify(countEntries(m))));
  await attempt('q4', () => sdk.documents.query(q('post', { where: [['quotedPostId', 'in', [T1]]], orderBy: [['quotedPostId', 'asc'], ['$createdAt', 'desc']], limit: 50 })), (r) => check('q4 the quote list (the app\'s `in [id]` shape) returns both quotes of T1', docsOf(r).length === 2, `${docsOf(r).length} doc(s)`));

  // ---- a: posts per author ----
  console.log('\n--- a. posts per author on ownerAndTime ---');
  await attempt('a1', () => count('post', [['$ownerId', '==', A.ownerId]]), (m) => check('a1 A\'s posts: `$ownerId ==` = 4', total(m) === 4, JSON.stringify(countEntries(m))));
  await attempt('a2', () => count('post', [['$ownerId', 'in', [A.ownerId, B.ownerId, C.ownerId]]], ['$ownerId']), (m) => check('a2 batched per author: A 4, B 2, C 1', sameCounts(countEntries(m), { [A.ownerId]: 4, [B.ownerId]: 2, [C.ownerId]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('a3', () => sdk.documents.ranked(q('post', { groupBy: '$ownerId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
    const got = r.entries.map((entry) => [toBase58(entry.groupValue), Number(entry.value)]);
    check('a3 ranked top authors (rankedCountable at $ownerId): A 4, B 2, C 1', same(got, [[A.ownerId, 4], [B.ownerId, 2], [C.ownerId, 1]]), JSON.stringify(got));
  });

  // ---- r: replies on repliesOf ----
  console.log('\n--- r. replies on repliesOf [rootPostId, replyToReplyId, $createdAt] ---');
  const ids = (r) => docsOf(r).map(idOf);
  await attempt('r1', () => count('reply', [['rootPostId', '==', T1]]), (m) => check('r1 whole-thread count of T1 (at-chain, depth 1) = 5', total(m) === 5, JSON.stringify(countEntries(m))));
  await attempt('r2', () => count('reply', [['rootPostId', '==', T1], ['replyToReplyId', '==', r1]]), (m) => check('r2 replies to r1 (depth 2) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('r2b', () => count('reply', [['rootPostId', '==', T1], ['replyToReplyId', '==', null]]), (m) => check('r2b direct replies to T1 (null pin) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('r3', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 10 })), (r) => check('r3 direct replies to T1, oldest first: r1, r2', same(ids(r), [r1, r2]), JSON.stringify(ids(r))));
  await attempt('r3b', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'desc']], limit: 10 })), (r) => check('r3b the same newest first: r2, r1', same(ids(r), [r2, r1]), JSON.stringify(ids(r))));
  await attempt('r3c', async () => {
    const first = await sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 1 }));
    const next = await sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 1, startAfter: ids(first)[0] }));
    return [...ids(first), ...ids(next)];
  }, (got) => check('r3c paging (limit 1 + startAfter) walks r1 then r2', same(got, [r1, r2]), JSON.stringify(got)));
  await attempt('r4', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', r1]], orderBy: [['$createdAt', 'asc']], limit: 10 })), (r) => check('r4 children of r1, oldest first: r3, r4', same(ids(r), [r3, r4]), JSON.stringify(ids(r))));
  await attempt('r5', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1]], orderBy: [['replyToReplyId', 'asc'], ['$createdAt', 'asc']], limit: 100 })), (r) => {
    const got = ids(r);
    check('r5 whole thread by prefix scan: all 5, grouped by parent (direct first, under null)', got.length === 5 && same(got.slice(0, 2), [r1, r2]) && new Set(got).size === 5 && got.includes(r5), JSON.stringify(got));
  });
  await attempt('r6', () => count('reply', [['rootPostId', 'in', [T1, T2, T3]]], ['rootPostId']), (m) => check('r6 batched thread counts: T1 5, T2 1, T3 0', sameCounts(countEntries(m), { [T1]: 5, [T2]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('r7', () => count('reply', [['rootPostId', '==', T1], ['replyToReplyId', 'in', [r1, r2, r3]]], ['replyToReplyId']), (m) => check('r7 batched per-reply counts under T1: r1 2, r3 1, r2 0', sameCounts(countEntries(m), { [r1]: 2, [r3]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('r8', () => sdk.documents.ranked(q('reply', { groupBy: 'rootPostId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
    const got = r.entries.map((entry) => [toBase58(entry.groupValue), Number(entry.value)]);
    check('r8 ranked most-replied roots (at rootPostId): T1 5, T2 1', same(got, [[T1, 5], [T2, 1]]), JSON.stringify(got));
  });

  // ---- f: follows ----
  console.log('\n--- f. follower / following counts ---');
  await attempt('f1', () => count('follow', [['followingId', '==', B.ownerId]]), (m) => check('f1 B\'s followers (followers, at-chain) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('f2', () => count('follow', [['$ownerId', '==', A.ownerId]]), (m) => check('f2 A follows (following, prefix-to-last) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('f3', () => count('follow', [['followingId', 'in', [A.ownerId, B.ownerId, C.ownerId]]], ['followingId']), (m) => check('f3 batched followers: A 1, B 2, C 1', sameCounts(countEntries(m), { [A.ownerId]: 1, [B.ownerId]: 2, [C.ownerId]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('f4', () => count('follow', [['$ownerId', 'in', [A.ownerId, B.ownerId, C.ownerId]]], ['$ownerId']), (m) => check('f4 batched following: A 2, B 1, C 1', sameCounts(countEntries(m), { [A.ownerId]: 2, [B.ownerId]: 1, [C.ownerId]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('f5', () => sdk.documents.ranked(q('follow', { groupBy: 'followingId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
    const got = r.entries.map((entry) => [toBase58(entry.groupValue), Number(entry.value)]);
    check('f5 ranked most followed (at followingId): B 2 first, then A and C at 1', got.length === 3 && same(got[0], [B.ownerId, 2]) && got.slice(1).every(([, n]) => n === 1), JSON.stringify(got));
  });

  // ---- c: the composite feed's count slots (one proof per page) ----
  console.log('\n--- c. composite count slots ---');
  await attempt('c1', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'post',
    where: [['$ownerId', '==', A.ownerId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 10,
    subQueries: [
      { documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field: 'quotedPostId' } },
      { documentType: 'reply', kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field: 'rootPostId' } },
    ],
  }), (result) => {
    const [quotes, replies] = result.subResults.map((sub) => countEntries(sub.counts));
    check('c1 feed page slots: quotes per post (T1 2, T2 1) and replies per root (T1 5, T2 1)', quotes[T1] === 2 && quotes[T2] === 1 && !quotes[T3] && replies[T1] === 5 && replies[T2] === 1 && !replies[T3], `quotes ${JSON.stringify(quotes)} replies ${JSON.stringify(replies)}`);
  });
  // A limited page may not sit at the merged root: a bound sub-query whose
  // index path extends the page's is refused ("lands at the merged root").
  // c2/c3 are the shapes the client uses (page on another path); c2x/c3x pin
  // the refusal so the client never builds the conflicting shape.
  await attempt('c2', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'reply',
    where: [['$ownerId', '==', B.ownerId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 10,
    subQueries: [
      { documentType: 'reply', kind: 'counts', where: [['rootPostId', '==', T1]], bind: { source: 'page', sourceProperty: '$id', field: 'replyToReplyId' } },
      { documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field: 'quotedReplyId' } },
    ],
  }), (result) => {
    const [children, reposts] = result.subResults.map((sub) => countEntries(sub.counts));
    check('c2 B\'s replies (ownerAndTime page) with per-reply slots pinned to T1: children r1 2, r5 0; reposts r1 1', children[r1] === 2 && !children[r5] && reposts[r1] === 1 && !reposts[r5], `children ${JSON.stringify(children)} reposts ${JSON.stringify(reposts)}`);
  });
  await attempt('c3', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'reply',
    where: [['$ownerId', '==', B.ownerId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 1,
    subQueries: [
      { documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } },
      { documentType: 'follow', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: 'followingId' } },
      { documentType: 'follow', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } },
    ],
  }), (result) => {
    const [posts, followers, following] = result.subResults.map((sub) => countEntries(sub.counts)[B.ownerId]);
    check('c3 author-card slots for B off a page of another doctype (the app roots on the profile): posts 2, followers 2, following 1', posts === 2 && followers === 2 && following === 1, `posts ${posts} followers ${followers} following ${following}`);
  });
  const expectMergedRootRefusal = async (label, query) => {
    try {
      await sdk.documents.composite(query);
      check(label, false, 'accepted');
    } catch (e) {
      check(label, COMPOSITE_MERGED_ROOT.test(describeErr(e)), describeErr(e).slice(0, 200));
    }
  };
  await expectMergedRootRefusal('c2x a repliesOf page with a repliesOf count slot is refused (merged root)', {
    dataContractId: contractId, documentType: 'reply', where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 10,
    subQueries: [{ documentType: 'reply', kind: 'counts', where: [['rootPostId', '==', T1]], bind: { source: 'page', sourceProperty: '$id', field: 'replyToReplyId' } }],
  });
  await expectMergedRootRefusal('c3x a post page on $ownerId with a post slot bound to $ownerId is refused (merged root)', {
    dataContractId: contractId, documentType: 'post', where: [['$ownerId', '==', B.ownerId]], orderBy: [['$createdAt', 'asc']], limit: 1,
    subQueries: [{ documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } }],
  });

  console.log(`\nthrowaway contract ${contractId}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
});
