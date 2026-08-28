/**
 * Verification battery for the **v3 interaction topology**
 * (PLAN_CONTRACT_V3_TOPOLOGY.md), run against a devnet copy of
 * `contracts/yappr-social-contract-v3-topology.json`.
 *
 * Where `verify-refersto.mjs` probed the *mechanism* (`refersTo`,
 * `permanentDocument`, null-unique semantics) on a throwaway lab contract, this
 * one asserts the mechanism is wired into the real social contract the way the
 * design says: that a reply must name an existing root post, that reply likes go
 * to their own doctype, that a repost or bookmark of a REPLY is refused by
 * consensus rather than by client convention, that both quote fields work and
 * neither is unique, that posts and replies can only be tombstoned, and that
 * every count tree round-trips.
 *
 * The contract needs protocol v14 for `refersTo`, so this is devnet-only —
 * testnet is still on v13 and would reject the contract itself.
 *
 * Cases:
 *   1  reply linkage: rootPostId must exist; replyToReplyId must exist when set,
 *      and may be absent
 *   2  likes: like of a nonexistent post rejected; likeReply unique per
 *      (replyId, owner); likeReply of a nonexistent reply rejected
 *   3  posts-only repost/bookmark: a REPLY id is rejected by consensus, a post
 *      id is accepted
 *   4  dual quote fields: each accepted alone, both together tolerated,
 *      nonexistent targets rejected, and the same owner quoting the same target
 *      twice is ACCEPTED (uniqueness deliberately dropped)
 *   5  tombstones: replace-to-clear with `deleted: true` accepted on post and
 *      reply; deleting either is rejected
 *   6  count trees: byRoot / byReplyToReply / byReply / quoteReplyCount
 *
 * Every rejection is asserted by *reading back* after the failure, so the DAPI
 * 504 quirk (broadcast landed, the wait timed out) cannot be mistaken for a
 * consensus rejection — and a rejection whose text matches none of the expected
 * reasons FAILS rather than passes, so a broken key or an unfunded identity can
 * never be mistaken for enforcement.
 *
 * ## Environment
 *
 *   DEVNET_NAME           devnet name           (default: moutai)
 *   DAPI_ADDRESSES        comma-separated DAPI  (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *   QUORUM_URL            quorum service for the trusted context
 *   DEVNET_IDENTITY_IDS   comma-separated devnet identity ids for the bot pool
 *                         (falls back to E2E_IDENTITY_IDS / .env.testing)
 *   E2E_SEED_PHRASE       the BIP39 seed the bot keys derive from
 *
 * `NETWORK=devnet` makes `scripts/sdk-env.mjs` read the checked-in `.env.devnet`
 * for all of the above, including `E2E_IDENTITY_IDS` (the DEVNET pool).
 *
 * Both bots need a YAPP balance on the contract under test: post, reply, like
 * and likeReply all carry a `tokenCost.create`, and a fresh contract mints its
 * whole supply to the contract owner. `register-social-v3-draft.mjs --fund`
 * does that; case 0 checks it and aborts early with a clear message if not.
 *
 * ## Run
 *
 *   node scripts/verify-topology.mjs --dry-run
 *   NETWORK=devnet node scripts/verify-topology.mjs --contract <topologyContractId> \
 *        [--bot 0] [--bot2 1] [--owner <idA>] [--owner2 <idB>] [--only 1,3]
 */
