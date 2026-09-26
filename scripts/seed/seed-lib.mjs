/**
 * Shared plumbing for the devnet content-seeding scripts (scripts/seed/*).
 *
 * Everything here is either pure (corpus parsing, persona validation, document
 * building, checkpoint folding) or read-only against the repo (env files,
 * contract JSONs). Network I/O lives in the two entry points and in
 * asset-lock-lib.mjs, so the `--self-test` harnesses can exercise this module
 * without touching the devnet.
 *
 * Hard-won gotchas honored here (see scripts/verify-lib.mjs and
 * scripts/provision-test-identity.mjs):
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
import {
  BatchTransition,
  BatchedTransition,
  Document,
  DocumentActionFeeAgreement,
  DocumentCreateTransition,
  Identifier,
  PlatformVersion,
  PrivateKey,
  TokenPaymentInfo,
} from '@dashevo/evo-sdk';
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
/** YAPP create costs per doctype (contracts/yappr-social-contract-v9.json tokenCost). */
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

// ---- Document shapes (social v9) ----------------------------------------------
//
// The seeder writes to the devnet social contract, which is v9
// (contracts/yappr-social-contract-v9.json); nothing else exists to seed. The
// corpus format keeps `"hashtag": ""` for "untagged", and on chain that is an
// ABSENT property: an untagged post OMITS `hashtag`, and a like of it OMITS
// `like.hashtag` too — propertyAgreement treats both-absent as agreement,
// while sending `''` is consensus mismatch 40127. The like's delete-by-values
// tuple must reproduce the same absence (it is the same value tuple). A like
// of a TAGGED post also writes a `beat` companion, which carries today's
// trending-hashtag axis. post and reply creates agree to an action fee, and
// their token costs are `optional` with the contract owner offering the gas —
// see `actionFeeFor` / `paymentInfo` below.

/** The topology the seeded contract must have (`.env.devnet`). */
export const SEEDED_TOPOLOGY = 'v9';
/** v9's `post.hashtag` / `like.hashtag` maxLength (the ranked key-size ceiling). */
export const HASHTAG_MAX = 61;

/**
 * Refuses to seed a contract of another shape: every write below is a v9
 * document, and a stale `NEXT_PUBLIC_CONTRACT_TOPOLOGY` would otherwise spend
 * credits on writes consensus rejects.
 */
export function requireSeededTopology() {
  const configured = envValue('NEXT_PUBLIC_CONTRACT_TOPOLOGY');
  if (configured !== SEEDED_TOPOLOGY) {
    throw new Error(`NEXT_PUBLIC_CONTRACT_TOPOLOGY is ${configured ?? 'unset'}; the seeder only writes ${SEEDED_TOPOLOGY} documents`);
  }
}

/**
 * The `hashtag` property (or its absence) for a post/quote/like document.
 * `''` and absent inputs are equivalent ("untagged") so a checkpoint ref
 * recorded either way replays to an identical document.
 */
export function hashtagProps(hashtag) {
  const tag = hashtag ?? '';
  return tag === '' ? {} : { hashtag: tag };
}

/**
 * The `beat` companion a like of a TAGGED post writes beside itself — the
 * tagged-only indexOnly doctype whose byDayHashtagPost serves today's
 * trending hashtags / per-tag top. `null` for an untagged target
 * (beat.hashtag is required). Its postId refersTo the post with
 * propertyAgreement on hashtag, so consensus checks the tag.
 */
export function beatValueTuple(target) {
  const tag = target.hashtag ?? '';
  if (tag === '') return null;
  return { postId: bs58.decode(target.id), hashtag: tag };
}

/**
 * The like doc's data value tuple for a target post ref record. Used for the
 * create AND for delete-by-values (indexOnly deletes carry the whole value
 * tuple) — both must mirror the post's propertyAgreement values exactly,
 * including hashtag ABSENCE. `postAuthor` binds to the post's `$ownerId`.
 */
