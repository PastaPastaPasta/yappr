/**
 * Shared plumbing for the devnet content-seeding scripts (scripts/seed/*).
 *
 * Everything here is either pure (corpus parsing, persona validation, document
 * building, checkpoint folding) or read-only against the repo (env files,
 * contract JSONs). Network I/O lives in the two entry points and in
 * asset-lock-lib.mjs, so the `--self-test` harnesses can exercise this module
 * without touching the devnet.
 *
 * Hard-won gotchas honored here (see scripts/verify-v4.mjs and
 * scripts/provision-test-identity.mjs for their origin stories):
 *  - `Document.fromObject` with raw-byte identifiers is the only document
 *    construction that survives wasm-sdk 4.1+ (the `Document` constructor
 *    corrupts Uint8Array properties).
 *  - A fresh devnet SDK must run one proved epoch query BEFORE touching a v14
 *    contract (protocol-version ratchet), and must cache the contract for
 *    token-cost proof verification.
 *  - Quorum rotations kill the trusted context mid-run ("Quorum not found in
 *    cache" / "no available addresses"); the only cure is a full reconnect, so
 *    all callers hold a proxy handle that can be re-pointed.
 *  - Never print private keys or WIFs; ledgers are written with mode 600.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPublicKey, utils as secpUtils } from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import bs58check from 'bs58check';
import { Document, PlatformVersion, TokenPaymentInfo } from '@dashevo/evo-sdk';
import { REPO_ROOT, readEnvFile, privateKeyToWif } from '../derive-identities.mjs';
import { describeErr } from '../owner-keys.mjs';
import { buildSdk, insightUrl, keyNetwork, network } from '../sdk-env.mjs';

export { describeErr, REPO_ROOT, readEnvFile, insightUrl, keyNetwork, network };

// ---- File locations (all gitignored: .seed-*.local*) -------------------------

export const TREASURY_KEY_FILE = join(REPO_ROOT, '.seed-treasury.local.key');
export const LEDGER_FILE = join(REPO_ROOT, '.seed-identities.local.json');
export const PROGRESS_FILE = join(REPO_ROOT, '.seed-progress.local.json');
export const REPORT_FILE = join(REPO_ROOT, '.seed-report.local.json');

// ---- Network / contract constants --------------------------------------------

export const YAPP_TOKEN_POSITION = 0;
/** YAPP create costs per doctype (contracts/yappr-social-contract-v4.json tokenCost). */
export const TOKEN_COST = { post: 10, reply: 3, like: 1, likeReply: 1, repost: 1 };
/** Base URL posts are linked as in seeded content ({{link:REF}} substitution). */
export const POST_LINK_BASE = 'https://yap.pr/devnet/post/?id=';
/** base58 of a 32-byte id is at most 44 chars — the worst case a link expands to. */
export const POST_LINK_MAX = POST_LINK_BASE.length + 44;

function envValue(name) {
  if (process.env[name]) return process.env[name];
  return readEnvFile(join(REPO_ROOT, '.env.devnet'))[name] || undefined;
}

/** The social contract under seed (post/reply/like/… doctypes). */
export function socialContractId() {
  const id = envValue('NEXT_PUBLIC_YAPPR_CONTRACT_ID');
  if (!id) throw new Error('NEXT_PUBLIC_YAPPR_CONTRACT_ID missing from the environment and .env.devnet');
  return id;
}

/** The unified profile contract the app reads profiles from. */
export function profileContractId() {
  const id = envValue('NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID');
  if (!id) throw new Error('NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID missing from the environment and .env.devnet');
  return id;
}

// ---- Contract topology (hashtag semantics) -------------------------------------
//
// The corpus format is topology-agnostic: `"hashtag": ""` always means
// "untagged". What that maps to on chain differs:
//   v4 — `hashtag` is REQUIRED on post/like; untagged writes the `''` sentinel.
//   v5 — `hashtag` is OPTIONAL (pattern ^[a-z0-9_]{1,61}$, maxLength 61,
//        contracts/yappr-social-contract-v5.json); an untagged post OMITS the
//        property entirely, and a like of an untagged post OMITS like.hashtag
//        too: propertyAgreement treats both-absent as agreement, while sending
//        `''` is consensus mismatch 40127. The like's delete-by-values tuple
//        must reproduce the same absence (it is the same value tuple). The v5
//        like `byHashtagPost` index is skipIfAbsent — absence simply writes no
//        entry, which needs no seeder action beyond the correct doc shape.

