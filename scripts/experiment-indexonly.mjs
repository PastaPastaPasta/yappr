/**
 * Phase 1 experiment battery for the like overhaul (PLAN_LIKE_OVERHAUL.md §2/§4):
 * `indexOnly` document types on a THROWAWAY devnet contract, protocol v14,
 * @dashevo/evo-sdk 4.2.0-dev.5.
 *
 * What it decides:
 *
 *   D1  `''` sentinel — an untagged post carries `hashtag: ''` and its likes
 *       must carry `''` too, enforced by `propertyAgreement` (40127 on
 *       mismatch). If `''` round-trips through agreement, indexes and ranked
 *       pins, the sentinel design is viable.
 *   D2a $createdAt recovery — `likeT` (like + a `[postAuthor, $createdAt]`
 *       notification index, which forces `$createdAt` into `required` and
 *       therefore into the delete tuple) is created, then deleted WITHOUT the
 *       create-returned Document: every value of the tuple is recovered from
 *       queries alone (byLiker → postId, byAuthorTime → $createdAt, the post
 *       itself → hashtag/postAuthor). If the delete lands, a multi-device
 *       unlike can always resynthesize its tuple and option (a) is safe.
 *   §4  fees — every write is measured as the maker's credit-balance delta,
 *       including the preallocation shift: `post` is the refersTo target of
 *       `like`, whose three ranked indexes are `preallocated: true`, so a post
 *       create pays for its like trees and every like costs the same as the
 *       first. `postC` is an identical doctype nothing refers to (the
 *       control), and `likeT`'s indexes are NOT preallocated (the first-entry-
 *       pays-for-trees fallback, measured separately).
 *
 * The battery style follows verify-topology.mjs: every acceptance is decided
 * by reading back from the chain (never by the SDK's throw/no-throw), and a
 * rejection that does not match the case's expected consensus reason FAILS
 * the case rather than passing it.
 *
 * indexOnly documents cannot be fetched by `$id` (no primary tree), so
 * acceptance reads go through the entry indexes: `postId == X AND
 * $ownerId == me` lowers onto byPost's member keys.
 *
 * ## Environment
 *
 *   DEVNET_NAME       devnet name          (default: moutai)
 *   DAPI_ADDRESSES    comma-separated DAPI (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *   QUORUM_URL        quorum service for the trusted context (default host derived from the devnet name)
 *   E2E_SEED_PHRASE   BIP39 seed the maker keys derive from (env or .env.local)
 *
 * The signer is the devnet contract maker (seed index 9). Bot identities are
 * deliberately NOT used — CI may be signing with them concurrently.
 *
 * ## Run
 *
 *   node scripts/experiment-indexonly.mjs --dry-run
 *   node scripts/experiment-indexonly.mjs [--owner <makerId>] [--maker-index 9]
 *   node scripts/experiment-indexonly.mjs --contract <id>   # reuse a registered contract
 */