import {
  Document,
  EvoSDK,
  IdentitySigner,
  PlatformVersion,
  TokenPaymentInfo,
  ensureInitialized,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';

const SDK_TIMEOUT_MS = 30000;
const DEFAULT_DEVNET_NAME = 'moutai';
const DEFAULT_SEED_COUNT = 5;
/** Reads settle behind the write quorum; give the chain a beat before asserting. */
const SETTLE_MS = 3000;
/** How many settle intervals to wait before calling a write absent (~9s). */
const POLL_ATTEMPTS = 3;
/** Placeholder ids for `--dry-run`, where nothing is fetched or signed. */
const DRY_RUN_ID = '11111111111111111111111111111111';
/** YAPP is at token position 0; the battery's writes cost 10/3/1 per document. */
const YAPP_TOKEN_POSITION = 0;
/** Below this the run cannot finish, so it aborts instead of failing cases. */
const MIN_YAPP_BALANCE = 60n;

// ---- Devnet SDK (inline on purpose: this script owns its network config) ----

/** `seed-1..5.<devnet>.networks.dash.org:1443` — the standard devnet seed layout. */
function defaultDevnetAddresses(devnetName) {
  return Array.from(
    { length: DEFAULT_SEED_COUNT },
    (_, i) => `https://seed-${i + 1}.${devnetName}.networks.dash.org:1443`
  );
}

/** Reads `DEVNET_NAME` / `DAPI_ADDRESSES` and builds a trusted-mode devnet SDK. */
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
    // trusted mode is mandatory: wasm-sdk panics on `proofs: false` ("queries
    // without proofs are not supported yet") and refuses non-trusted proofs.
    // The trusted context prefetches quorum keys from
    // https://quorums.<devnetName>.networks.dash.org (or QUORUM_URL).
    trusted: true,
    ...(process.env.QUORUM_URL ? { quorumUrl: process.env.QUORUM_URL } : {}),
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- Reporting --------------------------------------------------------------

let failures = 0;
/** Every rejection text seen, printed verbatim at the end. */
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

// ---- Document plumbing ------------------------------------------------------

/**
 * Builds a canonical document. `Document.fromObject` with raw-byte ids is the
 * only shape that survives wasm-sdk 4.1+: the `Document` constructor corrupts
 * Uint8Array properties there.
 */
function buildDocument({ contractId, docType, ownerId, data, entropy, revision = 1n, id }) {
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
      ...data,
    },
    PlatformVersion.current()
  );
  return { document, id: bs58.encode(idBytes) };
}

const READ_ATTEMPTS = 4;

async function fetchDocument(sdk, contractId, docType, id) {
  // A read failure is NOT absence: a gateway timeout while verifying a delete
  // must not count as "deleted", and an unreadable accepted write must not be
  // scored as rejected. Transient faults are retried with backoff; if no
  // authoritative answer is obtained the battery aborts loudly rather than
  // letting a case pass or fail on unavailability. Only a successful read
  // returning no document satisfies the absence predicate.
  let lastError;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      return (await sdk.documents.get(contractId, docType, id)) ?? null;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error(
    `document read failed after ${READ_ATTEMPTS} attempts — cannot distinguish absence from unavailability: ${describeErr(lastError)}`
  );
}

const NOT_THROWN_BUT_ABSENT = 'the SDK reported no error, but the write is not on chain';

/**
 * Runs one write and decides its outcome by polling the chain until `accepted`
 * holds for the document, or the attempts run out. The chain — not the SDK's
 * throw/no-throw — is what decides whether a write was accepted here: the DAPI
 * gateway routinely 504s the wait for a transition that did land, and a facade
 * call that does not wait would report success for a transition consensus later
 * refuses. Reading back covers both; the SDK's error, when there was one, is
 * only reported as the reason for a write that never showed up.
 */
async function attemptWrite(sdk, { contractId, docType, id, accepted }, write) {
  let error = null;
  try {
    await write();
  } catch (e) {
    error = describeErr(e);
  }
  for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
    await settle();
    if (accepted(await fetchDocument(sdk, contractId, docType, id))) return { ok: true, id, error: null };
  }
  return { ok: false, id, error: error ?? NOT_THROWN_BUT_ABSENT };
}

/** Creates a document; acceptance is decided by reading it back. */
async function attemptCreate(sdk, who, { contractId, docType, data, tokenCost }) {
  const { document, id } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    entropy: randomIdBytes(),
  });
  return attemptWrite(sdk, { contractId, docType, id, accepted: (d) => d !== null }, () =>
    sdk.documents.create({
      document,
      identityKey: who.identityKey,
      signer: who.signer,
      // Token-priced doctypes need an explicit payment agreement carrying the
      // caller's approved maximum, mirroring what the app attaches
      // (state-transition-service.resolveTokenPayment / YAPP_TOKEN_COSTS).
      ...(tokenCost
        ? {
            tokenPaymentInfo: new TokenPaymentInfo({
              tokenContractPosition: YAPP_TOKEN_POSITION,
              maximumTokenCost: BigInt(tokenCost),
            }),
          }
        : {}),
    })
  );
}