export const TOPOLOGIES = ['v4', 'v5'];
export const HASHTAG_MAX = { v4: 63, v5: 61 };

/** Topology the run targets: NEXT_PUBLIC_CONTRACT_TOPOLOGY (env or the env file), else v4. */
export function defaultTopology() {
  return envValue('NEXT_PUBLIC_CONTRACT_TOPOLOGY') === 'v5' ? 'v5' : 'v4';
}

/**
 * The `hashtag` property (or its absence) for a post/quote/like document.
 * `''` and absent inputs are equivalent ("untagged") so a checkpoint ref
 * recorded either way replays to an identical document.
 */
export function hashtagProps(hashtag, topology) {
  const tag = hashtag ?? '';
  if (topology === 'v5') return tag === '' ? {} : { hashtag: tag };
  return { hashtag: tag };
}

/**
 * The like doc's data value tuple for a target post ref record. Used for the
 * create AND for delete-by-values (indexOnly deletes carry the whole value
 * tuple) — both must mirror the post's propertyAgreement values exactly,
 * including hashtag ABSENCE under v5.
 */
export function likeValueTuple(target, topology) {
  return {
    postId: bs58.decode(target.id),
    ...hashtagProps(target.hashtag, topology),
    postAuthor: bs58.decode(target.ownerId),
  };
}

// ---- Key material -------------------------------------------------------------

/** Dash testnet P2PKH version byte; devnets reuse testnet prefixes. */
const P2PKH_VERSION = { testnet: 0x8c, mainnet: 0x4c };

/** Random secp256k1 keypair, hex-encoded (the only form the ledgers persist). */
export function generateKeypairHex() {
  const privateKeyBytes = secpUtils.randomSecretKey();
  return {
    privateKeyHex: Buffer.from(privateKeyBytes).toString('hex'),
    publicKeyHex: Buffer.from(getPublicKey(privateKeyBytes, true)).toString('hex'),
  };
}

/** P2PKH address for a compressed public key on the active key network. */
export function addressFor(publicKeyHex) {
  const hash160 = ripemd160(sha256(Buffer.from(publicKeyHex, 'hex')));
  const payload = new Uint8Array(21);
  payload[0] = P2PKH_VERSION[keyNetwork()];
  payload.set(hash160, 1);
  return bs58check.encode(payload);
}

/** Compressed testnet WIF for a 64-hex private key (fed to IdentitySigner, never printed). */
export function wifFromHex(privateKeyHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex ?? '')) throw new Error('expected a 64-hex private key');
  return privateKeyToWif(Uint8Array.from(Buffer.from(privateKeyHex, 'hex')));
}

/**
 * The identity key layout every seed identity registers — same purposes and
 * security levels provision-test-identity.mjs registers for the e2e bots.
 * Key 1 (AUTHENTICATION/CRITICAL) signs all state transitions.
 */
export const IDENTITY_KEY_ROLES = [
  { keyId: 0, purpose: 'authentication', securityLevel: 'master' },
  { keyId: 1, purpose: 'authentication', securityLevel: 'critical' },
  { keyId: 2, purpose: 'authentication', securityLevel: 'high' },
  { keyId: 3, purpose: 'transfer', securityLevel: 'critical' },
  { keyId: 4, purpose: 'encryption', securityLevel: 'medium' },
];
export const CRITICAL_AUTH_KEY_ID = 1;

/** Fresh random key set for one seed identity, hex only. */
export function generateIdentityKeySet() {
  return IDENTITY_KEY_ROLES.map((role) => ({ ...role, ...generateKeypairHex() }));
}

// ---- Ledger (.seed-identities.local.json) -------------------------------------
//
// Per-identity state machine, always persisted BEFORE the broadcast the state
// change depends on, so no funds are ever stranded behind key material that
// existed only in memory:
//
//   planned    one-shot asset-lock key + identity key set generated & saved
//   funded     the SPLIT tx paying the one-shot address is broadcast
//   locked     the asset-lock special tx is broadcast (outpoint = txid:0)
//   registered identity created on Platform (identityId recorded)
//   profiled   profile document created on the unified profile contract
//   named      DPNS label registered
//   ready      YAPP purchased (or purchase skipped with --yapp 0)