import {
  DataContract,
  Document,
  EvoSDK,
  IdentitySigner,
  PlatformVersion,
  ensureInitialized,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';

const SDK_TIMEOUT_MS = 30000;
const DEFAULT_DEVNET_NAME = 'moutai';
const DEFAULT_SEED_COUNT = 5;
/** Reads settle behind the write quorum; give the chain a beat before asserting. */
const SETTLE_MS = 3000;
/** How many settle intervals before a write is called absent (~9s). */
const POLL_ATTEMPTS = 3;
/** The devnet maker (seed index 9) — ~1T credits, owner of every moutai contract. */
const DEFAULT_MAKER_ID = 'DuqE3zgXprS5zU51YaB4GuGxTRzzukW59XAYKeM6gKGA';
const DEFAULT_MAKER_INDEX = 9;
/** Placeholder for --dry-run document assembly. */
const DRY_RUN_ID = '11111111111111111111111111111111';
/** The stored-document like baseline measured on the v2/v3 contracts (~$0.026). */
const STORED_LIKE_BASELINE = 67_100_000n;

// ---- Devnet SDK (inline on purpose: this script owns its network config) ----

function defaultDevnetAddresses(devnetName) {
  return Array.from(
    { length: DEFAULT_SEED_COUNT },
    (_, i) => `https://seed-${i + 1}.${devnetName}.networks.dash.org:1443`
  );
}

function devnetSdk() {
  const devnetName = process.env.DEVNET_NAME?.trim() || DEFAULT_DEVNET_NAME;
  const configured = (process.env.DAPI_ADDRESSES ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => (address.includes('://') ? address : `https://${address}`));
  const addresses = configured.length > 0 ? configured : defaultDevnetAddresses(devnetName);
  const sdk = new EvoSDK({
    network: 'devnet',
    devnetName,
    addresses,
    // trusted mode is mandatory: wasm-sdk panics on `proofs: false` and
    // refuses non-trusted proof verification. Quorum keys are prefetched from
    // https://quorums.<devnetName>.networks.dash.org (or QUORUM_URL).
    trusted: true,
    ...(process.env.QUORUM_URL ? { quorumUrl: process.env.QUORUM_URL } : {}),
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- Reporting --------------------------------------------------------------

let failures = 0;
const capturedErrors = [];
/** `{label, credits}` rows for the fee table, in execution order. */
const fees = [];

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function capture(label, message) {
  if (message) capturedErrors.push({ label, message });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const randomIdBytes = () => crypto.getRandomValues(new Uint8Array(32));

const fmtCredits = (credits) =>
  `${credits.toLocaleString('en-US')} credits (~$${(Number(credits) / 2_564_102_564).toFixed(4)})`;

// ---- Throwaway contract -----------------------------------------------------
//
// Four doctypes:
//   post   stored, permanent (canBeDeleted:false, documentsMutable:true) —
//          the refersTo target; its creation preallocates like's ranked trees.
//   postC  byte-identical control that nothing refers to.
//   like   indexOnly, PLAN §2 shape; three ranked indexes preallocated.
//   likeT  the D2 vehicle: same properties + [postAuthor, $createdAt] index,
//          which forces `$createdAt` into required (and the delete tuple).
//          Deliberately NOT preallocated and NOT countable, so (a) the
//          post-vs-postC delta isolates like's three preallocated indexes and
//          (b) the first likeT measures the first-entry-pays-for-trees
//          fallback price.

function identifierProperty(position, refersTo) {
  return {
    type: 'array',
    byteArray: true,
    minItems: 32,
    maxItems: 32,
    contentMediaType: 'application/x.dash.dpp.identifier',
    ...(refersTo ? { refersTo } : {}),
    position,
  };
}

/** minLength 0 — the D1 `''` sentinel must be schema-legal. */
function hashtagProperty(position) {
  return { type: 'string', minLength: 0, maxLength: 63, position };
}

function storedPostSchema() {
  return {
    type: 'object',
    documentsMutable: true,
    canBeDeleted: false,
    properties: {
      content: { type: 'string', maxLength: 500, position: 0 },
      author: identifierProperty(1),
      hashtag: hashtagProperty(2),
    },
    required: ['content', 'author', 'hashtag'],
    additionalProperties: false,
  };
}

function likePropertySet() {
  return {
    postId: identifierProperty(0, {
      type: 'permanentDocument',
      documentType: 'post',
      // { referring property: referenced property } — consensus-checked
      // equality at like-create time (40127 on disagreement).
      propertyAgreement: { hashtag: 'hashtag', postAuthor: 'author' },
    }),
    hashtag: hashtagProperty(1),
    postAuthor: identifierProperty(2),
  };
}

/**
 * The full count/rank axis stack. The meta-schema chains the keywords:
 * `rankedCountable: true` requires `rangeCountable`, which itself requires
 * `countable` — so even indexes the plan spec'd as "rankedCountable only"
 * (byHashtagPost) must carry all three.
 */
function rankedIndex(name, properties, { preallocated = false } = {}) {
  return {
    name,
    properties,
    terminal: '$ownerId',
    countable: true,
    rangeCountable: true,
    rankedCountable: true,
    ...(preallocated ? { preallocated: true } : {}),
  };
}

function likeSchema() {
  return {
    type: 'object',
    indexOnly: true,
    documentsMutable: false,
    canBeDeleted: true,
    indices: [
      rankedIndex('byPost', [{ postId: 'asc' }], { preallocated: true }),
      rankedIndex('byHashtagPost', [{ hashtag: 'asc' }, { postId: 'asc' }], { preallocated: true }),
      // The plan's `byAuthor [postAuthor] terminal $ownerId` is structurally
      // broken (see likeB below): its projection makes ONE like per
      // (author, liker) pair the uniqueness rule. The candidate fix appends
      // the referring property, which also makes the index preallocatable
      // (the validator demands the referring property among the index's own
      // properties — an agreement key alone does not bind a reference).
      rankedIndex('byAuthorPost', [{ postAuthor: 'asc' }, { postId: 'asc' }], { preallocated: true }),
      { name: 'byLiker', properties: [{ $ownerId: 'asc' }], terminal: 'postId' },
    ],
    properties: likePropertySet(),
    required: ['postId', 'hashtag', 'postAuthor'],
    additionalProperties: false,
  };
}

function likeTSchema() {
  return {
    type: 'object',
    indexOnly: true,
    documentsMutable: false,
    canBeDeleted: true,
    indices: [
      { name: 'byPost', properties: [{ postId: 'asc' }], terminal: '$ownerId' },
      { name: 'byHashtagPost', properties: [{ hashtag: 'asc' }, { postId: 'asc' }], terminal: '$ownerId' },
      // The D2 notification index — indexing $createdAt forces it required.
      // CAVEAT the projection exposes: two same-block likes of the same
      // author's posts share (postAuthor, $createdAt, $ownerId) and would
      // collide; byAuthorTimePost is the collision-free spelling (and its
      // projection hands the notification the postId for free).
      { name: 'byAuthorTime', properties: [{ postAuthor: 'asc' }, { $createdAt: 'asc' }], terminal: '$ownerId' },
      {
        name: 'byAuthorTimePost',
        properties: [{ postAuthor: 'asc' }, { $createdAt: 'asc' }, { postId: 'asc' }],
        terminal: '$ownerId',
      },
      { name: 'byLiker', properties: [{ $ownerId: 'asc' }], terminal: 'postId' },
    ],
    properties: likePropertySet(),
    required: ['postId', 'hashtag', 'postAuthor', '$createdAt'],
    additionalProperties: false,
  };
}

/**
 * The plan's ORIGINAL byAuthor shape, kept on its own doctype purely to
 * demonstrate the structural-uniqueness trap on demand: `[postAuthor]
 * terminal $ownerId` projects to (postAuthor, $ownerId), and because ANY
 * existing entry in ANY index rejects a create (40105), one identity can
 * ever like ONE post per author.
 */
function likeBSchema() {
  return {
    type: 'object',
    indexOnly: true,
    documentsMutable: false,
    canBeDeleted: true,
    indices: [
      { name: 'byPost', properties: [{ postId: 'asc' }], terminal: '$ownerId' },
      { name: 'byHashtagPost', properties: [{ hashtag: 'asc' }, { postId: 'asc' }], terminal: '$ownerId' },
      { name: 'byAuthor', properties: [{ postAuthor: 'asc' }], terminal: '$ownerId' },
      { name: 'byLiker', properties: [{ $ownerId: 'asc' }], terminal: 'postId' },
    ],
    properties: likePropertySet(),
    required: ['postId', 'hashtag', 'postAuthor'],
    additionalProperties: false,
  };
}

function experimentContractJson(ownerId, identityNonce) {
  return {
    $formatVersion: '1',
    id: DataContract.generateId(ownerId, identityNonce).toBase58(),
    ownerId,
    version: 1,
    documentSchemas: {
      post: storedPostSchema(),
      postC: storedPostSchema(),
      like: likeSchema(),
      likeT: likeTSchema(),
      likeB: likeBSchema(),
    },
  };
}

// ---- Document plumbing ------------------------------------------------------

/**
 * `Document.fromObject` with raw-byte ids is the only shape that survives
 * wasm-sdk 4.1+ (the `Document` constructor corrupts Uint8Array properties).
 */
function buildDocument({ contractId, docType, ownerId, data, entropy, createdAt, id }) {
  const idBytes = id ?? Document.generateId(docType, ownerId, contractId, entropy);
  const document = Document.fromObject(
    {
      $formatVersion: '0',
      $id: idBytes,
      $ownerId: bs58.decode(ownerId),
      $dataContractId: bs58.decode(contractId),
      $type: docType,
      $revision: 1n,
      ...(entropy ? { $entropy: entropy } : {}),
      ...(createdAt !== undefined ? { $createdAt: createdAt } : {}),
      ...data,
    },
    PlatformVersion.current()
  );
  return { document, id: bs58.encode(idBytes) };
}

const READ_ATTEMPTS = 4;

/** Retries transient read faults; only a successful read is an answer. */
async function readback(fn) {
  let lastError;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error(
    `read failed after ${READ_ATTEMPTS} attempts — cannot distinguish absence from unavailability: ${describeErr(lastError)}`
  );
}

async function fetchDocument(sdk, contractId, docType, id) {
  return readback(async () => (await sdk.documents.get(contractId, docType, id)) ?? null);
}

/**
 * "Does the maker's entry for this post exist?" — the indexOnly acceptance
 * read. Equality on every byPost prefix property plus the terminal lowers
 * onto the entry level's member keys.
 */
async function likeEntryExists(sdk, contractId, docType, postId, ownerId) {
  return readback(async () => {
    const result = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [
        ['postId', '==', postId],
        ['$ownerId', '==', ownerId],
      ],
    });
    return result.size > 0;
  });
}

const NOT_THROWN_BUT_ABSENT = 'the SDK reported no error, but the write is not on chain';

/** Reads the maker's credit balance (never undefined once the identity exists). */
async function creditBalance(sdk, ownerId) {
  return readback(async () => (await sdk.identities.balance(ownerId)) ?? 0n);
}

/**
 * Runs one write; the CHAIN decides the outcome (the DAPI gateway routinely
 * 504s waits for transitions that landed). The maker's credit-balance delta
 * is recorded as the fee: positive = cost, negative = net refund. Rejected
 * transitions may also carry a (small) processing charge — recorded too.
 */
async function measuredWrite(ctx, { label, feeLabel, accepted }, write) {
  const before = await creditBalance(ctx.sdk, ctx.maker.ownerId);
  let error = null;
  let value = null;
  try {
    value = await write();
  } catch (e) {
    error = describeErr(e);
  }
  let ok = false;
  for (let poll = 0; poll < POLL_ATTEMPTS && !ok; poll++) {
    if (await accepted()) ok = true;
    else await settle();
  }
  // The fee: poll until the balance moves (accepted writes always charge;
  // in-block rejections are PaidConsensusError and charge too, but a write
  // refused before any block leaves the balance alone — hence the bound).
  let after = await creditBalance(ctx.sdk, ctx.maker.ownerId);
  for (let poll = 0; feeLabel && poll < POLL_ATTEMPTS && after === before; poll++) {
    await settle();
    after = await creditBalance(ctx.sdk, ctx.maker.ownerId);
  }
  const fee = before - after;
  if (feeLabel) {
    fees.push({ label: feeLabel, credits: fee });
    console.log(`     fee[${feeLabel}] = ${fee.toLocaleString('en-US')} credits`);
  }
  if (ok) return { ok, error: null, fee, value };
  return { ok, error: error ?? NOT_THROWN_BUT_ABSENT, fee, value: null };
}

async function createPost(ctx, docType, { content, author, hashtag, feeLabel }) {
  const { document, id } = buildDocument({
    contractId: ctx.contractId,
    docType,
    ownerId: ctx.maker.ownerId,
    data: { content, author, hashtag },
    entropy: randomIdBytes(),
  });
  const outcome = await measuredWrite(
    ctx,
    { feeLabel, accepted: () => fetchDocument(ctx.sdk, ctx.contractId, docType, id).then((d) => d !== null) },
    () =>
      ctx.sdk.documents.create({ document, identityKey: ctx.maker.identityKey, signer: ctx.maker.signer })
  );
  return { ...outcome, id };
}

async function createLike(ctx, docType, { postId, hashtag, postAuthor, feeLabel }) {
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType,
    ownerId: ctx.maker.ownerId,
    data: { postId: bs58.decode(postId), hashtag, postAuthor },
    entropy: randomIdBytes(),
  });
  return measuredWrite(
    ctx,
    { feeLabel, accepted: () => likeEntryExists(ctx.sdk, ctx.contractId, docType, postId, ctx.maker.ownerId) },
    () =>
      ctx.sdk.documents.create({ document, identityKey: ctx.maker.identityKey, signer: ctx.maker.signer })
  );
}

/** indexOnly delete-by-values: the Document instance carries the whole tuple. */
async function deleteLike(ctx, docType, { document, postId, feeLabel }) {
  return measuredWrite(
    ctx,
    {
      feeLabel,
      accepted: () =>
        likeEntryExists(ctx.sdk, ctx.contractId, docType, postId, ctx.maker.ownerId).then((exists) => !exists),
    },
    () =>
      ctx.sdk.documents.delete({ document, identityKey: ctx.maker.identityKey, signer: ctx.maker.signer })
  );
}

function expectAccepted(label, outcome) {
  check(label, outcome.ok, outcome.ok ? '' : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
  return outcome;
}

/** propertyAgreement violation (ReferencedDocumentPropertyMismatchError, 40127). */
const PROPERTY_MISMATCH = /40127|propert(y|ies).{0,60}(mismatch|not match|disagree|must equal)/i;
/** refersTo target missing (ReferencedEntityNotFound, 40120). */
const REFERENCE_NOT_FOUND = /40120|referenced .*not found/i;
/** Structural uniqueness (DuplicateUniqueIndexError family, 40105). */
const DUPLICATE_UNIQUE = /40105|duplicate unique properties/i;

/**
 * Asserts Platform refused the write FOR THE EXPECTED REASON. A rejection
 * matching no expected pattern FAILS: a broken key or transport fault must
 * never score as enforcement.
 */
function expectRejected(label, outcome, pattern) {
  const reason = outcome.error ?? '';
  if (outcome.ok) {
    check(label, false, 'ACCEPTED (BAD)');
    return outcome;
  }
  capture(label, reason);
  const matched = pattern.test(reason);
  check(
    label,
    matched,
    matched ? reason.slice(0, 200) : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 180)}`
  );
  return outcome;
}

// ---- Maker signer -----------------------------------------------------------

async function makerSigner(sdk, ownerId, seedIndex) {
  const { wif } = criticalAuthKey(deriveIdentityKeys(seedIndex));
  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error(`Maker identity ${ownerId} not found on this devnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  if (!identityKey) throw new Error(`Identity ${ownerId} has no key ${CRITICAL_AUTH_KEY_ID}`);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wif);
  return { ownerId, identityKey, signer, label: `maker(${ownerId})` };
}