/** Replaces a document with a full data set at `revision + 1`. */
async function attemptReplace(sdk, who, { contractId, docType, id, data, revision }) {
  const nextRevision = revision + 1n;
  const { document } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    revision: nextRevision,
    id: bs58.decode(id),
  });
  const outcome = await attemptWrite(
    sdk,
    { contractId, docType, id, accepted: (d) => d?.revision !== undefined && d.revision >= nextRevision },
    () => sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer })
  );
  return { ...outcome, revision: outcome.ok ? nextRevision : revision };
}

/** Deletes a document; absence after the call is what counts as success. */
async function attemptDelete(sdk, who, { contractId, docType, id }) {
  return attemptWrite(sdk, { contractId, docType, id, accepted: (d) => d === null }, () =>
    sdk.documents.delete({
      document: { id, ownerId: who.ownerId, dataContractId: contractId, documentTypeName: docType },
      identityKey: who.identityKey,
      signer: who.signer,
    })
  );
}

function expectAccepted(label, outcome) {
  check(label, outcome.ok, outcome.ok ? `id=${outcome.id}` : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
  return outcome;
}

/**
 * The shapes a reference rejection can take, per the `#[error(...)]` formats in
 * rs-dpp's `errors/consensus/state/document/referenced_*_error.rs`. A rejection
 * whose text matches none of these is still a rejection — but not necessarily
 * the one the case is testing for, so it is called out rather than passed over.
 */
const REFERENCE_REJECTION = /referenced .*(not found|is disabled)|canBeDeleted|4012\d/i;

/** The delete-immutability refusal ("documents of type X can not be deleted"). */
const DELETE_FORBIDDEN = /can ?not be deleted/i;

/** The unique-index violation (DuplicateUniqueIndexError, 40105). */
const DUPLICATE_UNIQUE = /duplicate unique properties|40105/i;

/**
 * Asserts Platform refused the write FOR THE EXPECTED REASON. A rejection whose
 * text matches no expected pattern FAILS the check: a broken key, an unfunded
 * identity, a transport fault, or a write that silently never landed would all
 * produce "did not land", and passing those would let a run advertise
 * enforcement that never actually fired.
 */
function expectRejected(label, outcome, { pattern = REFERENCE_REJECTION } = {}) {
  const reason = outcome.error ?? '';
  if (outcome.ok) {
    check(label, false, 'ACCEPTED (BAD)');
    return outcome;
  }
  capture(label, outcome.error);
  const matched = pattern.test(reason);
  check(
    label,
    matched,
    matched
      ? reason.slice(0, 220)
      : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 180)}`
  );
  return outcome;
}

// ---- Document shapes -------------------------------------------------------
//
// One place per doctype, so `--dry-run` builds exactly what the live run writes.

const TOKEN_COST = { post: 10, reply: 3, like: 1, likeReply: 1, repost: 1 };

const postData = ({ content = 'topology battery post', quotedPostId, quotedReplyId, deleted } = {}) => ({
  content,
  language: 'en',
  ...(quotedPostId ? { quotedPostId } : {}),
  ...(quotedReplyId ? { quotedReplyId } : {}),
  ...(deleted === undefined ? {} : { deleted }),
});

const replyData = ({ rootPostId, replyToReplyId, parentOwnerId, content = 'topology battery reply', deleted } = {}) => ({
  content,
  rootPostId,
  parentOwnerId,
  ...(replyToReplyId ? { replyToReplyId } : {}),
  ...(deleted === undefined ? {} : { deleted }),
});

const likeData = ({ postId, postOwnerId }) => ({ postId, ...(postOwnerId ? { postOwnerId } : {}) });
const likeReplyData = ({ replyId, replyOwnerId }) => ({ replyId, ...(replyOwnerId ? { replyOwnerId } : {}) });
const repostData = ({ postId, postOwnerId }) => ({ postId, postOwnerId });
const bookmarkData = ({ postId }) => ({ postId });

// ---- Identities -------------------------------------------------------------

/**
 * Devnet identity ids, which are not derivable and so must be configured. With
 * `NETWORK=devnet`, `loadIdentityIds()` already reads `.env.devnet`'s DEVNET
 * pool; the explicit `DEVNET_IDENTITY_IDS` override stays for ad-hoc pools.
 */
function poolIdentityIds() {
  const raw = process.env.DEVNET_IDENTITY_IDS ?? '';
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length > 0) return { ids, source: 'DEVNET_IDENTITY_IDS' };
  return { ids: loadIdentityIds(), source: 'E2E_IDENTITY_IDS (set NETWORK=devnet to read .env.devnet)' };
}

async function botSigner(sdk, index, explicitOwnerId) {
  let ownerId = explicitOwnerId;
  if (!ownerId) {
    const { ids, source } = poolIdentityIds();
    ownerId = ids[index];
    if (ownerId) console.log(`     (bot ${index} identity from ${source})`);
  }
  if (!ownerId) {
    throw new Error(
      `No identity id for bot index ${index}: pass --owner/--owner2 or set DEVNET_IDENTITY_IDS`
    );
  }
  const { wif } = criticalAuthKey(deriveIdentityKeys(index));
  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error(`Identity ${ownerId} not found on this devnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  if (!identityKey) throw new Error(`Identity ${ownerId} has no key ${CRITICAL_AUTH_KEY_ID}`);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wif);
  return { ownerId, identityKey, signer, label: `bot${index}(${ownerId})` };
}