export const IDENTITY_STATES = ['planned', 'funded', 'locked', 'registered', 'profiled', 'named', 'ready'];

export function stateRank(state) {
  const rank = IDENTITY_STATES.indexOf(state);
  if (rank === -1) throw new Error(`unknown ledger state "${state}"`);
  return rank;
}

/** Atomic, owner-only write: temp file + rename, chmod 600. */
function writePrivateFile(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

const bigintReplacer = (_, value) => (typeof value === 'bigint' ? `${value}n` : value);

export function loadLedger(file = LEDGER_FILE) {
  if (!existsSync(file)) return { network: network(), createdAt: new Date().toISOString(), identities: [] };
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  if (ledger.network !== network()) {
    throw new Error(`${file} was written for network "${ledger.network}", current NETWORK is "${network()}"`);
  }
  return ledger;
}

export function saveLedger(ledger, file = LEDGER_FILE) {
  writePrivateFile(file, JSON.stringify(ledger, bigintReplacer, 2) + '\n');
}

export function ledgerEntry(ledger, personaIdx) {
  return ledger.identities.find((entry) => entry.personaIdx === personaIdx) ?? null;
}

// ---- Personas -----------------------------------------------------------------

/**
 * DPNS label constraints for seed handles: [a-z0-9-], 3–19 chars, no leading or
 * trailing hyphen, and at least one digit 2–9 — a label containing a 2–9 digit
 * can never match DPNS's contested-name pattern, so registration never enters
 * a masternode vote.
 */
export function validateHandle(handle) {
  if (typeof handle !== 'string') return 'handle must be a string';
  if (!/^[a-z0-9-]{3,19}$/.test(handle)) return `handle "${handle}" must be [a-z0-9-], 3-19 chars`;
  if (handle.startsWith('-') || handle.endsWith('-')) return `handle "${handle}" must not start or end with a hyphen`;
  if (!/[2-9]/.test(handle)) return `handle "${handle}" needs at least one digit 2-9 (avoids DPNS contested names)`;
  return null;
}

/** Field limits of the unified profile contract, read from the checked-in JSON. */
export function profileLimits() {
  const contract = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'yappr-profile-contract.json'), 'utf8'));
  const schema = contract.documentSchemas?.profile ?? contract.documents?.profile ?? contract.profile;
  if (!schema) throw new Error('contracts/yappr-profile-contract.json has no profile document schema');
  return schema.properties;
}

/** DiceBear styles the app's avatar renderer accepts (unified-profile-service.ts). */
export const DICEBEAR_STYLES = [
  'adventurer', 'avataaars', 'big-ears', 'big-smile', 'bottts', 'croodles',
  'fun-emoji', 'lorelei', 'micah', 'miniavs', 'notionists', 'open-peeps',
  'personas', 'pixel-art', 'thumbs',
];

/** Deterministic DiceBear style for an avatar seed (stable across runs). */
export function dicebearStyleFor(avatarSeed) {
  const digest = sha256(Buffer.from(String(avatarSeed), 'utf8'));
  return DICEBEAR_STYLES[digest[0] % DICEBEAR_STYLES.length];
}

/** The `avatar` field value the app parses: JSON {seed, style}. */
export function avatarFieldFor(persona) {
  return JSON.stringify({ seed: persona.avatarSeed, style: dicebearStyleFor(persona.avatarSeed) });
}