export function likeValueTuple(target) {
  return {
    postId: bs58.decode(target.id),
    ...hashtagProps(target.hashtag),
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
export function writePrivateFile(path, contents) {
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
export function validateHandle(handle, { allowContested = false } = {}) {
  if (typeof handle !== 'string') return 'handle must be a string';
  if (!/^[a-z0-9-]{3,19}$/.test(handle)) return `handle "${handle}" must be [a-z0-9-], 3-19 chars`;
  if (handle.startsWith('-') || handle.endsWith('-')) return `handle "${handle}" must not start or end with a hyphen`;
  // A label with no digit 2-9 matches DPNS's contested pattern ^[a-zA-Z01-]{3,19}$
  // and its registration enters a masternode vote instead of landing at once.
  // Hero personas (alice / bob / carol) opt in with `contested: true` and the
  // provisioner handles the vote flow; everyone else must carry a digit.
  if (!allowContested && !/[2-9]/.test(handle)) return `handle "${handle}" needs at least one digit 2-9 (avoids DPNS contested names)`;
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
  const handleError = validateHandle(persona.handle, { allowContested: persona.contested === true });
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
 * Hashtags are held to the contract's maxLength ({@link HASHTAG_MAX}) — an
 * over-long tag is a generator bug and is rejected, never rewritten.
 *
 * Returns `{ ops, stats }`; each op carries its 1-based `line`.
 */
export function parseCorpus(text, personas) {
  const hashtagMax = HASHTAG_MAX;
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
          fail(line, `hashtag "${op.hashtag}" must match ^$|^[a-z0-9_]{1,${hashtagMax}}$ ('' = untagged; maxLength ${hashtagMax})`);
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

/**
 * YAPP a corpus costs in total and per persona idx (create tokenCosts).
 *
 * `paysCredits(authorIdx)` excludes the authors a run has paying in credits
 * instead: their writes cost no YAPP at all, so counting them would over-fund
 * the run and hide an actually underfunded author.
 */
export function corpusYappCost(ops, { paysCredits = () => false } = {}) {
  const perAuthor = new Map();
  let total = 0;
  const costOf = { post: TOKEN_COST.post, quote: TOKEN_COST.post, reply: TOKEN_COST.reply, like: TOKEN_COST.like, likeReply: TOKEN_COST.likeReply, repost: TOKEN_COST.repost };
  for (const op of ops) {
    const cost = costOf[op.type] ?? 0;
    if (cost === 0 || paysCredits(op.author)) continue;
    total += cost;
    perAuthor.set(op.author, (perAuthor.get(op.author) ?? 0) + cost);
  }
  return { total, perAuthor };
}

/**
 * Whether persona `idx` pays its token-priced writes in CREDITS rather than
 * YAPP, for a run asking for `fraction` of its actors to do so (the contract's optional
 * token costs — the "free usage" path where the write carries no
 * `$tokenPaymentInfo` and the signer pays credits as for an unpriced action).
 *
 * Deterministic in the persona index alone, so a resumed run keeps every actor
 * on the currency it started with: switching mid-run would leave an author
 * funded for neither path. The multiplier is coprime with 1000, so consecutive
 * indexes land on a full-period permutation rather than in author-block
 * buckets the way a bare `idx % n` would; the self-test pins the resulting
 * share.
 */
export function paysInCredits(idx, fraction) {
  if (!(fraction > 0)) return false;
  if (fraction >= 1) return true;
  return ((Number(idx) * 2654435761) % 1000) / 1000 < fraction;
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
// and the doc builders (`hashtagProps`) map '' to property absence. Never
// treat the journal's hashtag as always-a-meaningful-string.

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

export const randomEntropy = () => crypto.getRandomValues(new Uint8Array(32));

/** DIP-30: the low 40 bits of an identity contract nonce are the sequence; the rest is a revision bitset. */
export const NONCE_SEQUENCE_MASK = (1n << 40n) - 1n;

/**
 * Protocol 14 document id (platform#4859): it commits to the identity contract
 * nonce of the create transition, so it exists only once that nonce is
 * assigned. From 4.2.0-beta.4 wasm-dpp2 derives it (platform#4868); this is a
 * thin wrapper over `Document.generateId` at the latest platform version, the
 * same derivation `lib/document-id.ts` uses in the browser and the one
 * `new DocumentCreateTransition` re-derives. Needs the wasm module initialized.
 */
export function deriveDocumentIdBytes({ contractId, ownerId, docType, entropy, nonce }) {
  return Document.generateId(docType, ownerId, contractId, entropy, BigInt(nonce));
}

/**
 * `Document.fromObject` with raw-byte identifiers — the only construction that
 * survives wasm-sdk 4.1+ (the `Document` constructor corrupts Uint8Array
 * properties). Mirrors scripts/verify-lib.mjs `buildDocument`.
 *
 * The id a create carries depends on its identity contract nonce (protocol 14):
 *  - pass `nonce` when the transition is built by hand with a known nonce
 *    (pipeline.mjs) — the id is derived here and is the one Platform stores;
 *  - pass `id` for a replace or a delete of an existing document;
 *  - pass neither for a create that goes through `sdk.documents.create()`: the
 *    SDK assigns the nonce, derives the id, sets it back on `document` and
 *    returns the confirmed Document. The `$id` built here is then a PLACEHOLDER
 *    and the returned `id` is `null` — read the real one with `createdId()`.
 */
export function buildDocument({ contractId, docType, ownerId, data, entropy, revision = 1n, createdAt, id, nonce }) {
  const idBytes = id
    ?? (nonce !== undefined ? deriveDocumentIdBytes({ contractId, ownerId, docType, entropy, nonce }) : randomEntropy());
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
  return { document, id: (id || nonce !== undefined) ? bs58.encode(idBytes) : null };
}

/**
 * The id of a document `sdk.documents.create()` just stored, from the confirmed
 * Document it RETURNED. Deliberately not read off the caller's document: the SDK
 * only writes the final id back onto it after the wait succeeds, so on a throw
 * (the DAPI 504 quirk) the caller's `$id` is still the placeholder and trusting
 * it would "confirm" a document that does not exist. A create that threw landed
 * (if it landed) under an id nobody client-side knows — read it back by value
 * (`findRecentByValues`) or not at all.
 */
export function createdId(created) {
  return asBase58(created?.id);
}

/** Base58 of an identifier however a query surface hands it back (string, Identifier, bytes). */
export function asBase58(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return bs58.encode(Uint8Array.from(value));
}

/** Value equality between a field as written and as Platform returns it (BigInt integers, byte arrays). */
function sameValue(written, stored) {
  if (stored === undefined || stored === null) return false;
  try {
    if (written instanceof Uint8Array) return asBase58(stored) === bs58.encode(written);
    if (typeof written === 'bigint' || typeof stored === 'bigint') return BigInt(written) === BigInt(stored);
    if (typeof written === 'object' && written !== null) return JSON.stringify(written) === JSON.stringify(stored);
    return written === stored;
  } catch {
    return false; // a value that cannot even be coerced is not the one we wrote
  }
}

/** Tolerance between this machine's clock and the block time Platform stamps into `$createdAt`. */
const CLOCK_SKEW_MS = 120_000;

/**
 * The stored id of a document known only by its values — the readback for a
 * create that threw after broadcasting. From protocol 14 the id of a document
 * is derived from the nonce `documents.create()` picked internally, so a create
 * that landed but reported an error left no id behind; this scans the owner's
 * most recent documents of the type (`$ownerId` is indexed on every stored
 * social doctype, `$createdAt` on most) for one whose every written field
 * matches, and returns its base58 id or `null`.
 *
 * `since` (ms) bounds the scan to documents created at or after that instant
 * (minus a clock-skew allowance): a battery MUST pass the time it started its
 * write, or a byte-identical document from an earlier run would score a
 * refused write as accepted. Seeders deliberately omit it on the pre-write
 * probe so a resumed run with a lost checkpoint adopts its own earlier
 * document, which also means two logical keys with identical payloads would
 * resolve to one document, and a retried post may adopt an OLDER identical
 * post by the same author and hand that id to the ops that reference it.
 *
 * The residual risks, accepted and stated rather than hidden: a stored doctype
 * without a distinctive value set (two identical posts by one author) cannot
 * be told apart, so a retry after such a throw may write the document twice;
 * a payload with non-deterministic bytes (a DM's fresh AES-GCM IV) is only
 * recognisable within the call that built it, so after a lost checkpoint it
 * is written again; and an owner with more than `limit` documents of the type
 * newer than the one sought is not recognised at all.
 */
export async function findRecentByValues(sdk, { contractId, docType, ownerId, data, since, limit = 100 }) {
  const fields = Object.entries(data ?? {});
  if (fields.length === 0) return null; // nothing to match on — every candidate would "match"
  const base = { dataContractId: contractId, documentTypeName: docType, where: [['$ownerId', '==', ownerId]], limit };
  let result;
  try {
    result = await sdk.documents.query({ ...base, orderBy: [['$createdAt', 'desc']] });
  } catch (e) {
    // Only an index-shape refusal falls back to an unordered page (a doctype
    // whose owner index carries no $createdAt); transport faults propagate so
    // the caller's `readback` retries them instead of scanning a random page.
    const text = describeErr(e);
    if (TRANSPORT_COLLAPSE.test(text) || RETRYABLE.test(text)) throw e;
    try {
      result = await sdk.documents.query(base);
    } catch (inner) {
      const innerText = describeErr(inner);
      if (TRANSPORT_COLLAPSE.test(innerText) || RETRYABLE.test(innerText)) throw inner;
      // Some doctypes cannot be reached by `$ownerId` at all — storefront's
      // `shippingZone` indexes only (storeId, name) and (storeId, priority), so
      // the query is refused "where clause on non indexed property". That is a
      // permanent fact about the schema, not a fault to retry: answer "no
      // match found" and let the caller decide the write did not land, rather
      // than aborting every rejection probe on such a type.
      if (NOT_QUERYABLE_BY_OWNER.test(innerText)) return null;
      throw inner;
    }
  }
  const floor = since === undefined ? null : BigInt(Math.floor(since - CLOCK_SKEW_MS));
  const docs = result instanceof Map ? [...result.values()] : Object.values(result ?? {});
  for (const doc of docs) {
    if (!doc) continue;
    const stored = doc.toObject ? doc.toObject() : doc;
    if (!stored) continue;
    if (floor !== null && stored.$createdAt !== undefined && BigInt(stored.$createdAt) < floor) continue;
    if (fields.every(([name, value]) => sameValue(value, stored[name]))) return asBase58(stored.$id ?? doc.id);
  }
  return null;
}

/**
 * Token payment for a token-priced doctype (post/reply/like/likeReply/repost).
 *
 * `gasFeesPaidBy: 2` (PreferContractOwner) is the offer the social types make: the
 * contract owner pays the gas of a token-paid create when it can, else the
 * signer does. Never ask for `1` (ContractOwner, insisting) — the type does not
 * offer it and insisting is 40129. Omitting the bag ENTIRELY is the credits
 * path on the `optional: true` costs; there is no fallback the other way
 * (payment info with too little YAPP is a 40700 refusal), so callers choose
 * before signing.
 */
export function paymentInfo(tokenCost, { gasFeesPaidBy = 0 } = {}) {
  return tokenCost
    ? {
        tokenPaymentInfo: new TokenPaymentInfo({
          tokenContractPosition: YAPP_TOKEN_POSITION,
          maximumTokenCost: BigInt(tokenCost),
          ...(gasFeesPaidBy ? { gasFeesPaidBy } : {}),
        }),
      }
    : {};
}

/** The gas offer the social contract's token-paid creates may ask for. */
export const PREFER_CONTRACT_OWNER = 2;
/** How far above the multiplier the signer knew the executing epoch's may be (percent). */
export const FEE_MULTIPLIER_TOLERANCE_PERCENT = 20;
/** Agreed when the epoch read fails: 40132 is certain without an agreement, 40134 unlikely at 1.0x. */
export const DEFAULT_FEE_MULTIPLIER_PERMILLE = 1000n;

const SOCIAL_DOCUMENT_SCHEMAS = JSON.parse(
  readFileSync(join(REPO_ROOT, 'contracts/yappr-social-contract-v9.json'), 'utf8')
).documentSchemas;

/**
 * What `docType`'s create costs in YAPP, and how that payment may be made:
 * `{ amount, optional, gasFeesPaidBy }`, read off the committed contract. The
 * gas offer is a property of the doctype, independent of whether it charges
 * an action fee — inferring one from the other would send a payer the type
 * never offered (40129).
 */
export function tokenCostFor(docType) {
  const create = SOCIAL_DOCUMENT_SCHEMAS[docType]?.tokenCost?.create;
  if (!create) return null;
  return { amount: create.amount, optional: create.optional === true, gasFeesPaidBy: create.gasFeesPaidBy ?? 0 };
}

/**
 * The action fee `docType`'s create charges, or null when it charges none
 * (everything but `post` and `reply`). Read off the committed contract JSON so
 * no amount is ever transcribed: a mismatch is a paid 40133.
 */
export function actionFeeFor(docType) {
  const fees = SOCIAL_DOCUMENT_SCHEMAS[docType]?.actionFees;
  const create = fees?.create;
  if (!create) return null;
  return {
    owner: BigInt(create.owner ?? 0),
    moderators: BigInt(create.moderators ?? 0),
    pricing: fees.pricing === 'fixed' ? 'fixed' : 'feeMultiplier',
  };
}

/**
 * The `$actionFeeAgreement` options for a declared fee: the exact amounts, each
 * pot on its own, plus the multiplier the signer knew for `feeMultiplier`
 * pricing (naming one for a `fixed` fee is the same 40133 mismatch). Pure, so
 * `--self-test` pins it without a network.
 */
export function actionFeeAgreementOptions(fee, knownPermille) {
  return {
    owner: fee.owner,
    moderators: fee.moderators,
    ...(fee.pricing === 'feeMultiplier'
      ? { feeMultiplier: { knownPermille: BigInt(knownPermille), increaseTolerancePercent: FEE_MULTIPLIER_TOLERANCE_PERCENT } }
      : {}),
  };
}

/** The current epoch's fee multiplier, read once per process (callers refresh on a 40134). */
let cachedFeeMultiplierPermille = null;
export async function feeMultiplierPermille(sdk) {
  if (cachedFeeMultiplierPermille !== null) return cachedFeeMultiplierPermille;
  try {
    cachedFeeMultiplierPermille = BigInt((await sdk.epoch.current()).feeMultiplierPermille);
  } catch (error) {
    console.log(`     (epoch read failed, agreeing at ${DEFAULT_FEE_MULTIPLIER_PERMILLE} permille: ${describeErr(error).slice(0, 120)})`);
    return DEFAULT_FEE_MULTIPLIER_PERMILLE;
  }
  return cachedFeeMultiplierPermille;
}

/**
 * A rejection saying the epoch's fee multiplier outran what the agreement
 * tolerated (40134). The amounts were right; only the multiplier this process
 * cached went stale — which happens when a long run crosses an epoch boundary.
 */
export const FEE_MULTIPLIER_NOT_TOLERATED = /\bcode"?\s*[=:]\s*40134\b|documentactionfeemultipliernottolerated|fee multiplier is/i;

/**
 * Forgets the cached multiplier so the next agreement re-reads the epoch.
 * Called from the retry loops on a 40134: without it every later create in the
 * run re-agrees at the same stale value and is refused for the same reason.
 */
export function forgetFeeMultiplier() {
  cachedFeeMultiplierPermille = null;
}

/**
 * The agreement a create of `docType` must carry, or undefined when the action
 * is unpriced. Reads the epoch multiplier on first use.
 */
export async function feeAgreementFor(sdk, docType) {
  const fee = actionFeeFor(docType);
  if (!fee) return undefined;
  return new DocumentActionFeeAgreement(actionFeeAgreementOptions(fee, await feeMultiplierPermille(sdk)));
}

/**
 * A create built and signed BY HAND, the only shape that can carry an
 * `$actionFeeAgreement`: `sdk.documents.create` (`DocumentCreateOptions`)
 * offers `document`, `identityKey`, `signer`, `tokenPaymentInfo` and
 * `settings` — and nothing for the agreement — so every post/reply create on a
 * social contract goes through here or it is a paid 40132.
 *
 * Protocol 14 derives the id from the transition's identity contract nonce, so
 * the nonce is taken first and the id derived up front by wasm-dpp2
 * (`deriveDocumentIdBytes`); the id is therefore known BEFORE the broadcast,
 * unlike the facade path. Returns `{ id }` — the same shape `createdId` reads
 * off a facade-created Document — so callers' acceptance logic is unchanged.
 */
export async function createWithAgreement(sdk, { contractId, docType, ownerId, wif, identityKey, data, entropy, agreement, payment = {} }) {
  const rawNonce = (await sdk.wasm.getIdentityContractNonce(ownerId, contractId)) ?? 0n;
  const nonce = (BigInt(rawNonce) & NONCE_SEQUENCE_MASK) + 1n;
  const { document, id } = buildDocument({ contractId, docType, ownerId, data, entropy, nonce });
  const transition = new DocumentCreateTransition({
    document,
    identityContractNonce: nonce,
    ...payment,
    ...(agreement ? { actionFeeAgreement: agreement } : {}),
  });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(transition.toDocumentTransition())], ownerId, 0);
  const stateTransition = batch.toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);
  stateTransition.sign(PrivateKey.fromWIF(wif), identityKey);
  await sdk.stateTransitions.broadcastAndWait(stateTransition);
  // The nonce was managed by hand, so the facade's cached one is now behind:
  // refresh it or the next `documents.create` by this actor reuses a spent
  // nonce. The binding takes an `Identifier` (it `_assertClass`es, and consumes
  // it), NOT a base58 string — and it throws SYNCHRONOUSLY, so this needs a
  // try/catch rather than a rejection handler. Best effort: the write already
  // landed, and a stale cache costs a retry, not the document.
  try {
    await sdk.wasm.refreshIdentityNonce(new Identifier(ownerId));
  } catch (error) {
    console.log(`     (nonce cache refresh failed after ${docType} create: ${describeErr(error).slice(0, 120)})`);
  }
  return { id };
}

/**
 * One create, sent whichever way its doctype demands: the facade when there is
 * nothing to agree to, and the hand-built batch above when an
 * `$actionFeeAgreement` has to ride along. Both resolve to something
 * `createdId` can read an id off, so a caller's acceptance logic does not care
 * which path ran. `actor` is a seeder actor: `{ ownerId, identityKey, signer,
 * wif }`.
 */
export function createDocument(sdk, { contractId, actor, docType, document, data, entropy, agreement, payment = {} }) {
  if (!agreement) {
    return sdk.documents.create({ document, identityKey: actor.identityKey, signer: actor.signer, ...payment });
  }
  return createWithAgreement(sdk, {
    contractId, docType, ownerId: actor.ownerId, wif: actor.wif, identityKey: actor.identityKey,
    data, entropy, agreement, payment,
  });
}

// ---- Resilient SDK handle ------------------------------------------------------
//
// Quorum rotations invalidate the trusted context's
// prefetched keys mid-run and there is no refresh API — the cure is a FULL
// reconnect (fresh EvoSDK + protocol-version ratchet + contract re-cache). The
// returned `sdk` is a proxy that always forwards to the live instance, so a
// swap is transparent to in-flight helpers.

/** Errors that mean "this SDK instance is dead", not "this request was refused". */
export const TRANSPORT_COLLAPSE = /no available addresses|invalid quorum|quorum not found/i;
/** Confirmation-wait shapes that do NOT mean the write was refused (readback decides). */
export const WAIT_MAYBE_LANDED = /504|gateway|deadline|timed? ?out|timeout|wait.*state.*transition|AffectedState/i;
/** Retry-worthy transient transport noise. */
/**
 * A query refused because the doctype has no index for the where clause. Unlike
 * a transport fault this never succeeds on retry, so `findRecentByValues`
 * answers null instead of propagating it.
 */
export const NOT_QUERYABLE_BY_OWNER = /non indexed property|must be for valid indexes|invalid indexes/i;

export const RETRYABLE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network error|503|502|429|unavailable|rate limited|resource has been exhausted/i;
/** Identity (contract) nonce desync — cured by a reconnect (fresh nonce cache). */
export const NONCE_DESYNC = /nonce/i;
/** Structural duplicate (unique index) — the end state already holds. */
// The code is anchored: several callers treat a duplicate as SUCCESS
// (`duplicateIsSuccess`), so an unbounded `40105` matching a credit amount or a
// document id would silently skip a write that never landed.
export const DUPLICATE_UNIQUE = /\b40105\b|duplicate unique properties/i;

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