/**
 * Aborts before any case runs if a bot cannot pay for its writes. Without this
 * every token-priced case would fail with an "insufficient token balance"
 * rejection that `expectRejected` correctly refuses to accept as enforcement —
 * a confusing wall of FAILs instead of one actionable message.
 */
async function requireYapp(sdk, contractId, bots) {
  const tokenId = await sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION);
  const balances = await sdk.tokens.balances(bots.map((bot) => bot.ownerId), tokenId);
  const short = [];
  for (const bot of bots) {
    const balance = (balances instanceof Map ? balances.get(bot.ownerId) : undefined) ?? 0n;
    console.log(`     ${bot.label}: ${balance} YAPP`);
    if (balance < MIN_YAPP_BALANCE) short.push(`${bot.ownerId} (${balance})`);
  }
  if (short.length > 0) {
    throw new Error(
      `YAPP balance below ${MIN_YAPP_BALANCE} for ${short.join(', ')} on token ${tokenId}. ` +
      `Fund them: node scripts/register-social-v3-draft.mjs … --fund <ids> (or transfer from the contract owner).`
    );
  }
}

// ---- Shared fixtures --------------------------------------------------------

/** A real post owned by bot A, created once and reused by later cases. */
async function ensurePost(ctx) {
  if (ctx.postId) return ctx.postId;
  const created = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'post',
    data: postData({ content: 'battery anchor post' }),
    tokenCost: TOKEN_COST.post,
  });
  if (!created.ok) {
    console.log(`     (could not create the anchor post: ${(created.error ?? '').slice(0, 200)})`);
    return null;
  }
  ctx.postId = created.id;
  return created.id;
}

/** A real reply owned by bot A, rooted at the anchor post. */
async function ensureReply(ctx) {
  if (ctx.replyId) return ctx.replyId;
  const rootPostId = await ensurePost(ctx);
  if (!rootPostId) return null;
  const created = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'reply',
    data: replyData({
      rootPostId: bs58.decode(rootPostId),
      parentOwnerId: bs58.decode(ctx.botA.ownerId),
      content: 'battery anchor reply',
    }),
    tokenCost: TOKEN_COST.reply,
  });
  if (!created.ok) {
    console.log(`     (could not create the anchor reply: ${(created.error ?? '').slice(0, 200)})`);
    return null;
  }
  ctx.replyId = created.id;
  return created.id;
}

// ---- Cases ------------------------------------------------------------------

