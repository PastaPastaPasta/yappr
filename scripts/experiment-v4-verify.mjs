/**
 * Phase 2a of the like overhaul (PLAN_LIKE_OVERHAUL.md §7) — VERIFICATION
 * ONLY (fee pricing was dropped from scope: the fee schedule is changing and
 * someone else owns the numbers). Three contract-v4 behaviors are proven on
 * the moutai devnet (protocol v14, @dashevo/evo-sdk 4.2.0-dev.5) against one
 * throwaway contract with a stored `post` and ONE indexOnly `like` doctype:
 *
 *   1. The 3-property notification index `byAuthorTimePost [postAuthor,
 *      $createdAt, postId] terminal $ownerId` supports the D2a multi-device
 *      unlike path END TO END: create a like, then — using NOTHING returned
 *      by the create — recover the full delete tuple from queries alone
 *      (byLiker → postId, byAuthorTimePost projection → the
 *      consensus-assigned $createdAt, the referenced post → postAuthor) and
 *      delete by values. Phase 1 only proved the 2-property spelling
 *      (`byAuthorTime`), which collides for same-block likes; v4 needs the
 *      3-property one.
 *   2. `byAuthorPost [postAuthor, postId] terminal $ownerId` does NOT trip
 *      the one-like-per-author trap: two likes by one liker on two DIFFERENT
 *      posts of the SAME author are both accepted. (The Phase-1 `byAuthor
 *      [postAuthor]` shape projects to (postAuthor, $ownerId) and rejects
 *      the second with 40105 — this is the regression guard for the fix.)
 *   3. The author-pinned ranked query shape on byAuthorPost — the profile
 *      "Top" tab: `documents.ranked({groupBy: 'postId', aggregate:
 *      {type: 'count'}, where: [['postAuthor', '==', authorId]]})` returns
 *      the author's posts by like count (zero-count preallocated groups
 *      included, per the Phase-1 finding).
 *
 * The like doctype is deliberately minimal (no hashtag property — the
 * hashtag axis is gated on upstream null-skip semantics anyway, see D6):
 *
 *   like: indexOnly, documentsMutable false, canBeDeleted true
 *     postId      refersTo permanentDocument→post,
 *                 propertyAgreement {postAuthor: author}
 *     postAuthor  identifier
 *     required: postId, postAuthor, $createdAt   ($createdAt forced by the
 *                                                 byAuthorTimePost index)
 *     byAuthorPost      [postAuthor, postId]             → $ownerId
 *                       countable+rangeCountable+rankedCountable (the chain
 *                       is mandatory for ranked), preallocated
 *     byAuthorTimePost  [postAuthor, $createdAt, postId] → $ownerId
 *     byLiker           [$ownerId]                       → postId
 *
 * Battery style follows scripts/experiment-indexonly.mjs (Phase 1): every
 * acceptance is decided by reading back from the chain (never by the SDK's
 * throw/no-throw), and a rejection that does not match the expected
 * consensus reason FAILS the case.
 *
 * ## Environment (same as Phase 1)
 *
 *   DEVNET_NAME       devnet name          (default: moutai)
 *   DAPI_ADDRESSES    comma-separated DAPI (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *   QUORUM_URL        quorum service for the trusted context
 *   E2E_SEED_PHRASE   BIP39 seed the maker keys derive from (env or .env.local)
 *
 * ## Run
 *
 *   node scripts/experiment-v4-verify.mjs --dry-run
 *   node scripts/experiment-v4-verify.mjs [--owner <makerId>] [--maker-index 9]
 *   node scripts/experiment-v4-verify.mjs --contract <id>   # reuse a registered contract
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
    // trusted mode is mandatory: wasm-sdk panics on `proofs: false`.
    trusted: true,
    ...(process.env.QUORUM_URL ? { quorumUrl: process.env.QUORUM_URL } : {}),
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- Reporting --------------------------------------------------------------

let failures = 0;
const capturedErrors = [];

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function capture(label, message) {
  if (message) capturedErrors.push({ label, message });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const randomIdBytes = () => crypto.getRandomValues(new Uint8Array(32));

// ---- Throwaway contract -----------------------------------------------------

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

function postSchema() {
  return {
    type: 'object',
    documentsMutable: true,
    canBeDeleted: false,
    properties: {
      content: { type: 'string', maxLength: 500, position: 0 },
      author: identifierProperty(1),
    },
    required: ['content', 'author'],
    additionalProperties: false,
  };
}

function likeSchema() {
  return {
    type: 'object',
    indexOnly: true,
    documentsMutable: false,
    canBeDeleted: true,
    indices: [
      {
        name: 'byAuthorPost',
        properties: [{ postAuthor: 'asc' }, { postId: 'asc' }],
        terminal: '$ownerId',
        // rankedCountable requires rangeCountable requires countable
        // (Phase 1 grammar finding 2) — the full chain is mandatory.
        countable: true,
        rangeCountable: true,
        rankedCountable: true,
        // Binds: postId (the referring property) is among the index's own
        // properties, postAuthor is an agreement key (Phase 1 finding 1).
        preallocated: true,
      },
      {
        // The D2a notification index, 3-property spelling (the 2-property
        // one collides for same-block likes). Indexing $createdAt forces it
        // into `required` — and therefore into the delete tuple, which is
        // exactly what experiment 1 must recover from queries alone.
        name: 'byAuthorTimePost',
        properties: [{ postAuthor: 'asc' }, { $createdAt: 'asc' }, { postId: 'asc' }],
        terminal: '$ownerId',
      },
      { name: 'byLiker', properties: [{ $ownerId: 'asc' }], terminal: 'postId' },
    ],
    properties: {
      postId: identifierProperty(0, {
        type: 'permanentDocument',
        documentType: 'post',
        propertyAgreement: { postAuthor: 'author' },
      }),
      postAuthor: identifierProperty(1),
    },
    required: ['postId', 'postAuthor', '$createdAt'],
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
      post: postSchema(),
      like: likeSchema(),
    },
  };
}

// ---- Document plumbing ------------------------------------------------------

/**
 * `Document.fromObject` with raw-byte ids is the only shape that survives
 * wasm-sdk 4.1+ (the `Document` constructor corrupts Uint8Array properties).
 */