// ---- Experiments ------------------------------------------------------------

/** Fixed-length content so post fees compare across doctypes and hashtags. */
const POST_CONTENT = 'indexOnly experiment.';

async function experimentRegistration(ctx) {
  console.log('\n--- 0. throwaway contract registration ---');
  const identityNonce = ((await ctx.sdk.identities.nonce(ctx.maker.ownerId)) ?? 0n) + 1n;
  const json = experimentContractJson(ctx.maker.ownerId, identityNonce);
  const dataContract = DataContract.fromJSON(json, true, PlatformVersion.current());

  const before = await creditBalance(ctx.sdk, ctx.maker.ownerId);
  const published = await ctx.sdk.contracts.publish({
    dataContract,
    identityKey: ctx.maker.identityKey,
    signer: ctx.maker.signer,
  });
  ctx.contractId = published.id.toBase58();
  const after = await creditBalance(ctx.sdk, ctx.maker.ownerId);
  fees.push({ label: 'contract registration (post, postC, like, likeT, likeB)', credits: before - after });
  check('0a contract with indexOnly like/likeT registered', true, ctx.contractId);

  // Round-trip the refersTo metadata off the chain: protocol <14 deserializers
  // silently drop it, so its presence here proves the devnet speaks v14.
  const fetched = await ctx.sdk.contracts.fetch(ctx.contractId);
  const likeJson = fetched.toJSON(PlatformVersion.current()).documentSchemas.like;
  const agreement = likeJson?.properties?.postId?.refersTo?.propertyAgreement;
  check(
    '0b refersTo + propertyAgreement round-trip on the fetched contract',
    agreement?.hashtag === 'hashtag' && agreement?.postAuthor === 'author',
    JSON.stringify(likeJson?.properties?.postId?.refersTo ?? null)
  );
  check('0c like doctype round-trips indexOnly:true', likeJson?.indexOnly === true);
}