async function case1ReplyLinkage(ctx) {
  console.log('\n--- 1. reply linkage: rootPostId (required) and replyToReplyId (optional) ---');
  const rootPostId = await ensurePost(ctx);
  if (!rootPostId) {
    check('1  reply linkage', false, 'no anchor post available');
    return;
  }

  expectRejected(
    '1a reply whose rootPostId does not exist is rejected',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({ rootPostId: randomIdBytes(), parentOwnerId: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.reply,
    })
  );

  const flat = expectAccepted(
    '1b reply to a real post (replyToReplyId absent) is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({
        rootPostId: bs58.decode(rootPostId),
        parentOwnerId: bs58.decode(ctx.botA.ownerId),
        content: 'flat reply',
      }),
      tokenCost: TOKEN_COST.reply,
    })
  );
  if (flat.ok) ctx.threadReplyIds.push(flat.id);

  const anchorReply = await ensureReply(ctx);
  if (!anchorReply) {
    check('1  reply-to-reply linkage', false, 'no anchor reply available');
    return;
  }
  ctx.threadReplyIds.push(anchorReply);

  const nested = expectAccepted(
    '1c reply-to-reply with a real replyToReplyId is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({
        rootPostId: bs58.decode(rootPostId),
        replyToReplyId: bs58.decode(anchorReply),
        parentOwnerId: bs58.decode(ctx.botA.ownerId),
        content: 'nested reply',
      }),
      tokenCost: TOKEN_COST.reply,
    })
  );
  if (nested.ok) {
    ctx.threadReplyIds.push(nested.id);
    ctx.nestedUnder = anchorReply;
    ctx.nestedCount += 1;
  }

  expectRejected(
    '1d reply whose replyToReplyId does not exist is rejected',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({
        rootPostId: bs58.decode(rootPostId),
        replyToReplyId: randomIdBytes(),
        parentOwnerId: bs58.decode(ctx.botA.ownerId),
      }),
      tokenCost: TOKEN_COST.reply,
    })
  );
}

async function case2Likes(ctx) {
  console.log('\n--- 2. like → post only, likeReply → reply only ---');
  const postId = await ensurePost(ctx);
  const replyId = await ensureReply(ctx);
  if (!postId || !replyId) {
    check('2  likes', false, 'no anchor post/reply available');
    return;
  }

  expectRejected(
    '2a like of a nonexistent post is rejected',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'like',
      data: likeData({ postId: randomIdBytes(), postOwnerId: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.like,
    })
  );

  expectRejected(
    '2b likeReply of a nonexistent reply is rejected',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'likeReply',
      data: likeReplyData({ replyId: randomIdBytes(), replyOwnerId: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.likeReply,
    })
  );

  const liked = expectAccepted(
    '2c likeReply of a real reply is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'likeReply',
      data: likeReplyData({ replyId: bs58.decode(replyId), replyOwnerId: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.likeReply,
    })
  );
  if (liked.ok) {
    ctx.replyLikes += 1;

    expectRejected(
      '2d a second likeReply of the same reply by the same owner is rejected (unique)',
      await attemptCreate(ctx.sdk, ctx.botB, {
        contractId: ctx.contractId,
        docType: 'likeReply',
        data: likeReplyData({ replyId: bs58.decode(replyId), replyOwnerId: bs58.decode(ctx.botA.ownerId) }),
        tokenCost: TOKEN_COST.likeReply,
      }),
      { pattern: DUPLICATE_UNIQUE }
    );

    // A different owner liking the same reply is the control: uniqueness is per
    // (owner, reply) pair, not per reply.
    const other = expectAccepted(
      '2e a DIFFERENT owner liking the same reply is accepted',
      await attemptCreate(ctx.sdk, ctx.botA, {
        contractId: ctx.contractId,
        docType: 'likeReply',
        data: likeReplyData({ replyId: bs58.decode(replyId), replyOwnerId: bs58.decode(ctx.botA.ownerId) }),
        tokenCost: TOKEN_COST.likeReply,
      })
    );
    if (other.ok) ctx.replyLikes += 1;
  }
}

async function case3PostsOnly(ctx) {
  console.log('\n--- 3. repost / bookmark accept posts and REFUSE replies ---');
  const postId = await ensurePost(ctx);
  const replyId = await ensureReply(ctx);
  if (!postId || !replyId) {
    check('3  posts-only repost/bookmark', false, 'no anchor post/reply available');
    return;
  }

  // The upgrade this case exists to prove: on v2 "reposts are posts-only" was a
  // client convention; here consensus refuses the reply id outright.
  expectRejected(
    '3a repost of a REPLY id is rejected by consensus',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'repost',
      data: repostData({ postId: bs58.decode(replyId), postOwnerId: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.repost,
    })
  );

  expectRejected(
    '3b bookmark of a REPLY id is rejected by consensus',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'bookmark',
      data: bookmarkData({ postId: bs58.decode(replyId) }),
    })
  );

  expectAccepted(
    '3c repost of a real post is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'repost',
      data: repostData({ postId: bs58.decode(postId), postOwnerId: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.repost,
    })
  );

  expectAccepted(
    '3d bookmark of a real post is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'bookmark',
      data: bookmarkData({ postId: bs58.decode(postId) }),
    })
  );
}