function buildDocument({ contractId, docType, ownerId, data, entropy, createdAt }) {
  const idBytes = Document.generateId(docType, ownerId, contractId, entropy);
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
 * read (indexOnly documents cannot be fetched by $id).
 */
async function likeEntryExists(sdk, contractId, postId, ownerId) {
  return readback(async () => {
    const result = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: 'like',
      where: [
        ['postId', '==', postId],
        ['$ownerId', '==', ownerId],
      ],
    });
    return result.size > 0;
  });
}

const NOT_THROWN_BUT_ABSENT = 'the SDK reported no error, but the write is not on chain';

/**
 * Runs one write; the CHAIN decides the outcome (the DAPI gateway routinely
 * 504s waits for transitions that landed).
 */
async function verifiedWrite(accepted, write) {
  let error = null;
  try {
    await write();
  } catch (e) {
    error = describeErr(e);
  }
  for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
    if (await accepted()) return { ok: true, error: null };
    await settle();
  }
  return { ok: false, error: error ?? NOT_THROWN_BUT_ABSENT };
}

async function createPost(ctx, { content, author }) {
  const { document, id } = buildDocument({
    contractId: ctx.contractId,
    docType: 'post',
    ownerId: ctx.maker.ownerId,
    data: { content, author },
    entropy: randomIdBytes(),
  });
  const outcome = await verifiedWrite(
    () => fetchDocument(ctx.sdk, ctx.contractId, 'post', id).then((d) => d !== null),
    () => ctx.sdk.documents.create({ document, identityKey: ctx.maker.identityKey, signer: ctx.maker.signer })
  );
  return { ...outcome, id };
}