async function experimentD1Sentinel(ctx) {
  console.log("\n--- 1. D1: the '' sentinel through propertyAgreement ---");

  const postU = await createPost(ctx, 'post', {
    content: POST_CONTENT,
    author: bs58.decode(ctx.maker.ownerId),
    hashtag: '',
    feeLabel: "post create, hashtag '' (preallocates like trees)",
  });
  expectAccepted("1a post with hashtag '' (untagged sentinel) is accepted", postU);
  if (!postU.ok) return;
  ctx.postU = postU.id;

  const postT = await createPost(ctx, 'post', {
    content: POST_CONTENT,
    author: bs58.decode(ctx.maker.ownerId),
    hashtag: 'dash',
    feeLabel: "post create, hashtag 'dash' (preallocates like trees)",
  });
  expectAccepted("1b post with hashtag 'dash' is accepted", postT);
  if (!postT.ok) return;
  ctx.postT = postT.id;

  expectRejected(
    "1c like with hashtag 'dash' on the '' post is rejected (40127)",
    await createLike(ctx, 'like', {
      postId: ctx.postU,
      hashtag: 'dash',
      postAuthor: bs58.decode(ctx.maker.ownerId),
      feeLabel: 'like rejected by propertyAgreement (charged?)',
    }),
    PROPERTY_MISMATCH
  );

  const likeU = await createLike(ctx, 'like', {
    postId: ctx.postU,
    hashtag: '',
    postAuthor: bs58.decode(ctx.maker.ownerId),
    feeLabel: "like create, hashtag '' (preallocated trees)",
  });
  expectAccepted("1d like with hashtag '' on the '' post is accepted", likeU);

  expectRejected(
    "1e like with hashtag '' on the 'dash' post is rejected (40127)",
    await createLike(ctx, 'like', {
      postId: ctx.postT,
      hashtag: '',
      postAuthor: bs58.decode(ctx.maker.ownerId),
    }),
    PROPERTY_MISMATCH
  );

  expectRejected(
    '1f like with the wrong postAuthor is rejected (40127, second agreement key)',
    await createLike(ctx, 'like', {
      postId: ctx.postT,
      hashtag: 'dash',
      postAuthor: randomIdBytes(),
    }),
    PROPERTY_MISMATCH
  );

  const likeT = await createLike(ctx, 'like', {
    postId: ctx.postT,
    hashtag: 'dash',
    postAuthor: bs58.decode(ctx.maker.ownerId),
    feeLabel: "like create, hashtag 'dash' (preallocated trees)",
  });
  expectAccepted("1g like with matching hashtag 'dash' is accepted", likeT);

  // Entry existence cannot judge a DUPLICATE create (the first like's entry
  // already satisfies it), so acceptance here is "the byPost count reached 2"
  // — which a refused duplicate can never produce.
  const duplicate = await measuredWrite(
    ctx,
    {
      feeLabel: 'duplicate like rejected (charged?)',
      accepted: async () => (await countLikes(ctx, 'like', ctx.postT)) >= 2,
    },
    () => {
      const { document } = buildDocument({
        contractId: ctx.contractId,
        docType: 'like',
        ownerId: ctx.maker.ownerId,
        data: { postId: bs58.decode(ctx.postT), hashtag: 'dash', postAuthor: bs58.decode(ctx.maker.ownerId) },
        entropy: randomIdBytes(),
      });
      return ctx.sdk.documents.create({ document, identityKey: ctx.maker.identityKey, signer: ctx.maker.signer });
    }
  );
  expectRejected('1h liking the same post twice is rejected (structural uniqueness, 40105)', duplicate, DUPLICATE_UNIQUE);

  expectRejected(
    '1i like of a nonexistent post is rejected (40120)',
    await createLike(ctx, 'like', {
      postId: bs58.encode(randomIdBytes()),
      hashtag: '',
      postAuthor: bs58.decode(ctx.maker.ownerId),
    }),
    REFERENCE_NOT_FOUND
  );
}