export function validatePersona(persona, limits) {
  const errors = [];
  if (!Number.isInteger(persona.idx) || persona.idx < 0) errors.push('idx must be a non-negative integer');
  const handleError = validateHandle(persona.handle);
  if (handleError) errors.push(handleError);
  if (typeof persona.displayName !== 'string' || persona.displayName.trim().length < 1) {
    errors.push('displayName is required');
  } else if (persona.displayName.length > (limits.displayName?.maxLength ?? 50)) {
    errors.push(`displayName exceeds ${limits.displayName?.maxLength ?? 50} chars`);
  }
  if (persona.bio !== undefined && (typeof persona.bio !== 'string' || persona.bio.length > (limits.bio?.maxLength ?? 160))) {
    errors.push(`bio exceeds ${limits.bio?.maxLength ?? 160} chars`);
  }
  if (persona.location !== undefined && (typeof persona.location !== 'string' || persona.location.length > (limits.location?.maxLength ?? 50))) {
    errors.push(`location exceeds ${limits.location?.maxLength ?? 50} chars`);
  }
  if (persona.website !== undefined) {
    const max = limits.website?.maxLength ?? 200;
    if (typeof persona.website !== 'string' || persona.website.length > max) errors.push(`website exceeds ${max} chars`);
    else if (!/^https?:\/\/.+$/.test(persona.website)) errors.push('website must match ^https?://.+$');
  }
  if (persona.avatarSeed === undefined || String(persona.avatarSeed).length === 0) errors.push('avatarSeed is required');
  const avatarMax = limits.avatar?.maxLength ?? 512;
  if (avatarFieldFor({ avatarSeed: persona.avatarSeed ?? '' }).length > avatarMax) {
    errors.push(`avatar JSON exceeds ${avatarMax} chars (avatarSeed too long)`);
  }
  return errors;
}

/** Loads and validates a personas file. Throws with every problem listed. */
export function loadPersonas(file) {
  const personas = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(personas) || personas.length === 0) throw new Error(`${file} must be a non-empty array`);
  const limits = profileLimits();
  const problems = [];
  const seenIdx = new Set();
  const seenHandles = new Set();
  personas.forEach((persona, i) => {
    for (const error of validatePersona(persona, limits)) problems.push(`persona[${i}]: ${error}`);
    if (seenIdx.has(persona.idx)) problems.push(`persona[${i}]: duplicate idx ${persona.idx}`);
    seenIdx.add(persona.idx);
    if (seenHandles.has(persona.handle)) problems.push(`persona[${i}]: duplicate handle "${persona.handle}"`);
    seenHandles.add(persona.handle);
  });
  if (problems.length > 0) throw new Error(`invalid personas file ${file}:\n  ${problems.join('\n  ')}`);
  return personas;
}

// ---- Corpus (JSONL) -----------------------------------------------------------

export const OP_TYPES = ['post', 'quote', 'reply', 'like', 'likeReply', 'repost', 'follow', 'bookmark'];
const MEDIA_URL_PATTERN = /^(https?|ipfs):\/\/.+$/;
const LINK_PLACEHOLDER = /\{\{link:([A-Za-z0-9_-]+)\}\}/g;
export const CONTENT_MAX = 500;
export const MEDIA_URL_MAX = 512;

/** Worst-case rendered length of `content` once every {{link:REF}} expands. */
export function expandedContentLength(content) {
  let length = content.length;
  for (const match of content.matchAll(LINK_PLACEHOLDER)) {
    length += POST_LINK_MAX - match[0].length;
  }
  return length;
}

/** Replaces {{link:REF}} with the deployed post URL. `resolve(ref)` → base58 post id. */
export function substituteLinks(content, resolve) {
  return content.replace(LINK_PLACEHOLDER, (_, ref) => `${POST_LINK_BASE}${resolve(ref)}`);
}

/**
 * Parses and validates a corpus JSONL string against the format in
 * CORPUS_FORMAT.md. Every structural rule is enforced here so the executor can
 * assume a well-formed op stream:
 *  - refs are unique and defined before use, with the right kind
 *    (post/quote refs for likes/reposts/bookmarks/quotes, reply refs for
 *    likeReply, either for reply parents);
 *  - authors and follow targets are known persona idx values;
 *  - content fits 500 chars even after {{link}} expansion;
 *  - duplicate interactions that would die as 40105 on chain (same author
 *    liking/reposting/bookmarking/following the same target twice) are
 *    rejected up front as generator bugs.
 *
 * The `topology` option tightens the hashtag length to the target contract's
 * maxLength (63 under v4, 61 under v5) — an over-long tag is a generator bug
 * and is rejected, never rewritten.
 *
 * Returns `{ ops, stats }`; each op carries its 1-based `line`.
 */