async function createLike(ctx, { postId, postAuthor }) {
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.maker.ownerId,
    // No $createdAt here: Platform assigns it at commit — recovering that
    // consensus value later is the whole point of experiment 1.
    data: { postId: bs58.decode(postId), postAuthor },
    entropy: randomIdBytes(),
  });
  return verifiedWrite(
    () => likeEntryExists(ctx.sdk, ctx.contractId, postId, ctx.maker.ownerId),
    () => ctx.sdk.documents.create({ document, identityKey: ctx.maker.identityKey, signer: ctx.maker.signer })
  );
}

function expectAccepted(label, outcome) {
  check(label, outcome.ok, outcome.ok ? '' : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
  return outcome;
}

/** Identifier values arrive as bytes or base58 depending on the surface. */
function asBase58(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return bs58.encode(Uint8Array.from(value));
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

async function experimentRegistration(ctx) {
  console.log('\n--- 0. throwaway contract registration ---');
  const identityNonce = ((await ctx.sdk.identities.nonce(ctx.maker.ownerId)) ?? 0n) + 1n;
  const json = experimentContractJson(ctx.maker.ownerId, identityNonce);
  const dataContract = DataContract.fromJSON(json, true, PlatformVersion.current());
  let publishError = null;
  try {
    await ctx.sdk.contracts.publish({
      dataContract,
      identityKey: ctx.maker.identityKey,
      signer: ctx.maker.signer,
    });
  } catch (e) {
    publishError = describeErr(e);
  }
  // The id is deterministic from the nonce — the chain, not the throw, decides.
  let registered = false;
  for (let poll = 0; poll < POLL_ATTEMPTS && !registered; poll++) {
    try {
      registered = (await ctx.sdk.contracts.fetch(json.id)) != null;
    } catch { /* keep polling */ }
    if (!registered) await settle();
  }
  if (!registered) {
    capture('contract registration', publishError ?? NOT_THROWN_BUT_ABSENT);
    throw new Error(`registration refused: ${(publishError ?? NOT_THROWN_BUT_ABSENT).slice(0, 300)}`);
  }
  ctx.contractId = json.id;
  check(
    '0a contract with byAuthorPost (ranked chain, preallocated) + 3-property byAuthorTimePost registered',
    true,
    ctx.contractId
  );
}

async function experimentSetup(ctx) {
  console.log('\n--- 1. fixture: three posts by one author, two likes ---');
  // A synthetic author, so the ranked pin has a clean, unambiguous group.
  ctx.author = randomIdBytes();
  ctx.authorB58 = bs58.encode(ctx.author);

  ctx.posts = [];
  for (let i = 0; i < 3; i++) {
    const post = await createPost(ctx, { content: `v4 verification post ${i + 1}`, author: ctx.author });
    if (!expectAccepted(`1${'abc'[i]} post ${i + 1}/3 (author A1) accepted`, post).ok) {
      throw new Error('fixture post creation failed — nothing downstream can run');
    }
    ctx.posts.push(post.id);
  }

  const like1 = await createLike(ctx, { postId: ctx.posts[0], postAuthor: ctx.author });
  expectAccepted("1d like #1 on A1's FIRST post accepted", like1);

  // VERIFICATION 2 — the one-like-per-author trap: on the broken Phase-1
  // `byAuthor [postAuthor] terminal $ownerId` shape, this second like by the
  // SAME liker on the SAME author's OTHER post is refused with 40105.
  // byAuthorPost [postAuthor, postId] carries postId in its projection, so
  // it must be accepted.
  const like2 = await createLike(ctx, { postId: ctx.posts[1], postAuthor: ctx.author });
  expectAccepted(
    "1e VERIFY(trap): like #2 by the same liker on the SAME author's SECOND post accepted — byAuthorPost does not trip the one-like-per-author trap",
    like2
  );
  if (!like1.ok || !like2.ok) throw new Error('fixture likes failed — nothing downstream can run');
}

async function experimentAuthorPinnedRanked(ctx) {
  console.log('\n--- 2. the author-pinned ranked query on byAuthorPost ---');
  // VERIFICATION 3 — the profile-"Top"-tab shape: pin the leading index
  // property with a where clause, group by the trailing one. Expected: the
  // two liked posts at count 1, and the third (unliked) post at count 0 —
  // preallocation makes every referenced post a rankable group from birth,
  // and ranked pages on preallocated indexes include zero-count groups.
  const shape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    groupBy: 'postId',
    aggregate: { type: 'count' },
    limit: 10,
    where: [['postAuthor', '==', ctx.authorB58]],
  };
  const ranked = await readback(() => ctx.sdk.documents.ranked(shape));
  const ones = ranked.entries.filter((e) => e.value === 1n).map((e) => e.groupValue);
  const zeros = ranked.entries.filter((e) => e.value === 0n).map((e) => e.groupValue);
  const liked = ctx.posts.slice(0, 2);
  check(
    "2a VERIFY(ranked): ranked({groupBy:'postId', where:[['postAuthor','==',A1]]}) returns A1's posts by like count",
    ranked.entries.length === 3 &&
      ones.length === 2 &&
      liked.every((id) => ones.includes(id)) &&
      zeros.length === 1 &&
      zeros[0] === ctx.posts[2],
    `entries=${ranked.entries.length} values=[${ranked.entries.map((e) => e.value).join(',')}] (zero-count group = the unliked preallocated post)`
  );
  console.log(`     shape: ${JSON.stringify({ ...shape, dataContractId: '<contractId>' })}`);
}

/**
 * Ordering fallbacks for the recovery query: the notification read the app
 * will actually run is "newest first", but if the engine refuses a bare
 * second-property orderBy on the 3-property index, the asc spellings are
 * probed too and whichever works is reported.
 */
const RECOVERY_ORDER_SHAPES = [
  [['$createdAt', 'desc']],
  [['$createdAt', 'asc']],
  [['$createdAt', 'asc'], ['postId', 'asc']],
];

async function experimentRecoveryUnlike(ctx) {
  console.log('\n--- 3. D2a on the 3-property index: recover the tuple, then delete ---');
  // VERIFICATION 1 — end-to-end multi-device unlike for like #2, using
  // NOTHING from the create call.

  // Step 1 — byLiker: which posts did I like?
  const myLikes = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [['$ownerId', '==', ctx.maker.ownerId]],
      orderBy: [['postId', 'asc']],
    })
  );
  const recoveredPostIds = [];
  for (const document of myLikes.values()) {
    const postId = asBase58(document?.toObject()?.postId);
    if (postId) recoveredPostIds.push(postId);
  }
  const target = ctx.posts[1];
  check(
    '3a byLiker recovers the liked postIds',
    recoveredPostIds.includes(target) && recoveredPostIds.includes(ctx.posts[0]),
    `got [${recoveredPostIds.join(', ')}]`
  );

  // Step 2 — byAuthorTimePost: pin the author, order by time; the
  // synthesized projection must carry $createdAt AND postId (the 3-property
  // advantage over Phase 1's byAuthorTime: the match is exact, not
  // positional, and no byLiker join is needed to know WHICH like it is).
  let recovered = null;
  let usedOrderBy = null;
  for (const orderBy of RECOVERY_ORDER_SHAPES) {
    try {
      const result = await readback(() =>
        ctx.sdk.documents.query({
          dataContractId: ctx.contractId,
          documentTypeName: 'like',
          where: [['postAuthor', '==', ctx.authorB58]],
          orderBy,
          limit: 25,
        })
      );
      usedOrderBy = orderBy;
      for (const document of result.values()) {
        const projection = document.toObject();
        if (asBase58(projection?.postId) === target) recovered = projection;
      }
      break;
    } catch (e) {
      capture(`recovery orderBy ${JSON.stringify(orderBy)}`, describeErr(e));
    }
  }
  const serialize = (value) =>
    JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? asBase58(v) : v));
  check(
    '3b byAuthorTimePost projection carries $createdAt AND postId for the target like',
    recovered?.$createdAt !== undefined && recovered?.$createdAt !== null,
    recovered
      ? `orderBy=${JSON.stringify(usedOrderBy)} projection=${serialize(recovered)?.slice(0, 220)}`
      : `no projection matched postId=${target} (orderBy tried: ${JSON.stringify(usedOrderBy)})`
  );
  const recoveredMs = recovered?.$createdAt === undefined ? NaN : Number(recovered.$createdAt);
  const skewMs = Math.abs(Date.now() - recoveredMs);
  check(
    '3c recovered $createdAt is a sane, current epoch-ms timestamp',
    Number.isFinite(recoveredMs) && skewMs < 10 * 60 * 1000,
    `recovered=${recovered?.$createdAt} skew=${Math.round(skewMs / 1000)}s`
  );

  // Step 3 — the referenced post supplies postAuthor (the agreement value).
  const post = await fetchDocument(ctx.sdk, ctx.contractId, 'post', target);
  const recoveredAuthorB58 = asBase58(post?.toObject()?.author);
  check('3d the referenced post supplies postAuthor', recoveredAuthorB58 === ctx.authorB58);

  if (!recovered?.$createdAt || recoveredAuthorB58 === null) {
    check('3e delete with the recovered tuple', false, 'recovery incomplete — cannot attempt the delete');
    return;
  }

  // Step 4 — rebuild the full value tuple from recovered parts only, under a
  // locally generated id (nothing on chain is addressed by an indexOnly $id),
  // and delete by values.
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.maker.ownerId,
    data: { postId: bs58.decode(target), postAuthor: bs58.decode(recoveredAuthorB58) },
    entropy: randomIdBytes(),
    createdAt: BigInt(recovered.$createdAt),
  });
  const deleted = await verifiedWrite(
    () => likeEntryExists(ctx.sdk, ctx.contractId, target, ctx.maker.ownerId).then((exists) => !exists),
    () => ctx.sdk.documents.delete({ document, identityKey: ctx.maker.identityKey, signer: ctx.maker.signer })
  );
  expectAccepted(
    '3e VERIFY(recovery): delete with the query-recovered 3-property tuple is accepted — D2a holds on byAuthorTimePost',
    deleted
  );

  // The other like must have survived its neighbor's deletion.
  const survivor = await likeEntryExists(ctx.sdk, ctx.contractId, ctx.posts[0], ctx.maker.ownerId);
  check('3f the OTHER like (same author, same liker) survives the unlike', survivor === true);
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
    console.log(`  ${name.padEnd(5)} indexOnly=${schema.indexOnly === true}  ${indices || '(no indices)'}`);
  }
  const shapes = [
    ['post', { content: 'v4 verification post', author: randomIdBytes() }, undefined],
    ['like', { postId: randomIdBytes(), postAuthor: randomIdBytes() }, BigInt(Date.now())],
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
    console.log(`document shape ok: ${docType.padEnd(5)} → ${id}`);
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
  console.error('Usage: node scripts/experiment-v4-verify.mjs [--owner <id>] [--maker-index <n>] [--contract <id>] [--dry-run]');
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

  const ctx = { sdk, maker, contractId: args.contract, posts: [], author: null, authorB58: null };

  if (ctx.contractId) {
    await sdk.contracts.fetch(ctx.contractId);
    console.log(`reusing contract ${ctx.contractId}`);
  } else {
    await experimentRegistration(ctx);
  }

  await experimentSetup(ctx);
  // An unexpected throw fails its experiment loudly but never silences the
  // other one — the two remaining experiments are independent.
  for (const experiment of [experimentAuthorPinnedRanked, experimentRecoveryUnlike]) {
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

  console.log('');
  console.log(`throwaway contract: ${ctx.contractId}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