async function experimentPreallocationControl(ctx) {
  console.log('\n--- 2. preallocation control: postC (no referring doctype) ---');
  const postC = await createPost(ctx, 'postC', {
    content: POST_CONTENT,
    author: bs58.decode(ctx.maker.ownerId),
    hashtag: 'dash',
    feeLabel: 'postC create, CONTROL (no preallocated trees)',
  });
  expectAccepted('2a control post (postC) is accepted', postC);
}

/** Identifier values arrive as bytes or base58 depending on the surface. */
function asBase58(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return bs58.encode(Uint8Array.from(value));
}

/** Synthesized ids differ per covering index; correlate entries by postId. */
function postIdsOf(queryResult) {
  const ids = [];
  for (const document of queryResult.values()) {
    const postId = asBase58(document?.toObject()?.postId);
    if (postId) ids.push(postId);
  }
  return ids;
}

async function experimentBatchedMembership(ctx) {
  console.log('\n--- 3. batched membership: $ownerId == me AND postId IN [...] ---');

  const authorA1 = ctx.authorA1;
  const batch = [];
  for (let i = 0; i < 5; i++) {
    const post = await createPost(ctx, 'post', {
      content: POST_CONTENT,
      author: i < 3 ? authorA1 : bs58.decode(ctx.maker.ownerId),
      hashtag: i < 3 ? 'ranked' : 'batch',
      feeLabel: `post create #${i + 1} of 5 (repeat cost)`,
    });
    if (!expectAccepted(`3a post ${i + 1}/5 created`, post).ok) return;
    batch.push(post.id);
  }
  ctx.batchPosts = batch;

  const likes = [];
  for (let i = 0; i < 3; i++) {
    const like = await createLike(ctx, 'like', {
      postId: batch[i],
      hashtag: 'ranked',
      postAuthor: authorA1,
      feeLabel: `like create #${i + 1} of 3 (nth-like repeat cost)`,
    });
    if (!expectAccepted(`3b like ${i + 1}/3 created`, like).ok) return;
    likes.push(like);
    if (i === 0) {
      ctx.likeToUnlike = {
        postId: batch[0],
        hashtag: 'ranked',
        postAuthor: authorA1,
        // May be null: the DAPI gateway routinely 504s the confirmation wait
        // for a create that landed, and then no Document comes back at all.
        confirmed: like.value,
      };
    }
  }
  // The trap the broken byAuthor falls into does NOT apply where postId sits
  // in the projection: three likes under ONE hashtag by ONE liker landed.
  check(
    '3c two+ likes under the same hashtag by the same liker are accepted (byHashtagPost carries postId)',
    likes.length === 3 && likes.every((like) => like.ok)
  );

  const membership = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [
        ['$ownerId', '==', ctx.maker.ownerId],
        ['postId', 'in', batch],
      ],
      orderBy: [['postId', 'asc']],
    })
  );
  const returned = postIdsOf(membership).sort();
  const expected = [...batch.slice(0, 3)].sort();
  check(
    '3d membership query returns EXACTLY the 3 liked posts of the 5 asked',
    returned.length === 3 && returned.every((id, i) => id === expected[i]),
    `got ${returned.length}: ${returned.join(', ')}`
  );
}

async function experimentBrokenByAuthor(ctx) {
  console.log('\n--- 3½. the byAuthor trap, reproduced on likeB ---');
  const [p1, p2] = ctx.batchPosts;
  if (!p1 || !p2) {
    check('3e/3f byAuthor trap repro', false, 'no batch posts available');
    return;
  }
  expectAccepted(
    "3e likeB of author A1's FIRST post is accepted",
    await createLike(ctx, 'likeB', { postId: p1, hashtag: 'ranked', postAuthor: ctx.authorA1 })
  );
  expectRejected(
    "3f likeB of the SAME author's SECOND post is rejected — [postAuthor] terminal $ownerId " +
      'projects to one like per (author, liker) (40105)',
    await createLike(ctx, 'likeB', { postId: p2, hashtag: 'ranked', postAuthor: ctx.authorA1 }),
    DUPLICATE_UNIQUE
  );
}