async function case4DualQuotes(ctx) {
  console.log('\n--- 4. dual quote fields, uniqueness deliberately dropped ---');
  const postId = await ensurePost(ctx);
  const replyId = await ensureReply(ctx);
  if (!postId || !replyId) {
    check('4  dual quotes', false, 'no anchor post/reply available');
    return;
  }

  expectAccepted(
    '4a quote-of-post (quotedPostId only) is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'quoting a post', quotedPostId: bs58.decode(postId) }),
      tokenCost: TOKEN_COST.post,
    })
  );

  const quoteOfReply = expectAccepted(
    '4b quote-of-reply (quotedReplyId only) is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'quoting a reply', quotedReplyId: bs58.decode(replyId) }),
      tokenCost: TOKEN_COST.post,
    })
  );
  if (quoteOfReply.ok) ctx.replyQuotes += 1;

  // THE POINT OF THE REDESIGN: `quotedPostAndOwner` was unique on v2, which made
  // a second quote of the same target by the same author impossible. Quotes are
  // content, not toggles, so this must now be accepted.
  expectAccepted(
    '4c the SAME owner quoting the SAME post twice is accepted (uniqueness dropped)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'quoting the same post again', quotedPostId: bs58.decode(postId) }),
      tokenCost: TOKEN_COST.post,
    })
  );

  // The client never writes both, but nothing in the schema forbids it — recorded
  // so a future uniqueness or exclusivity rule shows up as a behaviour change.
  const both = expectAccepted(
    '4d both quote fields set at once is tolerated by the chain',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({
        content: 'quoting both',
        quotedPostId: bs58.decode(postId),
        quotedReplyId: bs58.decode(replyId),
      }),
      tokenCost: TOKEN_COST.post,
    })
  );
  if (both.ok) ctx.replyQuotes += 1;

  expectRejected(
    '4e quotedPostId pointing at a nonexistent post is rejected',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'dangling post quote', quotedPostId: randomIdBytes() }),
      tokenCost: TOKEN_COST.post,
    })
  );

  expectRejected(
    '4f quotedReplyId pointing at a nonexistent reply is rejected',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'dangling reply quote', quotedReplyId: randomIdBytes() }),
      tokenCost: TOKEN_COST.post,
    })
  );

  // A quote of a REPLY id in the post field must be refused: `quotedPostId`
  // resolves only against `post`.
  expectRejected(
    '4g quotedPostId pointing at a REPLY is rejected',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'wrong field', quotedPostId: bs58.decode(replyId) }),
      tokenCost: TOKEN_COST.post,
    })
  );
}

async function case5Tombstones(ctx) {
  console.log('\n--- 5. tombstone-by-edit is the only delete for post and reply ---');

  const post = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'post',
    data: postData({ content: 'post to be tombstoned' }),
    tokenCost: TOKEN_COST.post,
  });
  if (expectAccepted('5a post created for the tombstone test', post).ok) {
    expectAccepted(
      '5b replace-to-clear with deleted:true is accepted on post',
      await attemptReplace(ctx.sdk, ctx.botA, {
        contractId: ctx.contractId,
        docType: 'post',
        id: post.id,
        revision: 1n,
        data: postData({ content: '', deleted: true }),
      })
    );
    expectRejected(
      '5c deleting a post is rejected (canBeDeleted: false)',
      await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'post', id: post.id }),
      { pattern: DELETE_FORBIDDEN }
    );
  }

  const rootPostId = await ensurePost(ctx);
  if (!rootPostId) {
    check('5  reply tombstone', false, 'no anchor post available');
    return;
  }
  const reply = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'reply',
    data: replyData({
      rootPostId: bs58.decode(rootPostId),
      parentOwnerId: bs58.decode(ctx.botA.ownerId),
      content: 'reply to be tombstoned',
    }),
    tokenCost: TOKEN_COST.reply,
  });
  if (!expectAccepted('5d reply created for the tombstone test', reply).ok) return;
  ctx.threadReplyIds.push(reply.id);

  expectAccepted(
    '5e replace-to-clear with deleted:true is accepted on reply',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'reply',
      id: reply.id,
      revision: 1n,
      data: replyData({
        rootPostId: bs58.decode(rootPostId),
        parentOwnerId: bs58.decode(ctx.botA.ownerId),
        content: '',
        deleted: true,
      }),
    })
  );
  expectRejected(
    '5f deleting a reply is rejected (canBeDeleted: false)',
    await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'reply', id: reply.id }),
    { pattern: DELETE_FORBIDDEN }
  );
}