export function parseCorpus(text, personas, { topology = 'v4' } = {}) {
  if (!TOPOLOGIES.includes(topology)) throw new Error(`unknown topology "${topology}" (expected ${TOPOLOGIES.join('/')})`);
  const hashtagMax = HASHTAG_MAX[topology];
  const hashtagPattern = new RegExp(`^$|^[a-z0-9_]{1,${hashtagMax}}$`);
  const personaIdxSet = new Set(personas.map((p) => p.idx));
  const refs = new Map(); // ref -> 'post' | 'reply'
  const dedupe = new Set();
  const ops = [];
  const stats = Object.fromEntries(OP_TYPES.map((t) => [t, 0]));
  const problems = [];
  const lines = text.split('\n');

  const fail = (line, message) => problems.push(`line ${line}: ${message}`);

  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    let op;
    try {
      op = JSON.parse(trimmed);
    } catch (e) {
      fail(line, `not valid JSON: ${e.message}`);
      return;
    }
    if (!OP_TYPES.includes(op.type)) {
      fail(line, `unknown type "${op.type}"`);
      return;
    }
    if (!personaIdxSet.has(op.author)) fail(line, `author ${op.author} is not a persona idx`);

    const requireEarlierRef = (ref, kinds, label) => {
      if (typeof ref !== 'string' || !ref) return fail(line, `${label} is required`);
      const kind = refs.get(ref);
      if (!kind) return fail(line, `${label} "${ref}" is not defined earlier in the corpus`);
      if (!kinds.includes(kind)) return fail(line, `${label} "${ref}" is a ${kind}, expected ${kinds.join('/')}`);
      return undefined;
    };

    const checkContent = (content) => {
      if (typeof content !== 'string') return fail(line, 'content must be a string');
      for (const match of content.matchAll(LINK_PLACEHOLDER)) {
        const target = refs.get(match[1]);
        if (!target) fail(line, `{{link:${match[1]}}} references a ref not defined earlier`);
        else if (target !== 'post') fail(line, `{{link:${match[1]}}} must reference a post ref, got ${target}`);
      }
      const expanded = expandedContentLength(content);
      if (expanded > CONTENT_MAX) fail(line, `content can expand to ${expanded} chars (max ${CONTENT_MAX})`);
      return undefined;
    };

    const checkMediaUrl = (mediaUrl) => {
      if (mediaUrl === undefined) return;
      if (typeof mediaUrl !== 'string' || mediaUrl.length > MEDIA_URL_MAX || !MEDIA_URL_PATTERN.test(mediaUrl)) {
        fail(line, `mediaUrl must match ${MEDIA_URL_PATTERN} and fit ${MEDIA_URL_MAX} chars`);
      }
    };

    const defineRef = (ref, kind) => {
      if (typeof ref !== 'string' || !ref) return fail(line, 'ref is required');
      if (refs.has(ref)) return fail(line, `duplicate ref "${ref}"`);
      refs.set(ref, kind);
      return undefined;
    };

    const dedupeKey = (kind, target) => {
      const key = `${kind}:${op.author}:${target}`;
      if (dedupe.has(key)) fail(line, `duplicate ${kind} by author ${op.author} on ${target} (would be a 40105 on chain)`);
      dedupe.add(key);
    };

    switch (op.type) {
      case 'post':
        defineRef(op.ref, 'post');
        checkContent(op.content);
        checkMediaUrl(op.mediaUrl);
        if (typeof op.hashtag !== 'string' || !hashtagPattern.test(op.hashtag)) {
          fail(line, `hashtag "${op.hashtag}" must match ^$|^[a-z0-9_]{1,${hashtagMax}}$ ('' = untagged; ${topology} maxLength ${hashtagMax})`);
        }
        if (op.sensitive !== undefined && typeof op.sensitive !== 'boolean') fail(line, 'sensitive must be a boolean');
        break;
      case 'quote':
        requireEarlierRef(op.quotedRef, ['post'], 'quotedRef');
        defineRef(op.ref, 'post');
        checkContent(op.content);
        checkMediaUrl(op.mediaUrl);
        if (typeof op.hashtag !== 'string' || !hashtagPattern.test(op.hashtag)) {
          fail(line, `hashtag "${op.hashtag}" must match ^$|^[a-z0-9_]{1,${hashtagMax}}$`);
        }
        break;
      case 'reply':
        requireEarlierRef(op.rootRef, ['post'], 'rootRef');
        requireEarlierRef(op.parentRef, ['post', 'reply'], 'parentRef');
        defineRef(op.ref, 'reply');
        checkContent(op.content);
        checkMediaUrl(op.mediaUrl);
        break;
      case 'like':
        requireEarlierRef(op.targetRef, ['post'], 'targetRef');
        dedupeKey('like', op.targetRef);
        break;
      case 'likeReply':
        requireEarlierRef(op.targetRef, ['reply'], 'targetRef');
        dedupeKey('likeReply', op.targetRef);
        break;
      case 'repost':
        requireEarlierRef(op.targetRef, ['post'], 'targetRef');
        dedupeKey('repost', op.targetRef);
        break;
      case 'bookmark':
        requireEarlierRef(op.targetRef, ['post'], 'targetRef');
        dedupeKey('bookmark', op.targetRef);
        break;
      case 'follow':
        if (!personaIdxSet.has(op.target)) fail(line, `follow target ${op.target} is not a persona idx`);
        if (op.target === op.author) fail(line, 'an identity cannot follow itself');
        dedupeKey('follow', op.target);
        break;
      default:
        break;
    }

    stats[op.type] += 1;
    ops.push({ ...op, line });
  });

  if (problems.length > 0) {
    throw new Error(`invalid corpus (${problems.length} problem(s)):\n  ${problems.slice(0, 40).join('\n  ')}${problems.length > 40 ? '\n  …' : ''}`);
  }
  return { ops, stats };
}