async function experimentRanked(ctx) {
  console.log('\n--- 4. ranked top-K on the count axis ---');

  // Global top posts by like count: byPost is a single-property ranked index
  // ([postId] terminal $ownerId), so groupBy the property, no pins.
  const globalShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    groupBy: 'postId',
    aggregate: { type: 'count' },
    limit: 10,
  };
  const global = await readback(() => ctx.sdk.documents.ranked(globalShape));
  const likedPosts = [ctx.postU, ctx.postT, ...ctx.batchPosts.slice(0, 3)];
  const unlikedPosts = ctx.batchPosts.slice(3);
  // Preallocation makes every referenced post a rankable group from birth,
  // so the unliked posts appear at count 0 — desc order puts them last.
  const ones = global.entries.filter((entry) => entry.value === 1n).map((entry) => entry.groupValue);
  const zeros = global.entries.filter((entry) => entry.value === 0n).map((entry) => entry.groupValue);
  check(
    '4a global ranked byPost: liked posts at 1, preallocated unliked posts at 0',
    global.startingRank === 0n &&
      global.entries.length === likedPosts.length + unlikedPosts.length &&
      ones.length === likedPosts.length &&
      likedPosts.every((id) => ones.includes(id)) &&
      unlikedPosts.every((id) => zeros.includes(id)),
    `entries=${global.entries.length} values=[${global.entries.map((e) => e.value).join(',')}]`
  );
  ctx.rankedShapes.push({ label: 'global top posts by like count (byPost)', shape: globalShape });

  // Per-hashtag: byHashtagPost is compound — pin the leading property with a
  // where clause, group by the trailing one.
  const tagShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    groupBy: 'postId',
    aggregate: { type: 'count' },
    limit: 10,
    where: [['hashtag', '==', 'ranked']],
  };
  const perTag = await readback(() => ctx.sdk.documents.ranked(tagShape));
  const rankedPosts = ctx.batchPosts.slice(0, 3);
  const perTagGroups = perTag.entries.map((entry) => entry.groupValue);
  check(
    "4b ranked byHashtagPost pinned to 'ranked' returns exactly its 3 posts",
    perTag.entries.length === 3 && rankedPosts.every((id) => perTagGroups.includes(id)),
    `entries=${perTag.entries.length}`
  );
  ctx.rankedShapes.push({ label: "top posts within #ranked (byHashtagPost, '==' pin)", shape: tagShape });

  // The D1 sentinel on the ranked surface: pin hashtag == ''.
  const sentinelShape = { ...tagShape, where: [['hashtag', '==', '']] };
  const sentinel = await readback(() => ctx.sdk.documents.ranked(sentinelShape));
  check(
    "4c ranked pinned to hashtag '' returns exactly the untagged liked post",
    sentinel.entries.length === 1 && sentinel.entries[0].groupValue === ctx.postU,
    `entries=${sentinel.entries.length} group=${sentinel.entries[0]?.groupValue}`
  );
  ctx.rankedShapes.push({ label: "top posts within '' (sentinel pin)", shape: sentinelShape });

  // The profile "Top" tab: an author's top posts = byAuthorPost with the
  // postAuthor prefix pinned, grouped by the trailing postId.
  const a1 = bs58.encode(ctx.authorA1);
  const authorTopShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    groupBy: 'postId',
    aggregate: { type: 'count' },
    limit: 10,
    where: [['postAuthor', '==', a1]],
  };
  const authorTop = await readback(() => ctx.sdk.documents.ranked(authorTopShape));
  const a1Posts = ctx.batchPosts.slice(0, 3);
  const authorTopGroups = authorTop.entries.map((entry) => entry.groupValue);
  check(
    "4d author's top posts (byAuthorPost, postAuthor pin) returns A1's 3 liked posts",
    authorTop.entries.length === 3 &&
      authorTop.entries.every((entry) => entry.value === 1n) &&
      a1Posts.every((id) => authorTopGroups.includes(id)),
    `entries=${authorTop.entries.length}`
  );
  ctx.rankedShapes.push({ label: "author's top posts (byAuthorPost, postAuthor '==' pin)", shape: authorTopShape });

  // Per-author like TOTALS via a plain count are refused: proved counts
  // demand an index whose property list EXACTLY matches the where clause
  // fields, byAuthorPost is [postAuthor, postId], and the exact-match index
  // that could serve a bare postAuthor pin is the structurally-broken likeB
  // shape. (Round-2 discovery — a prefix pin is NOT a count shape.)
  let countError = null;
  try {
    await ctx.sdk.documents.count({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [['postAuthor', '==', a1]],
    });
  } catch (e) {
    countError = describeErr(e);
  }
  capture('4e count(postAuthor ==) prefix pin', countError);
  check(
    '4e per-author count on the byAuthorPost PREFIX is refused (exact-index-match rule)',
    countError !== null && /countable/i.test(countError),
    (countError ?? 'ACCEPTED — prefix counts work after all').slice(0, 160)
  );

  // Grouped per-`in`-value counts are a documented count surface — probe
  // whether they escape the exact-match rule. Both outcomes are recorded;
  // only a wrong total or an unrelated error fails.
  let grouped = null;
  let groupedError = null;
  try {
    const raw = await ctx.sdk.documents.count({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [['postAuthor', 'in', [a1, ctx.maker.ownerId]]],
      orderBy: [['postAuthor', 'asc']],
      groupBy: ['postAuthor'],
    });
    grouped = raw instanceof Map ? [...raw.entries()] : [];
  } catch (e) {
    groupedError = describeErr(e);
  }
  if (groupedError === null) {
    const groupedTotal = (key) => {
      const hit = grouped.find(([groupKey]) => groupKey === key || asBase58(groupKey) === key);
      return hit ? Number(hit[1]) : null;
    };
    check(
      '4f grouped count over postAuthor IN [A1, maker] WORKS and returns 3 and 2',
      groupedTotal(a1) === 3 && groupedTotal(ctx.maker.ownerId) === 2,
      `groups=${grouped.map(([key, value]) => `${typeof key === 'string' ? key : asBase58(key)}=${value}`).join(' ')}`
    );
  } else {
    capture('4f grouped count over postAuthor IN', groupedError);
    check(
      '4f grouped count over postAuthor IN is refused too (recorded for the results)',
      /countable|indexed property/i.test(groupedError),
      groupedError.slice(0, 160)
    );
  }

  // A GLOBAL creator leaderboard (ranked groupBy postAuthor) has no covering
  // index: ranked groups by the covering index's TRAILING property, and no
  // structurally-sound like index can end on postAuthor (a [postAuthor]
  // terminal $ownerId index is the likeB trap). Expect a refusal.
  let leaderboardError = null;
  try {
    await ctx.sdk.documents.ranked({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      groupBy: 'postAuthor',
      aggregate: { type: 'count' },
      limit: 5,
    });
  } catch (e) {
    leaderboardError = describeErr(e);
  }
  capture('4g ranked groupBy postAuthor (no covering index)', leaderboardError);
  check(
    '4g global creator leaderboard is refused (no index ends on postAuthor)',
    leaderboardError !== null,
    (leaderboardError ?? 'ACCEPTED (BAD)').slice(0, 180)
  );

  // The having-range spelling on the byPost axis.
  const havingShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    groupBy: 'postId',
    aggregate: { type: 'count' },
    having: { operator: '>=', value: 1 },
    limit: 100,
  };
  const having = await readback(() => ctx.sdk.documents.having(havingShape));
  const havingGroups = having.entries.map((entry) => entry.groupValue);
  check(
    '4h having(count >= 1) on byPost returns exactly the 5 liked posts',
    having.entries.length === likedPosts.length && likedPosts.every((id) => havingGroups.includes(id)),
    `entries=${having.entries.length}`
  );
  ctx.rankedShapes.push({ label: 'posts with >= 1 like (having, byPost)', shape: havingShape });
}