/** Reads one countable index's total for a single key. */
async function countBy(sdk, contractId, docType, field, value) {
  const raw = await sdk.documents.count({
    dataContractId: contractId,
    documentTypeName: docType,
    where: [[field, '==', value]],
  });
  const total = raw instanceof Map ? raw.get('') : raw?.[''];
  // Zero-count branches are not materialized in the count trees, so an empty
  // response is a genuine 0 rather than a decoding failure.
  return total === undefined || total === null ? 0 : Number(total);
}

async function case6CountTrees(ctx) {
  console.log('\n--- 6. count trees round-trip ---');
  const postId = await ensurePost(ctx);
  const replyId = await ensureReply(ctx);
  if (!postId || !replyId) {
    check('6  count trees', false, 'no anchor post/reply available');
    return;
  }
  // Count trees settle behind the write quorum like any other read.
  await settle();

  const expectedThreadSize = new Set(ctx.threadReplyIds).size;
  const byRoot = await countBy(ctx.sdk, ctx.contractId, 'reply', 'rootPostId', postId);
  check(
    '6a byRoot counts the whole thread, not just direct children',
    byRoot === expectedThreadSize,
    `byRoot=${byRoot} expected=${expectedThreadSize}`
  );

  if (ctx.nestedUnder) {
    const byReplyToReply = await countBy(ctx.sdk, ctx.contractId, 'reply', 'replyToReplyId', ctx.nestedUnder);
    check(
      '6b byReplyToReply counts the replies nested under one reply',
      byReplyToReply === ctx.nestedCount,
      `byReplyToReply=${byReplyToReply} expected=${ctx.nestedCount}`
    );
  } else {
    check('6b byReplyToReply', false, 'case 1 produced no nested reply to count');
  }

  const byReply = await countBy(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId);
  check(
    '6c byReply counts likeReply documents for one reply',
    byReply === ctx.replyLikes,
    `byReply=${byReply} expected=${ctx.replyLikes}`
  );

  const quoteReplyCount = await countBy(ctx.sdk, ctx.contractId, 'post', 'quotedReplyId', replyId);
  check(
    '6d quoteReplyCount counts posts quoting one reply',
    quoteReplyCount === ctx.replyQuotes,
    `quoteReplyCount=${quoteReplyCount} expected=${ctx.replyQuotes}`
  );

  // The v2 tree must still work on the new index set.
  const quoteCount = await countBy(ctx.sdk, ctx.contractId, 'post', 'quotedPostId', postId);
  check('6e quoteCount still counts posts quoting one post', quoteCount > 0, `quoteCount=${quoteCount}`);
}