/** YAPP a corpus costs in total and per persona idx (create tokenCosts). */
export function corpusYappCost(ops) {
  const perAuthor = new Map();
  let total = 0;
  const costOf = { post: TOKEN_COST.post, quote: TOKEN_COST.post, reply: TOKEN_COST.reply, like: TOKEN_COST.like, likeReply: TOKEN_COST.likeReply, repost: TOKEN_COST.repost };
  for (const op of ops) {
    const cost = costOf[op.type] ?? 0;
    if (cost === 0) continue;
    total += cost;
    perAuthor.set(op.author, (perAuthor.get(op.author) ?? 0) + cost);
  }
  return { total, perAuthor };
}

// ---- Checkpoint journal (.seed-progress.local.json) ---------------------------
//
// Append-only JSON-lines journal: one object per executed corpus line, so a
// crash never loses more than the op in flight and a resume replays nothing.
// Later lines win (a retried failure appends a fresh record).
//   {"line":12,"status":"done","type":"post","ref":"p001","id":"…","ownerId":"…","hashtag":"","at":"…"}
//   {"line":31,"status":"failed","type":"like","error":"…","at":"…"}
//
// A ref's `hashtag` may be recorded as '' OR be absent from the record — both
// mean "untagged" and MUST replay identically: the fold normalizes to '' here,
// and the doc builders (`hashtagProps`) map '' to the topology's shape (''
// sentinel under v4, property absence under v5). Never treat the journal's
// hashtag as always-a-meaningful-string.

export function loadProgress(file = PROGRESS_FILE) {
  const completed = new Map(); // line -> record
  const failed = new Map();
  const refs = new Map(); // ref -> {kind, id, ownerId, hashtag}
  if (!existsSync(file)) return { completed, failed, refs };
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // a torn final line from a crash mid-append
    }
    if (record.status === 'done') {
      completed.set(record.line, record);
      failed.delete(record.line);
      if (record.ref) refs.set(record.ref, { kind: record.kind, id: record.id, ownerId: record.ownerId, hashtag: record.hashtag ?? '' });
    } else if (record.status === 'failed') {
      if (!completed.has(record.line)) failed.set(record.line, record);
    }
  }
  return { completed, failed, refs };
}

export function appendProgress(record, file = PROGRESS_FILE) {
  if (!existsSync(file)) {
    writePrivateFile(file, '');
  }
  appendFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() }, bigintReplacer) + '\n', { mode: 0o600 });
}

// ---- Documents ----------------------------------------------------------------

/**
 * `Document.fromObject` with raw-byte identifiers — the only construction that
 * survives wasm-sdk 4.1+ (the `Document` constructor corrupts Uint8Array
 * properties). Mirrors scripts/verify-v4.mjs `buildDocument`.
 */
export function buildDocument({ contractId, docType, ownerId, data, entropy, revision = 1n, createdAt, id }) {
  const idBytes = id ?? Document.generateId(docType, ownerId, contractId, entropy);
  const document = Document.fromObject(
    {
      $formatVersion: '0',
      $id: idBytes,
      $ownerId: bs58.decode(ownerId),
      $dataContractId: bs58.decode(contractId),
      $type: docType,
      $revision: revision,
      ...(entropy ? { $entropy: entropy } : {}),
      ...(createdAt !== undefined ? { $createdAt: createdAt } : {}),
      ...data,
    },
    PlatformVersion.current()
  );
  return { document, id: bs58.encode(idBytes) };
}