async function experimentUnlike(ctx) {
  console.log('\n--- 5. unlike: indexOnly delete by values + refund ---');
  if (!ctx.likeToUnlike) {
    check('5  unlike', false, 'no like on record to delete');
    return;
  }
  const { postId, hashtag, postAuthor, confirmed } = ctx.likeToUnlike;
  // The design keeps $createdAt out of every like index precisely so the
  // delete tuple is reconstructible from the values the client already
  // knows — no persisted Document required (the create-returned one is
  // unreliable anyway: a 504 on the confirmation wait leaves none).
  console.log(`     create-returned Document was retained: ${confirmed != null}`);
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.maker.ownerId,
    data: { postId: bs58.decode(postId), hashtag, postAuthor },
    entropy: randomIdBytes(),
  });

  const countBefore = await countLikes(ctx, 'like', postId);
  const deleted = await deleteLike(ctx, 'like', {
    document,
    postId,
    feeLabel: 'unlike (delete by locally-rebuilt values; negative = net refund)',
  });
  expectAccepted('5a unlike with a locally-rebuilt value tuple is accepted', deleted);
  const countAfter = await countLikes(ctx, 'like', postId);
  check('5b byPost count drops 1 → 0 (preallocated group survives at 0)', countBefore === 1 && countAfter === 0, `before=${countBefore} after=${countAfter}`);
}

async function countLikes(ctx, docType, postId) {
  return readback(async () => {
    const raw = await ctx.sdk.documents.count({
      dataContractId: ctx.contractId,
      documentTypeName: docType,
      where: [['postId', '==', postId]],
    });
    const total = raw instanceof Map ? raw.get('') : raw?.[''];
    return total === undefined || total === null ? 0 : Number(total);
  });
}

async function experimentD2Recovery(ctx) {
  console.log('\n--- 6. D2a: recover the likeT delete tuple from queries alone ---');

  // likeT requires $createdAt — Platform assigns it at commit; the confirmed
  // Document is retained ONLY to cross-check the recovery, never to drive it.
  const created = await createLike(ctx, 'likeT', {
    postId: ctx.postT,
    hashtag: 'dash',
    postAuthor: bs58.decode(ctx.maker.ownerId),
    feeLabel: 'likeT create (non-preallocated: first entry pays for trees)',
  });
  if (!expectAccepted('6a likeT (with required $createdAt) is accepted', created).ok) return;
  const confirmedObject = created.value?.toObject?.() ?? {};
  // Round-1 surprise: despite the d.ts promise ("consensus-populated system
  // fields included"), the returned Document exposed NO $createdAt through
  // any surface. Log all of them so the results record what the SDK does.
  const confirmedCreatedAt = confirmedObject.$createdAt ?? created.value?.createdAt ?? created.value?.created_at;
  console.log(
    `     create-returned Document: retained=${created.value != null} ` +
      `$createdAt: toObject=${confirmedObject.$createdAt} getter=${created.value?.createdAt}`
  );
  console.log(`     confirmed $createdAt = ${confirmedCreatedAt}`);

  // Recovery step 1 — byLiker: which posts did I likeT?
  const myLikes = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'likeT',
      where: [['$ownerId', '==', ctx.maker.ownerId]],
      orderBy: [['postId', 'asc']],
    })
  );
  const recoveredPostIds = postIdsOf(myLikes);
  check('6b byLiker recovers the liked postId', recoveredPostIds.includes(ctx.postT), `got [${recoveredPostIds.join(', ')}]`);

  // Recovery step 2 — byAuthorTime: the notification index synthesizes a
  // projection carrying postAuthor + $createdAt + $ownerId.
  const notifications = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'likeT',
      where: [['postAuthor', '==', ctx.maker.ownerId]],
      orderBy: [['$createdAt', 'desc']],
      limit: 1,
    })
  );
  const projection = [...notifications.values()][0]?.toObject() ?? null;
  const recoveredCreatedAt = projection?.$createdAt;
  check(
    '6c byAuthorTime projection carries the $createdAt timestamp',
    recoveredCreatedAt !== undefined && recoveredCreatedAt !== null,
    `projection=${JSON.stringify(projection, (k, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 200)}`
  );
  // The confirmed Document did not expose $createdAt in round 1 (SDK gap —
  // see 6a's log line), so the sanity bound is on the recovered value itself:
  // a real epoch-ms timestamp near now, not a bucket start or garbage bytes.
  const recoveredMs = recoveredCreatedAt === undefined ? NaN : Number(recoveredCreatedAt);
  const skewMs = Math.abs(Date.now() - recoveredMs);
  check(
    '6d recovered $createdAt is a sane, current epoch-ms timestamp',
    Number.isFinite(recoveredMs) && skewMs < 10 * 60 * 1000,
    `recovered=${recoveredCreatedAt} skew=${Math.round(skewMs / 1000)}s confirmed(from create)=${confirmedCreatedAt}`
  );

  // Recovery step 3 — the post itself supplies hashtag + postAuthor.
  const post = await fetchDocument(ctx.sdk, ctx.contractId, 'post', ctx.postT);
  const postObject = post?.toObject();
  const recoveredHashtag = postObject?.hashtag;
  const recoveredAuthorB58 = asBase58(postObject?.author);
  const recoveredAuthor = recoveredAuthorB58 ? bs58.decode(recoveredAuthorB58) : null;
  check(
    '6e the referenced post supplies hashtag + postAuthor',
    recoveredHashtag === 'dash' && recoveredAuthorB58 === ctx.maker.ownerId
  );

  if (recoveredCreatedAt === undefined || recoveredCreatedAt === null || recoveredAuthor === null) {
    check('6f delete with the recovered tuple', false, 'recovery incomplete — cannot attempt the delete');
    return;
  }

  // Rebuild the value tuple from recovered parts only, under a locally
  // generated id (nothing on chain is addressed by an indexOnly $id).
  const { document: recovered } = buildDocument({
    contractId: ctx.contractId,
    docType: 'likeT',
    ownerId: ctx.maker.ownerId,
    data: { postId: bs58.decode(ctx.postT), hashtag: recoveredHashtag, postAuthor: recoveredAuthor },
    entropy: randomIdBytes(),
    createdAt: BigInt(recoveredCreatedAt),
  });
  const deleted = await deleteLike(ctx, 'likeT', {
    document: recovered,
    postId: ctx.postT,
    feeLabel: 'likeT delete with query-recovered tuple (negative = net refund)',
  });
  expectAccepted('6f delete with the query-recovered tuple is accepted (D2a viable)', deleted);
}