const CASES = new Map([
  [1, case1ReplyLinkage],
  [2, case2Likes],
  [3, case3PostsOnly],
  [4, case4DualQuotes],
  [5, case5Tombstones],
  // Last on purpose: it asserts totals the earlier cases produced.
  [6, case6CountTrees],
]);

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    contract: null,
    botIndex: 0,
    bot2Index: 1,
    ownerId: null,
    owner2Id: null,
    only: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--bot': args.botIndex = Number(argv[++i]); break;
      case '--bot2': args.bot2Index = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--owner2': args.owner2Id = argv[++i]; break;
      case '--only': args.only = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dryRun && !args.contract) {
    throw new Error('--contract <topologyContractId> is required (or pass --dry-run)');
  }
  for (const [flag, value] of [['--bot', args.botIndex], ['--bot2', args.bot2Index]]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} takes a non-negative integer index`);
  }
  if (args.botIndex === args.bot2Index) {
    throw new Error('--bot and --bot2 must be different identities');
  }
  if (args.only !== null) {
    args.only = args.only.split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n));
    if (args.only.length === 0) throw new Error('--only takes a comma-separated list of case numbers');
    const unknown = args.only.filter((n) => !CASES.has(n));
    if (unknown.length > 0) throw new Error(`--only: unknown case number(s) ${unknown.join(', ')}`);
  }
  return args;
}

function selectedCases(args) {
  return [...CASES.keys()].filter((n) => !args.only || args.only.includes(n));
}

/**
 * `--dry-run`: no network, no keys. Proves the arguments parse and that every
 * document shape the battery writes builds cleanly — so a live failure is
 * Platform's answer, not a bug in this script.
 */
function dryRun(args) {
  const contractId = args.contract ?? DRY_RUN_ID;
  const ownerId = args.ownerId ?? DRY_RUN_ID;
  const someId = randomIdBytes;

  /** `[label, docType, data]` — every shape the live battery writes. */
  const shapes = [
    ['post', 'post', postData()],
    ['post (quote of post)', 'post', postData({ quotedPostId: someId() })],
    ['post (quote of reply)', 'post', postData({ quotedReplyId: someId() })],
    ['post (both quotes)', 'post', postData({ quotedPostId: someId(), quotedReplyId: someId() })],
    ['post (tombstone)', 'post', postData({ content: '', deleted: true })],
    ['reply (flat)', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId() })],
    ['reply (nested)', 'reply', replyData({ rootPostId: someId(), replyToReplyId: someId(), parentOwnerId: someId() })],
    ['reply (tombstone)', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId(), content: '', deleted: true })],
    ['like', 'like', likeData({ postId: someId(), postOwnerId: someId() })],
    ['likeReply', 'likeReply', likeReplyData({ replyId: someId(), replyOwnerId: someId() })],
    ['repost', 'repost', repostData({ postId: someId(), postOwnerId: someId() })],
    ['bookmark', 'bookmark', bookmarkData({ postId: someId() })],
  ];
  for (const [label, docType, data] of shapes) {
    const { id } = buildDocument({ contractId, docType, ownerId, data, entropy: randomIdBytes() });
    console.log(`document shape ok: ${label.padEnd(22)} (${docType}) → ${id}`);
  }
  // Replaces reuse an existing id and carry no entropy.
  buildDocument({
    contractId,
    docType: 'post',
    ownerId,
    data: postData({ content: '', deleted: true }),
    revision: 2n,
    id: bs58.decode(DRY_RUN_ID),
  });
  console.log('document shape ok: post (replace, revision 2)');

  const { devnetName, addresses } = devnetSdk();
  console.log(`would run cases ${selectedCases(args).join(', ')} on devnet "${devnetName}" via ${addresses[0]} (+${addresses.length - 1} more)`);
  console.log('DRY RUN OK — no network calls were made');
}

// ---- Main -------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/verify-topology.mjs --contract <id> [--bot <n>] [--bot2 <n>]');
  console.error('       [--owner <id>] [--owner2 <id>] [--only 1,3] [--dry-run]');
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
  // Cache the contract so the trusted SDK can verify token-cost result proofs
  // ("unknown contract … in token verification" otherwise).
  await sdk.contracts.fetch(args.contract);
  const botA = await botSigner(sdk, args.botIndex, args.ownerId);
  const botB = await botSigner(sdk, args.bot2Index, args.owner2Id);
  console.log(`connected to devnet "${devnetName}" (${addresses.length} addresses)`);
  console.log(`v3-topology contract: ${args.contract}`);
  console.log(`A=${botA.label}  B=${botB.label}`);
  console.log('YAPP balances:');
  await requireYapp(sdk, args.contract, [botA, botB]);

  const ctx = {
    sdk,
    contractId: args.contract,
    botA,
    botB,
    postId: null,
    replyId: null,
    /** Every reply written into the anchor post's thread, for the byRoot total. */
    threadReplyIds: [],
    nestedUnder: null,
    nestedCount: 0,
    replyLikes: 0,
    replyQuotes: 0,
  };
  for (const number of selectedCases(args)) {
    await CASES.get(number)(ctx);
  }

  if (capturedErrors.length > 0) {
    console.log('\n--- captured rejection texts (verbatim) ---');
    for (const { label, message } of capturedErrors) {
      console.log(`\n[${label}]\n${message}`);
    }
  }

  console.log('');
  console.log(`anchor post: ${ctx.postId ?? 'none'}  anchor reply: ${ctx.replyId ?? 'none'}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