/** Token-payment agreement for token-priced doctypes (post/reply/like/likeReply/repost). */
export function paymentInfo(tokenCost) {
  return tokenCost
    ? {
        tokenPaymentInfo: new TokenPaymentInfo({
          tokenContractPosition: YAPP_TOKEN_POSITION,
          maximumTokenCost: BigInt(tokenCost),
        }),
      }
    : {};
}

export const randomEntropy = () => crypto.getRandomValues(new Uint8Array(32));

// ---- Resilient SDK handle ------------------------------------------------------
//
// Lifted from verify-v4.mjs: quorum rotations invalidate the trusted context's
// prefetched keys mid-run and there is no refresh API — the cure is a FULL
// reconnect (fresh EvoSDK + protocol-version ratchet + contract re-cache). The
// returned `sdk` is a proxy that always forwards to the live instance, so a
// swap is transparent to in-flight helpers.

/** Errors that mean "this SDK instance is dead", not "this request was refused". */
export const TRANSPORT_COLLAPSE = /no available addresses|invalid quorum|quorum not found/i;
/** Confirmation-wait shapes that do NOT mean the write was refused (readback decides). */
export const WAIT_MAYBE_LANDED = /504|gateway|deadline|timed? ?out|timeout|wait.*state.*transition|AffectedState/i;
/** Retry-worthy transient transport noise. */
export const RETRYABLE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network error|503|502|429|unavailable/i;
/** Identity (contract) nonce desync — cured by a reconnect (fresh nonce cache). */
export const NONCE_DESYNC = /nonce/i;
/** Structural duplicate (unique index) — the end state already holds. */
export const DUPLICATE_UNIQUE = /40105|duplicate unique properties/i;

export function createSdkHandle({ contractIds, timeoutMs = 30000, log = console.log }) {
  let activeSdk = null;
  let reconnectPromise = null;

  async function buildConnected() {
    const sdk = buildSdk({ timeoutMs });
    await sdk.connect();
    // PROTOCOL-VERSION RATCHET (load-bearing): the first proved read of a v14
    // contract on a fresh devnet SDK fails inside proof verification AND gets
    // addresses banned — one proved epoch query teaches the SDK the chain's
    // real protocol version first.
    const epochInfo = await sdk.epoch.current();
    // Cache the contracts so token-cost result proofs verify.
    for (const contractId of contractIds) await sdk.contracts.fetch(contractId);
    return { sdk, protocolVersion: epochInfo?.toJSON?.()?.protocolVersion };
  }

  const handle = new Proxy(
    {},
    {
      get(_, prop) {
        if (activeSdk === null) throw new Error('SDK handle used before connect()');
        const value = activeSdk[prop];
        return typeof value === 'function' ? value.bind(activeSdk) : value;
      },
    }
  );

  return {
    sdk: handle,
    async connect() {
      const { sdk, protocolVersion } = await buildConnected();
      activeSdk = sdk;
      return { protocolVersion };
    },
    /** Full rebuild; concurrent callers share one attempt. */
    async reconnect(reason) {
      if (!reconnectPromise) {
        log(`(transport collapsed — reconnecting: ${String(reason).slice(0, 140)})`);
        reconnectPromise = (async () => {
          const { sdk, protocolVersion } = await buildConnected();
          activeSdk = sdk;
          log(`(reconnected, PV${protocolVersion ?? '?'})`);
        })().finally(() => {
          reconnectPromise = null;
        });
      }
      return reconnectPromise;
    },
  };
}

// ---- Small utilities -----------------------------------------------------------

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries transient read faults; reconnects through `handle` on transport collapse. */
export async function readback(handle, fn, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (TRANSPORT_COLLAPSE.test(describeErr(e))) {
        try {
          await handle.reconnect(describeErr(e));
          continue;
        } catch (reconnectError) {
          lastError = reconnectError;
        }
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error(`read failed after ${attempts} attempts: ${describeErr(lastError)}`);
}

/** Ensures the parent directory of `path` exists. */
export function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}