// ---- Fee report -------------------------------------------------------------

function printFeeTable() {
  console.log('\n--- fee table (maker credit-balance deltas) ---');
  if (fees.length === 0) {
    console.log('(no fees recorded — every measured write was skipped or failed before broadcast)');
    return;
  }
  const width = Math.max(...fees.map((row) => row.label.length)) + 2;
  for (const { label, credits } of fees) {
    const vsBaseline =
      label.startsWith('like create') || label.startsWith('likeT create')
        ? `  (${((Number(credits) / Number(STORED_LIKE_BASELINE)) * 100).toFixed(1)}% of the ${STORED_LIKE_BASELINE.toLocaleString('en-US')}-credit stored-like baseline)`
        : '';
    console.log(`  ${label.padEnd(width)} ${fmtCredits(credits)}${vsBaseline}`);
  }
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { ownerId: DEFAULT_MAKER_ID, makerIndex: DEFAULT_MAKER_INDEX, contract: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--owner': args.ownerId = argv[++i]; break;
      case '--maker-index': args.makerIndex = Number(argv[++i]); break;
      case '--contract': args.contract = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!Number.isInteger(args.makerIndex) || args.makerIndex < 0) {
    throw new Error('--maker-index takes a non-negative integer');
  }
  return args;
}

function dryRun(args) {
  const json = experimentContractJson(args.ownerId, 1n);
  DataContract.fromJSON(json, true, PlatformVersion.current());
  console.log('contract JSON assembles and validates locally:');
  for (const [name, schema] of Object.entries(json.documentSchemas)) {
    const indices = (schema.indices ?? [])
      .map((index) => {
        const properties = index.properties.map((entry) => Object.keys(entry)[0]).join(',');
        const flags = [
          index.terminal ? `t:${index.terminal}` : '',
          index.countable ? 'c' : '',
          index.rankedCountable ? 'rk' : '',
          index.preallocated ? 'pre' : '',
        ].filter(Boolean).join('+');
        return `${index.name}[${properties}]${flags ? `(${flags})` : ''}`;
      })
      .join(' ');
    console.log(`  ${name.padEnd(6)} indexOnly=${schema.indexOnly === true}  ${indices || '(no indices)'}`);
  }
  const shapes = [
    ['post', { content: POST_CONTENT, author: randomIdBytes(), hashtag: '' }, undefined],
    ['postC', { content: POST_CONTENT, author: randomIdBytes(), hashtag: 'dash' }, undefined],
    ['like', { postId: randomIdBytes(), hashtag: 'dash', postAuthor: randomIdBytes() }, undefined],
    ['likeT', { postId: randomIdBytes(), hashtag: 'dash', postAuthor: randomIdBytes() }, BigInt(Date.now())],
    ['likeB', { postId: randomIdBytes(), hashtag: 'dash', postAuthor: randomIdBytes() }, undefined],
  ];
  for (const [docType, data, createdAt] of shapes) {
    const { id } = buildDocument({
      contractId: DRY_RUN_ID,
      docType,
      ownerId: args.ownerId,
      data,
      entropy: randomIdBytes(),
      createdAt,
    });
    console.log(`document shape ok: ${docType.padEnd(6)} → ${id}`);
  }
  const { devnetName, addresses } = devnetSdk();
  console.log(`would run on devnet "${devnetName}" via ${addresses[0]} (+${addresses.length - 1} more)`);
  console.log('DRY RUN OK — no network calls were made');
}

// ---- Main -------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/experiment-indexonly.mjs [--owner <id>] [--maker-index <n>] [--contract <id>] [--dry-run]');
  process.exit(1);
}

try {
  await ensureInitialized();

  if (args.dryRun) {
    dryRun(args);
    process.exit(0);
  }

  const { sdk, devnetName, addresses } = devnetSdk();
  await sdk.connect();
  console.log(`connected to devnet "${devnetName}" (${addresses.length} addresses)`);
  const maker = await makerSigner(sdk, args.ownerId, args.makerIndex);
  console.log(`signer: ${maker.label} (seed index ${args.makerIndex})`);
  console.log(`credits: ${fmtCredits(await creditBalance(sdk, maker.ownerId))}`);

  const ctx = {
    sdk,
    maker,
    contractId: args.contract,
    postU: null,
    postT: null,
    batchPosts: [],
    likeToUnlike: null,
    /** A synthetic second author, so byAuthor has two differentiated groups. */
    authorA1: randomIdBytes(),
    rankedShapes: [],
  };

  if (ctx.contractId) {
    await sdk.contracts.fetch(ctx.contractId);
    console.log(`reusing contract ${ctx.contractId}`);
  } else {
    await experimentRegistration(ctx);
  }

  // An unexpected throw fails its experiment loudly but never silences the
  // rest of the battery — later experiments are where the D-verdicts live.
  for (const experiment of [
    experimentD1Sentinel,
    experimentPreallocationControl,
    experimentBatchedMembership,
    experimentBrokenByAuthor,
    experimentRanked,
    experimentUnlike,
    experimentD2Recovery,
  ]) {
    try {
      await experiment(ctx);
    } catch (e) {
      check(`${experiment.name} completed`, false, `aborted: ${describeErr(e).slice(0, 220)}`);
    }
  }

  if (capturedErrors.length > 0) {
    console.log('\n--- captured rejection texts (verbatim) ---');
    for (const { label, message } of capturedErrors) {
      console.log(`\n[${label}]\n${message}`);
    }
  }

  if (ctx.rankedShapes.length > 0) {
    console.log('\n--- working ranked/having query shapes ---');
    for (const { label, shape } of ctx.rankedShapes) {
      console.log(`\n# ${label}\n${JSON.stringify({ ...shape, dataContractId: '<contractId>' }, null, 2)}`);
    }
  }

  printFeeTable();

  console.log('');
  console.log(`throwaway contract: ${ctx.contractId}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
