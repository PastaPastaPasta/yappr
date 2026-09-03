/**
 * Registration-day battery for **contract v5**
 * (`contracts/yappr-social-contract-v5.json`, PLAN_DEV6_V5.md): the v4 surfaces
 * REBASED onto the dev.7 skipIfAbsent/at-form grammar, plus the new prefix
 * ranked/count and follow-ranking cases. Runs live against a freshly registered
 * contract on a dev.7+ devnet — there is NO default contract id (`--contract`
 * or `V5_CONTRACT_ID` is required; the id only exists after wipe-day
 * registration, see docs/DEPLOY_V5_RUNBOOK.md).
 *
 * Adapted from `verify-v4.mjs` (readback-decided outcomes, strict
 * wrong-reason-fails rejections, reconnect-through-quorum-rotation plumbing).
 * v4→v5 semantic deltas baked into the shared cases:
 *   - `hashtag` is OPTIONAL everywhere (61-char ceiling): untagged posts and
 *     likes OMIT the property; the `''` sentinel no longer validates at all.
 *   - propertyAgreement is absence-aware: both absent = agree; one side
 *     present = 40127. The old b2 sentinel directions became absence
 *     directions.
 *   - byHashtagPost is skipIfAbsent: an untagged like writes NO entry there;
 *     reads on it are sparse (tagged-only) projections and the query router
 *     only admits it when the query binds `hashtag`.
 *
 * A-cases — the interaction topology (unchanged from v4 except that untagged
 * posts now omit `hashtag`):
 *   a1  flat threads: ghost rootPostId rejected (40120), flat + nested replies
 *       accepted, ghost replyToReplyId rejected
 *   a2  dual quote fields: post + reply quotes accepted, re-quote accepted,
 *       ghost targets and a REPLY id in quotedPostId rejected
 *   a3  repost/bookmark are posts-only: REPLY ids rejected by consensus
 *   a4  permanence: delete rejected (canBeDeleted:false) on post and reply;
 *       tombstone-by-edit (blank content + deleted:true) accepted
 *   a5  identity refersTo: follow/postMention of a ghost identity → 40120
 *   a6  count trees: byRoot spans the whole thread; byReplyToReply,
 *       quoteCount, quoteReplyCount exact
 *
 * B-cases — the indexOnly like family under v5 semantics:
 *   b1  like create on a tagged post (hashtag + postAuthor agreement) accepted,
 *       readback via the byPost entry query
 *   b2  propertyAgreement violations → 40127: wrong hashtag, wrong postAuthor,
 *       and BOTH absence directions (untagged post + tagged like, tagged post
 *       + hashtag-ABSENT like)
 *   b3  ghost postId → 40120
 *   b4  duplicate like (same owner, same post) → 40105 structural uniqueness
 *   b5  byAuthorPost trap-regression guard: the same liker likes TWO different
 *       posts by the SAME author — both accepted; plus the both-absent
 *       positive direction (untagged post + hashtag-ABSENT like accepted)
 *   b6  batched membership: $ownerId == me AND postId IN [liked+unliked]
 *       ORDER BY postId → exactly the liked ones
 *   b7  terminal-level ranked top-K via documents.ranked: global (groupBy
 *       postId), per-hashtag pin (run-unique tag) — exact counts, zero-count
 *       preallocated groups filtered. (The v4 `''` sentinel pin died with the
 *       sentinel; untagged coverage moved to c1.)
 *   b8  unlike: the full value tuple (postId ← byLiker, $createdAt ←
 *       byAuthorTimePost projection, hashtag/postAuthor ← the post) recovered
 *       WITHOUT the create-returned Document; delete-by-values accepted; byPost
 *       count decrements; re-like accepted (uniqueness cleared)
 *   b9  deleting someone else's like (bot2's tuple, bot1's signature) rejected;
 *       the entry survives
 *   b10 likeReply mirror: replyAuthor agreement (40127), ghost reply (40120),
 *       duplicate (40105), byReply count, unlike via query recovery
 *   b11 tombstone interplay: like a post, author tombstones it — the like
 *       REMAINS and the byPost count is unchanged
 *   b12 tag listing: post.tagAndTime (hashtag ==, orderBy $createdAt) returns
 *       exactly the run's tagged posts
 *
 * C-cases — NEW in v5 (the dev.7 grammar; each requires the v5 contract and a
 * dev.7+ wasm-sdk — the ranked/count shapes below do not exist on v4):
 *   c1  untagged like lifecycle across the skip index: both-absent agreement
 *       accepted; the untagged like EXISTS in byPost/byLiker/byAuthorTimePost
 *       but contributes to NO hashtag group (hashtag-pinned reads and the
 *       hashtag ranking never see it); delete-by-values with the hashtag-less
 *       tuple accepted; re-like accepted
 *   c2  prefix ranked queries: global top hashtags (rankedCountable
 *       {at:"hashtag"}) with three-path agreement (ranked group value ==
 *       prefix-pinned count == pinned projection size), preallocated
 *       zero-count group for a tagged-but-never-liked post, drained-group
 *       behavior (like → unlike returns the group to 0 and it stays
 *       queryable); creator leaderboard (groupBy postAuthor on the multi-at
 *       byAuthorPost) cross-checked against the prefix-pinned author count;
 *       per-author top posts at the TERMINAL level of the SAME index
 *   c3  prefix-pinned counts (#4537): count WHERE hashtag == <run tag> exact;
 *       count WHERE postAuthor == B consistent across read paths
 *   c4  byAuthorTimePost window read: postAuthor pin + $createdAt >= run start
 *       returns BOTH tagged and untagged likes (the plain sibling index holds
 *       every like — it is the notification read and the #4543 coexistence
 *       proof)
 *   c5  follow rankings: O(1) follower count via the upgraded followerCount
 *       index; most-followed leaderboard (groupBy followingId) agrees with it
 *
 * Known platform behaviors this battery leans on:
 *   - js documents.create() may THROW post-broadcast for indexOnly types even
 *     when the write landed — acceptance is always decided by readback;
 *   - the 40105 duplicate probe fires BEFORE 40120/40127, so every agreement
 *     violation targets a post its signer has not yet liked;
 *   - ranked pages on preallocated indexes include zero-count groups;
 *   - DAPI 504 on the confirmation wait ≠ rejection (readback decides).
 *
 * ## Environment
 *
 *   V5_CONTRACT_ID        the freshly registered v5 contract id (or --contract)
 *   DEVNET_NAME           devnet name           (default: moutai)
 *   DAPI_ADDRESSES        comma-separated DAPI  (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *   QUORUM_URL            quorum service for the trusted context
 *   DEVNET_IDENTITY_IDS   comma-separated devnet identity ids for the bot pool
 *                         (falls back to E2E_IDENTITY_IDS / .env.devnet)
 *   E2E_SEED_PHRASE       the BIP39 seed the bot keys derive from
 *
 * Both bots need YAPP on the contract under test (post 10, reply 3, like 1,
 * likeReply 1, repost 1); case 0 aborts early with a clear message if not.
 *
 * ## Run
 *
 *   node scripts/verify-v5.mjs --dry-run
 *   NETWORK=devnet node scripts/verify-v5.mjs --contract <freshV5Id> \
 *        [--bot 0] [--bot2 1] [--owner <idA>] [--owner2 <idB>] [--only b1,c2]
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
// No default contract id ON PURPOSE: v5 only exists after the wipe-day
// registration (docs/DEPLOY_V5_RUNBOOK.md). Pass --contract or V5_CONTRACT_ID.
/** Reads settle behind the write quorum; give the chain a beat before asserting. */
const SETTLE_MS = 3000;
/** How many settle intervals to wait before calling a write absent (~9s). */
const POLL_ATTEMPTS = 3;
/** Placeholder ids for `--dry-run`, where nothing is fetched or signed. */
const DRY_RUN_ID = '11111111111111111111111111111111';
/** YAPP is at token position 0; the battery's writes cost 10/3/1 per document. */
const YAPP_TOKEN_POSITION = 0;
/** Below this the run cannot finish, so it aborts instead of failing cases. */
const MIN_YAPP_BALANCE = 150n;

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
    // trusted mode is mandatory: wasm-sdk panics on `proofs: false` and refuses
    // non-trusted proof verification; quorum keys are prefetched from
    // https://quorums.<devnetName>.networks.dash.org (or QUORUM_URL).
    trusted: true,
    ...(process.env.QUORUM_URL ? { quorumUrl: process.env.QUORUM_URL } : {}),
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- Resilient connection ---------------------------------------------------
//
// Long runs (~20 min) outlive devnet quorum rotations: the trusted context
// prefetches quorum keys at connect, a mid-run DKG makes newer proofs verify
// against a quorum it never learned ("invalid quorum: Quorum not found"), the
// failing proofs ban every DAPI address ("no available addresses …"), and the
// SDK instance is dead. There is no refresh API, so the cure is a FULL
// reconnect: build a fresh EvoSDK (fresh quorum prefetch + address pool),
// re-ratchet the protocol version, re-cache the contract, and swap it in. All
// battery code holds `sdkHandle` — a proxy that always forwards to the current
// instance — so a swap is transparent to in-flight helpers.

/** Errors that mean "this SDK instance is dead", not "this request was refused". */
const TRANSPORT_COLLAPSE = /no available addresses|invalid quorum|quorum not found/i;

let activeSdk = null;
let reconnectContractId = null;
let reconnectPromise = null;

const sdkHandle = new Proxy(
  {},
  {
    get(_, prop) {
      const value = activeSdk[prop];
      return typeof value === 'function' ? value.bind(activeSdk) : value;
    },
  }
);

/** Connect + protocol-version ratchet + contract cache: everything a fresh instance needs. */
async function buildConnectedSdk(contractId) {
  const { sdk, devnetName, addresses } = devnetSdk();
  await sdk.connect();
  // PROTOCOL-VERSION RATCHET (load-bearing): rs-sdk starts every devnet at
  // protocol version 12 and only ratchets upward from *verified* response
  // metadata (rs-sdk sdk.rs `min_protocol_version` + `maybe_update_protocol_version`).
  // Parsing the v5 contract needs the PV14+ ranked-index grammar, so any proved
  // query that touches it before the ratchet dies inside proof verification
  // with "dash drive: protocol: value wrong type error: unexpected property
  // name" — and the thrown verify never ratchets. One proved epoch query
  // teaches the SDK the chain's real version first.
  const epochInfo = await sdk.epoch.current();
  // Cache the contract so the trusted SDK can verify token-cost result proofs
  // ("unknown contract … in token verification" otherwise).
  await sdk.contracts.fetch(contractId);
  return { sdk, devnetName, addresses, protocolVersion: epochInfo?.toJSON?.()?.protocolVersion };
}

/** Replaces the dead instance behind `sdkHandle`; concurrent callers share one attempt. */
async function reconnectSdk(reason) {
  if (!reconnectPromise) {
    console.log(`     (transport collapsed — reconnecting: ${reason.slice(0, 120)})`);
    reconnectPromise = (async () => {
      const { sdk, protocolVersion } = await buildConnectedSdk(reconnectContractId);
      activeSdk = sdk;
      console.log(`     (reconnected, PV${protocolVersion})`);
    })().finally(() => {
      reconnectPromise = null;
    });
  }
  return reconnectPromise;
}

// ---- Reporting --------------------------------------------------------------

let failures = 0;
/** Every rejection text seen, printed verbatim at the end. */
const capturedErrors = [];
/** Query shapes that worked, echoed for the results doc. */
const workingShapes = [];

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
 * `Document.fromObject` with raw-byte ids is the only shape that survives
 * wasm-sdk 4.1+ (the `Document` constructor corrupts Uint8Array properties).
 */
function buildDocument({ contractId, docType, ownerId, data, entropy, revision = 1n, createdAt, id }) {
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

const READ_ATTEMPTS = 4;

/** Retries transient read faults; only a successful read is an answer. */
async function readback(fn) {
  let lastError;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (TRANSPORT_COLLAPSE.test(describeErr(e))) {
        // A failed reconnect (e.g. a second quorum rotation mid-rebuild) must
        // consume this attempt and back off, not abort the whole case.
        try {
          await reconnectSdk(describeErr(e));
          continue;
        } catch (reconnectError) {
          lastError = reconnectError;
        }
      }
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

/** Identifier values arrive as bytes or base58 depending on the surface. */
function asBase58(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return bs58.encode(Uint8Array.from(value));
}

/**
 * "Does <owner>'s entry for this target exist?" — the indexOnly acceptance
 * read. Equality on the entry index's leading property plus the terminal
 * lowers onto the entry level's member keys.
 */
async function entryExists(sdk, contractId, docType, keyField, keyValue, ownerId) {
  return readback(async () => {
    const result = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [
        [keyField, '==', keyValue],
        ['$ownerId', '==', ownerId],
      ],
    });
    return result.size > 0;
  });
}

/** Reads one countable index's total for a single key (0 when unmaterialized). */
async function countBy(sdk, contractId, docType, field, value) {
  return readback(async () => {
    const raw = await sdk.documents.count({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [[field, '==', value]],
    });
    const total = raw instanceof Map ? raw.get('') : raw?.[''];
    return total === undefined || total === null ? 0 : Number(total);
  });
}

const NOT_THROWN_BUT_ABSENT = 'the SDK reported no error, but the write is not on chain';

/**
 * Runs one write and decides its outcome by polling the chain until `accepted`
 * holds, or the attempts run out. The CHAIN — not the SDK's throw/no-throw —
 * decides: the DAPI gateway routinely 504s the wait for a transition that DID
 * land, and js documents.create() can throw post-broadcast for indexOnly types
 * even when the write landed. Readback covers both.
 */
async function attemptWrite({ accepted }, write) {
  let error = null;
  try {
    await write();
  } catch (e) {
    error = describeErr(e);
    // A dead SDK instance is not a consensus verdict: reconnect and retry the
    // broadcast once. The retry reuses the same document (same entropy → same
    // $id), so a first broadcast that DID land surfaces as a duplicate and the
    // readback below still scores it accepted.
    if (TRANSPORT_COLLAPSE.test(error)) {
      try {
        await reconnectSdk(error);
        await write();
        error = null;
      } catch (retryError) {
        // Keep whichever error the retry (or the reconnect itself) produced;
        // the readback polls below still decide the write's real fate.
        error = describeErr(retryError);
      }
    }
  }
  for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
    await settle();
    if (await accepted()) return { ok: true, error: null };
  }
  return { ok: false, error: error ?? NOT_THROWN_BUT_ABSENT };
}

/** The token-payment agreement a token-priced doctype's create must carry. */
function paymentInfo(tokenCost) {
  return tokenCost
    ? {
        tokenPaymentInfo: new TokenPaymentInfo({
          tokenContractPosition: YAPP_TOKEN_POSITION,
          maximumTokenCost: BigInt(tokenCost),
        }),
      }
    : {};
}

/** Creates a STORED document; acceptance = it reads back by id. */
async function attemptCreate(sdk, who, { contractId, docType, data, tokenCost }) {
  const { document, id } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    entropy: randomIdBytes(),
  });
  const outcome = await attemptWrite(
    { accepted: async () => (await fetchDocument(sdk, contractId, docType, id)) !== null },
    () =>
      sdk.documents.create({
        document,
        identityKey: who.identityKey,
        signer: who.signer,
        ...paymentInfo(tokenCost),
      })
  );
  return { ...outcome, id };
}

/**
 * Creates an INDEX-ONLY document. There is no primary tree, so the caller
 * supplies the acceptance probe (entry-exists for fresh likes, a count bound
 * for duplicate probes — an existing entry satisfies entry-exists and would
 * mask the refusal). The create-returned Document is deliberately discarded.
 */
async function attemptCreateIndexOnly(sdk, who, { contractId, docType, data, tokenCost, accepted }) {
  const { document } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    entropy: randomIdBytes(),
  });
  return attemptWrite({ accepted }, () =>
    sdk.documents.create({
      document,
      identityKey: who.identityKey,
      signer: who.signer,
      ...paymentInfo(tokenCost),
    })
  );
}

/** Replaces a stored document with a full data set at `revision + 1`. */
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
  return attemptWrite(
    {
      accepted: async () => {
        const d = await fetchDocument(sdk, contractId, docType, id);
        return d?.revision !== undefined && d.revision >= nextRevision;
      },
    },
    () => sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer })
  );
}

/** Deletes a stored document by reference; absence afterwards = success. */
async function attemptDelete(sdk, who, { contractId, docType, id }) {
  return attemptWrite(
    { accepted: async () => (await fetchDocument(sdk, contractId, docType, id)) === null },
    () =>
      sdk.documents.delete({
        document: { id, ownerId: who.ownerId, dataContractId: contractId, documentTypeName: docType },
        identityKey: who.identityKey,
        signer: who.signer,
      })
  );
}

/**
 * indexOnly delete-by-values: the Document instance carries the whole value
 * tuple (including `$createdAt`, which v5 keeps in `required` for the
 * notification index). `accepted` is supplied because "the entry is gone" is
 * the caller's predicate (and for the foreign-delete probe it never holds).
 */
async function attemptDeleteByValues(sdk, who, { document, accepted }) {
  return attemptWrite({ accepted }, () =>
    sdk.documents.delete({ document, identityKey: who.identityKey, signer: who.signer })
  );
}

function expectAccepted(label, outcome) {
  check(label, outcome.ok, outcome.ok ? (outcome.id ? `id=${outcome.id}` : '') : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
  return outcome;
}

// ---- Expected rejection shapes ---------------------------------------------

// The patterns run against describeErr()'s output, which concatenates the
// error's message AND its `code` field — so the numeric alternatives key on
// the SDK-attached consensus code (`code=40127` etc.), the most stable
// discriminator, while the text alternatives document the human-readable
// message observed live.

/** refersTo target missing (ReferencedEntityNotFoundError, 40120). */
const REFERENCE_NOT_FOUND = /40120|referenced .*not found/i;
/**
 * propertyAgreement violation (ReferencedDocumentPropertyMismatchError,
 * 40127). Live message: "the document's <p> does not agree with the referenced
 * document's <q> (propertyAgreement on <field>)".
 */
const PROPERTY_MISMATCH = /40127|does not agree with the referenced document/i;
/** Structural uniqueness / unique index (DuplicateUniqueIndexError family, 40105). */
const DUPLICATE_UNIQUE = /40105|duplicate unique properties/i;
/** The delete-immutability refusal ("documents of type X can not be deleted"). */
const DELETE_FORBIDDEN = /can ?not be deleted/i;
/**
 * A foreign delete (bot A signing a delete whose $ownerId is bot B): the state
 * transition's identity is B, but the signature comes from A's key, so it dies
 * in signature validation ("Invalid State Transition signature") before any
 * document logic. Kept adjacent-qualified so an unrelated message merely
 * containing the word "signature" can never score as enforcement.
 */
const FOREIGN_DELETE = /invalid.{0,40}signature|signature.{0,40}(invalid|mismatch)|identity.{0,40}not.{0,10}found|4020\d/i;

/**
 * Asserts Platform refused the write FOR THE EXPECTED REASON. A rejection whose
 * text matches no expected pattern FAILS the check: a broken key, an unfunded
 * identity, a transport fault, or a write that silently never landed must never
 * score as enforcement.
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
    matched
      ? reason.slice(0, 220)
      : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 180)}`
  );
  return outcome;
}

// ---- Document shapes --------------------------------------------------------
//
// One place per doctype, so `--dry-run` builds exactly what the live run
// writes. v5: post/reply creates REQUIRE `author` (== signer, poster-attested);
// `hashtag` is OPTIONAL on post and like — untagged means the property is
// ABSENT (the v4 `''` sentinel no longer validates: pattern ^[a-z0-9_]{1,61}$,
// minLength 1).

const TOKEN_COST = { post: 10, reply: 3, like: 1, likeReply: 1, repost: 1 };

const postData = ({ content = 'v5 battery post', author, hashtag, quotedPostId, quotedReplyId, deleted } = {}) => ({
  content,
  language: 'en',
  author,
  ...(hashtag === undefined ? {} : { hashtag }),
  ...(quotedPostId ? { quotedPostId } : {}),
  ...(quotedReplyId ? { quotedReplyId } : {}),
  ...(deleted === undefined ? {} : { deleted }),
});

const replyData = ({ content = 'v5 battery reply', rootPostId, replyToReplyId, parentOwnerId, author, deleted } = {}) => ({
  content,
  rootPostId,
  parentOwnerId,
  author,
  ...(replyToReplyId ? { replyToReplyId } : {}),
  ...(deleted === undefined ? {} : { deleted }),
});

const likeData = ({ postId, hashtag, postAuthor }) => ({
  postId,
  ...(hashtag === undefined ? {} : { hashtag }),
  postAuthor,
});
const likeReplyData = ({ replyId, replyAuthor }) => ({ replyId, replyAuthor });
const repostData = ({ postId, postOwnerId }) => ({ postId, postOwnerId });
const bookmarkData = ({ postId }) => ({ postId });
const followData = ({ followingId }) => ({ followingId });
const postMentionData = ({ postId, mentionedUserId }) => ({ postId, mentionedUserId });

// ---- Identities -------------------------------------------------------------

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
    throw new Error(`No identity id for bot index ${index}: pass --owner/--owner2 or set DEVNET_IDENTITY_IDS`);
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

/** Aborts before any case runs if a bot cannot pay for its writes. */
async function requireYapp(sdk, contractId, bots) {
  const tokenId = await sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION);
  console.log(`     YAPP token id: ${tokenId}`);
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
      `Fund them from the contract owner (maker, seed index 9).`
    );
  }
}

// ---- Shared fixtures --------------------------------------------------------

/** A real untagged post owned by bot A, created once and reused. */
async function ensureAnchorPost(ctx) {
  if (ctx.anchorPostId) return ctx.anchorPostId;
  const created = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'post',
    data: postData({ content: 'battery anchor post', author: bs58.decode(ctx.botA.ownerId) }),
    tokenCost: TOKEN_COST.post,
  });
  if (!created.ok) {
    console.log(`     (could not create the anchor post: ${(created.error ?? '').slice(0, 200)})`);
    return null;
  }
  ctx.anchorPostId = created.id;
  return created.id;
}

/** A real reply owned by bot A, rooted at the anchor post. */
async function ensureAnchorReply(ctx) {
  if (ctx.anchorReplyId) return ctx.anchorReplyId;
  const rootPostId = await ensureAnchorPost(ctx);
  if (!rootPostId) return null;
  const created = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'reply',
    data: replyData({
      rootPostId: bs58.decode(rootPostId),
      parentOwnerId: bs58.decode(ctx.botA.ownerId),
      author: bs58.decode(ctx.botA.ownerId),
      content: 'battery anchor reply',
    }),
    tokenCost: TOKEN_COST.reply,
  });
  if (!created.ok) {
    console.log(`     (could not create the anchor reply: ${(created.error ?? '').slice(0, 200)})`);
    return null;
  }
  ctx.anchorReplyId = created.id;
  ctx.threadReplyIds.push(created.id);
  return created.id;
}

/**
 * The B/C-case fixture set, all owned by bot B (so bot A's likes exercise the
 * postAuthor agreement against a DIFFERENT identity):
 *   postT1, postT2   tagged with the run-unique hashtag
 *   postU, postX     untagged (hashtag ABSENT); postX is never liked
 *                    (membership absence + the preallocated zero-count group)
 *   postTZ           tagged with the SECOND run-unique hashtag (tagZ), liked
 *                    only inside c2's drain sub-case — before that its tag is
 *                    the preallocated zero-count HASHTAG group
 */
async function ensureLikeFixtures(ctx) {
  if (ctx.postT1) return true;
  const b = bs58.decode(ctx.botB.ownerId);
  const specs = [
    ['postT1', ctx.tag, `tagged post one #${ctx.tag}`],
    ['postT2', ctx.tag, `tagged post two #${ctx.tag}`],
    ['postU', undefined, 'untagged post (liked)'],
    ['postX', undefined, 'untagged post (never liked)'],
    ['postTZ', ctx.tagZ, `tagged post zero-likes #${ctx.tagZ}`],
  ];
  for (const [key, hashtag, content] of specs) {
    const created = await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content, author: b, hashtag }),
      tokenCost: TOKEN_COST.post,
    });
    if (!created.ok) {
      console.log(`     (could not create ${key}: ${(created.error ?? '').slice(0, 200)})`);
      return false;
    }
    ctx[key] = created.id;
  }
  return true;
}

/** Bot A's accepted like on a target post (used by later cases when --only skips b1). */
async function ensureLike(ctx, postKey, hashtag) {
  if (ctx.likes[postKey]) return true;
  if (!(await ensureLikeFixtures(ctx))) return false;
  const outcome = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({
      postId: bs58.decode(ctx[postKey]),
      hashtag,
      postAuthor: bs58.decode(ctx.botB.ownerId),
    }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx[postKey], ctx.botA.ownerId),
  });
  if (outcome.ok) ctx.likes[postKey] = true;
  return outcome.ok;
}

/**
 * v6: bot A's `beat` beside its like of a TAGGED fixture post. `beat.hashtag`
 * is required and its postId refersTo the post with propertyAgreement on
 * hashtag, so a mismatching tag is a consensus rejection (d2 asserts it).
 */
async function ensureBeat(ctx, postKey, hashtag) {
  if (ctx.beats[postKey]) return true;
  if (!(await ensureLike(ctx, postKey, hashtag))) return false;
  const outcome = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'beat',
    data: { postId: bs58.decode(ctx[postKey]), hashtag },
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'beat', 'postId', ctx[postKey], ctx.botA.ownerId),
  });
  if (outcome.ok) ctx.beats[postKey] = true;
  else console.log(`     (could not create beat for ${postKey}: ${(outcome.error ?? '').slice(0, 220)})`);
  return outcome.ok;
}

// ---- A-cases: the interaction topology, unchanged in v5 ---------------------

async function caseA1ReplyLinkage(ctx) {
  console.log('\n--- a1. flat threads: rootPostId required, replyToReplyId optional ---');
  const rootPostId = await ensureAnchorPost(ctx);
  if (!rootPostId) {
    check('a1 reply linkage', false, 'no anchor post available');
    return;
  }
  const a = bs58.decode(ctx.botA.ownerId);
  const b = bs58.decode(ctx.botB.ownerId);

  expectRejected(
    'a1a reply whose rootPostId does not exist is rejected (40120)',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({ rootPostId: randomIdBytes(), parentOwnerId: a, author: a }),
      tokenCost: TOKEN_COST.reply,
    }),
    REFERENCE_NOT_FOUND
  );

  const flat = expectAccepted(
    'a1b flat reply to a real post (replyToReplyId absent) is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({ rootPostId: bs58.decode(rootPostId), parentOwnerId: a, author: b, content: 'flat reply' }),
      tokenCost: TOKEN_COST.reply,
    })
  );
  if (flat.ok) ctx.threadReplyIds.push(flat.id);

  const anchorReply = await ensureAnchorReply(ctx);
  if (!anchorReply) {
    check('a1 reply-to-reply linkage', false, 'no anchor reply available');
    return;
  }

  const nested = expectAccepted(
    'a1c reply-to-reply with a real replyToReplyId is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({
        rootPostId: bs58.decode(rootPostId),
        replyToReplyId: bs58.decode(anchorReply),
        parentOwnerId: a,
        author: b,
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
    'a1d reply whose replyToReplyId does not exist is rejected (40120)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({ rootPostId: bs58.decode(rootPostId), replyToReplyId: randomIdBytes(), parentOwnerId: a, author: b }),
      tokenCost: TOKEN_COST.reply,
    }),
    REFERENCE_NOT_FOUND
  );
}

async function caseA2Quotes(ctx) {
  console.log('\n--- a2. dual quote fields, uniqueness deliberately dropped ---');
  const postId = await ensureAnchorPost(ctx);
  const replyId = await ensureAnchorReply(ctx);
  if (!postId || !replyId) {
    check('a2 dual quotes', false, 'no anchor post/reply available');
    return;
  }
  const b = bs58.decode(ctx.botB.ownerId);

  const q1 = expectAccepted(
    'a2a quote-of-post (quotedPostId only) is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'quoting a post', author: b, quotedPostId: bs58.decode(postId) }),
      tokenCost: TOKEN_COST.post,
    })
  );
  if (q1.ok) ctx.postQuotes += 1;

  const q2 = expectAccepted(
    'a2b quote-of-reply (quotedReplyId only) is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'quoting a reply', author: b, quotedReplyId: bs58.decode(replyId) }),
      tokenCost: TOKEN_COST.post,
    })
  );
  if (q2.ok) ctx.replyQuotes += 1;

  const q3 = expectAccepted(
    'a2c the SAME owner quoting the SAME post twice is accepted (uniqueness dropped)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'quoting the same post again', author: b, quotedPostId: bs58.decode(postId) }),
      tokenCost: TOKEN_COST.post,
    })
  );
  if (q3.ok) ctx.postQuotes += 1;

  const q4 = expectAccepted(
    'a2d both quote fields set at once is tolerated by the chain',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({
        content: 'quoting both',
        author: b,
        quotedPostId: bs58.decode(postId),
        quotedReplyId: bs58.decode(replyId),
      }),
      tokenCost: TOKEN_COST.post,
    })
  );
  if (q4.ok) {
    ctx.postQuotes += 1;
    ctx.replyQuotes += 1;
  }

  expectRejected(
    'a2e quotedPostId pointing at a nonexistent post is rejected (40120)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'dangling post quote', author: b, quotedPostId: randomIdBytes() }),
      tokenCost: TOKEN_COST.post,
    }),
    REFERENCE_NOT_FOUND
  );

  expectRejected(
    'a2f quotedReplyId pointing at a nonexistent reply is rejected (40120)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'dangling reply quote', author: b, quotedReplyId: randomIdBytes() }),
      tokenCost: TOKEN_COST.post,
    }),
    REFERENCE_NOT_FOUND
  );

  expectRejected(
    'a2g quotedPostId pointing at a REPLY is rejected (resolves only against post)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'wrong field', author: b, quotedPostId: bs58.decode(replyId) }),
      tokenCost: TOKEN_COST.post,
    }),
    REFERENCE_NOT_FOUND
  );
}

async function caseA3PostsOnly(ctx) {
  console.log('\n--- a3. repost / bookmark accept posts and REFUSE replies ---');
  const postId = await ensureAnchorPost(ctx);
  const replyId = await ensureAnchorReply(ctx);
  if (!postId || !replyId) {
    check('a3 posts-only repost/bookmark', false, 'no anchor post/reply available');
    return;
  }
  const a = bs58.decode(ctx.botA.ownerId);

  expectRejected(
    'a3a repost of a REPLY id is rejected by consensus (40120)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'repost',
      data: repostData({ postId: bs58.decode(replyId), postOwnerId: a }),
      tokenCost: TOKEN_COST.repost,
    }),
    REFERENCE_NOT_FOUND
  );

  expectRejected(
    'a3b bookmark of a REPLY id is rejected by consensus (40120)',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'bookmark',
      data: bookmarkData({ postId: bs58.decode(replyId) }),
    }),
    REFERENCE_NOT_FOUND
  );

  expectAccepted(
    'a3c repost of a real post is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'repost',
      data: repostData({ postId: bs58.decode(postId), postOwnerId: a }),
      tokenCost: TOKEN_COST.repost,
    })
  );

  expectAccepted(
    'a3d bookmark of a real post is accepted',
    await attemptCreate(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'bookmark',
      data: bookmarkData({ postId: bs58.decode(postId) }),
    })
  );
}

async function caseA4Permanence(ctx) {
  console.log('\n--- a4. tombstone-by-edit is the only delete for post and reply ---');
  const a = bs58.decode(ctx.botA.ownerId);

  const post = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'post',
    data: postData({ content: 'post to be tombstoned', author: a }),
    tokenCost: TOKEN_COST.post,
  });
  if (expectAccepted('a4a post created for the tombstone test', post).ok) {
    expectAccepted(
      'a4b replace-to-clear with deleted:true is accepted on post',
      await attemptReplace(ctx.sdk, ctx.botA, {
        contractId: ctx.contractId,
        docType: 'post',
        id: post.id,
        revision: 1n,
        data: postData({ content: '', author: a, deleted: true }),
      })
    );
    expectRejected(
      'a4c deleting a post is rejected (canBeDeleted: false)',
      await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'post', id: post.id }),
      DELETE_FORBIDDEN
    );
  }

  const rootPostId = await ensureAnchorPost(ctx);
  if (!rootPostId) {
    check('a4 reply tombstone', false, 'no anchor post available');
    return;
  }
  const reply = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'reply',
    data: replyData({
      rootPostId: bs58.decode(rootPostId),
      parentOwnerId: a,
      author: a,
      content: 'reply to be tombstoned',
    }),
    tokenCost: TOKEN_COST.reply,
  });
  if (!expectAccepted('a4d reply created for the tombstone test', reply).ok) return;
  ctx.threadReplyIds.push(reply.id);

  expectAccepted(
    'a4e replace-to-clear with deleted:true is accepted on reply',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'reply',
      id: reply.id,
      revision: 1n,
      data: replyData({
        rootPostId: bs58.decode(rootPostId),
        parentOwnerId: a,
        author: a,
        content: '',
        deleted: true,
      }),
    })
  );
  expectRejected(
    'a4f deleting a reply is rejected (canBeDeleted: false)',
    await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'reply', id: reply.id }),
    DELETE_FORBIDDEN
  );
}

async function caseA5IdentityRefs(ctx) {
  console.log('\n--- a5. identity refersTo on follow and postMention ---');
  const postId = await ensureAnchorPost(ctx);
  const b = bs58.decode(ctx.botB.ownerId);

  expectRejected(
    'a5a follow of a GHOST identity is rejected (40120)',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'follow',
      data: followData({ followingId: randomIdBytes() }),
    }),
    REFERENCE_NOT_FOUND
  );

  // The unique (ownerAndFollowing) index outlives the run — sweep a leftover
  // follow from a previous execution so this stays re-runnable.
  const existing = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'follow',
      where: [
        ['$ownerId', '==', ctx.botA.ownerId],
        ['followingId', '==', ctx.botB.ownerId],
      ],
    })
  );
  for (const doc of existing.values()) {
    const staleId = asBase58(doc.toObject()?.$id) ?? doc.id;
    console.log(`     (sweeping leftover follow ${staleId})`);
    await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'follow', id: String(staleId) });
  }

  const follow = expectAccepted(
    'a5b follow of a REAL identity is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'follow',
      data: followData({ followingId: b }),
    })
  );
  if (follow.ok) {
    // Cleanup keeps the next run's a5b green (unique ownerAndFollowing).
    await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'follow', id: follow.id });
  }

  if (!postId) {
    check('a5 postMention', false, 'no anchor post available');
    return;
  }

  expectRejected(
    'a5c postMention of a GHOST identity is rejected (40120)',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'postMention',
      data: postMentionData({ postId: bs58.decode(postId), mentionedUserId: randomIdBytes() }),
    }),
    REFERENCE_NOT_FOUND
  );

  expectAccepted(
    'a5d postMention of a REAL identity is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'postMention',
      data: postMentionData({ postId: bs58.decode(postId), mentionedUserId: b }),
    })
  );
}

async function caseA6CountTrees(ctx) {
  console.log('\n--- a6. count trees round-trip ---');
  const postId = await ensureAnchorPost(ctx);
  const replyId = await ensureAnchorReply(ctx);
  if (!postId || !replyId) {
    check('a6 count trees', false, 'no anchor post/reply available');
    return;
  }
  await settle();

  const expectedThreadSize = new Set(ctx.threadReplyIds).size;
  const byRoot = await countBy(ctx.sdk, ctx.contractId, 'reply', 'rootPostId', postId);
  check(
    'a6a byRoot counts the whole thread, not just direct children',
    byRoot === expectedThreadSize,
    `byRoot=${byRoot} expected=${expectedThreadSize}`
  );

  if (ctx.nestedUnder) {
    const byReplyToReply = await countBy(ctx.sdk, ctx.contractId, 'reply', 'replyToReplyId', ctx.nestedUnder);
    check(
      'a6b byReplyToReply counts the replies nested under one reply',
      byReplyToReply === ctx.nestedCount,
      `byReplyToReply=${byReplyToReply} expected=${ctx.nestedCount}`
    );
  } else {
    check('a6b byReplyToReply', false, 'a1 produced no nested reply to count');
  }

  const quoteCount = await countBy(ctx.sdk, ctx.contractId, 'post', 'quotedPostId', postId);
  check(
    'a6c quoteCount counts posts quoting one post',
    quoteCount === ctx.postQuotes,
    `quoteCount=${quoteCount} expected=${ctx.postQuotes}`
  );

  const quoteReplyCount = await countBy(ctx.sdk, ctx.contractId, 'post', 'quotedReplyId', replyId);
  check(
    'a6d quoteReplyCount counts posts quoting one reply',
    quoteReplyCount === ctx.replyQuotes,
    `quoteReplyCount=${quoteReplyCount} expected=${ctx.replyQuotes}`
  );
}

// ---- B-cases: the indexOnly like family -------------------------------------

async function caseB1LikeCreate(ctx) {
  console.log('\n--- b1. like create on a tagged post + byPost readback ---');
  if (!(await ensureLikeFixtures(ctx))) {
    check('b1 like create', false, 'fixture posts unavailable');
    return;
  }
  const outcome = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({
      postId: bs58.decode(ctx.postT1),
      hashtag: ctx.tag,
      postAuthor: bs58.decode(ctx.botB.ownerId),
    }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1, ctx.botA.ownerId),
  });
  expectAccepted('b1a like with matching hashtag + postAuthor is accepted (readback: byPost entry)', outcome);
  if (outcome.ok) ctx.likes.postT1 = true;

  const count = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1);
  check('b1b byPost countable sees the like', count === 1, `count=${count} expected=1`);
}

async function caseB2AgreementViolations(ctx) {
  console.log('\n--- b2. propertyAgreement violations → 40127 (on not-yet-liked posts) ---');
  if (!(await ensureLikeFixtures(ctx))) {
    check('b2 agreement violations', false, 'fixture posts unavailable');
    return;
  }
  const b = bs58.decode(ctx.botB.ownerId);
  // Every probe targets a post bot A has NOT liked: the structural-uniqueness
  // check (40105) fires before 40120/40127 and would mask the agreement error.

  expectRejected(
    "b2a like with the WRONG hashtag on a tagged post is rejected (40127)",
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'like',
      data: likeData({ postId: bs58.decode(ctx.postT2), hashtag: 'wrong_tag', postAuthor: b }),
      tokenCost: TOKEN_COST.like,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT2, ctx.botA.ownerId),
    }),
    PROPERTY_MISMATCH
  );

  expectRejected(
    'b2b like with the WRONG postAuthor is rejected (40127)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'like',
      data: likeData({ postId: bs58.decode(ctx.postT2), hashtag: ctx.tag, postAuthor: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.like,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT2, ctx.botA.ownerId),
    }),
    PROPERTY_MISMATCH
  );

  // Absence-aware propertyAgreement (dev.7 #4524): one side present, the
  // other absent = disagreement. Both directions must be 40127.
  expectRejected(
    'b2c UNTAGGED post (hashtag absent) + tagged like is rejected (40127)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'like',
      data: likeData({ postId: bs58.decode(ctx.postU), hashtag: ctx.tag, postAuthor: b }),
      tokenCost: TOKEN_COST.like,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postU, ctx.botA.ownerId),
    }),
    PROPERTY_MISMATCH
  );

  expectRejected(
    'b2d tagged post + like with hashtag ABSENT is rejected (40127)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'like',
      data: likeData({ postId: bs58.decode(ctx.postT2), postAuthor: b }),
      tokenCost: TOKEN_COST.like,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT2, ctx.botA.ownerId),
    }),
    PROPERTY_MISMATCH
  );
}

async function caseB3GhostPost(ctx) {
  console.log('\n--- b3. like of a nonexistent post → 40120 ---');
  const ghost = randomIdBytes();
  const ghostB58 = bs58.encode(ghost);
  expectRejected(
    'b3a like whose postId does not exist is rejected (40120)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'like',
      data: likeData({ postId: ghost, postAuthor: bs58.decode(ctx.botB.ownerId) }),
      tokenCost: TOKEN_COST.like,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ghostB58, ctx.botA.ownerId),
    }),
    REFERENCE_NOT_FOUND
  );
}

async function caseB4Duplicate(ctx) {
  console.log('\n--- b4. duplicate like → 40105 structural uniqueness ---');
  if (!(await ensureLike(ctx, 'postT1', ctx.tag))) {
    check('b4 duplicate like', false, 'no accepted like on postT1 to duplicate');
    return;
  }
  // Entry existence cannot judge a duplicate (the first like's entry already
  // satisfies it) — acceptance is "the byPost count reached 2", which a
  // refused duplicate can never produce.
  expectRejected(
    'b4a liking the same post twice is rejected (structural uniqueness, 40105)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'like',
      data: likeData({
        postId: bs58.decode(ctx.postT1),
        hashtag: ctx.tag,
        postAuthor: bs58.decode(ctx.botB.ownerId),
      }),
      tokenCost: TOKEN_COST.like,
      accepted: async () => (await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1)) >= 2,
    }),
    DUPLICATE_UNIQUE
  );
}

async function caseB5TrapGuard(ctx) {
  console.log('\n--- b5. byAuthorPost trap-regression guard + the \'\' positive direction ---');
  if (!(await ensureLike(ctx, 'postT1', ctx.tag))) {
    check('b5 trap guard', false, 'no accepted like on postT1');
    return;
  }
  // THE GUARD: bot A already likes postT1 (author B). A [postAuthor]-only
  // index (the Phase 1 likeB trap) would project both likes onto the same
  // (postAuthor, $ownerId) tuple and refuse this second one with 40105.
  const second = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({
      postId: bs58.decode(ctx.postT2),
      hashtag: ctx.tag,
      postAuthor: bs58.decode(ctx.botB.ownerId),
    }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT2, ctx.botA.ownerId),
  });
  expectAccepted(
    'b5a the same liker liking a SECOND post by the SAME author is accepted (no [postAuthor]-only index)',
    second
  );
  if (second.ok) ctx.likes.postT2 = true;

  const untagged = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({
      postId: bs58.decode(ctx.postU),
      postAuthor: bs58.decode(ctx.botB.ownerId),
    }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postU, ctx.botA.ownerId),
  });
  expectAccepted('b5b untagged post + hashtag-ABSENT like (both-absent agreement) is accepted', untagged);
  if (untagged.ok) ctx.likes.postU = true;
}

async function caseB6BatchedMembership(ctx) {
  console.log('\n--- b6. batched membership: $ownerId == me AND postId IN [...] ---');
  const ready =
    (await ensureLike(ctx, 'postT1', ctx.tag)) &&
    (await ensureLike(ctx, 'postT2', ctx.tag)) &&
    (await ensureLike(ctx, 'postU', undefined));
  if (!ready) {
    check('b6 batched membership', false, 'like fixtures unavailable');
    return;
  }
  const batch = [ctx.postT1, ctx.postT2, ctx.postU, ctx.postX];
  const shape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    where: [
      ['$ownerId', '==', ctx.botA.ownerId],
      ['postId', 'in', batch],
    ],
    orderBy: [['postId', 'asc']],
  };
  const result = await readback(() => ctx.sdk.documents.query(shape));
  const returned = [...result.values()]
    .map((doc) => asBase58(doc.toObject()?.postId))
    .filter(Boolean)
    .sort();
  const expected = [ctx.postT1, ctx.postT2, ctx.postU].sort();
  check(
    'b6a membership returns EXACTLY the 3 liked posts of the 4 asked (absence of postX proved)',
    returned.length === 3 && returned.every((id, i) => id === expected[i]),
    `got ${returned.length}: ${returned.join(', ')}`
  );
  workingShapes.push({ label: 'batched liked-state membership (byLiker terminal-in)', shape: { ...shape, dataContractId: '<contractId>' } });
}

async function caseB7Ranked(ctx) {
  console.log('\n--- b7. ranked top-K via documents.ranked ---');
  const ready =
    (await ensureLike(ctx, 'postT1', ctx.tag)) &&
    (await ensureLike(ctx, 'postT2', ctx.tag)) &&
    (await ensureLike(ctx, 'postU', undefined));
  if (!ready) {
    check('b7 ranked', false, 'like fixtures unavailable');
    return;
  }
  await settle();

  // The contract is long-lived (re-runs accumulate groups), so global/'' /
  // author pages assert OUR groups' presence and exact counts rather than the
  // page's total size. Zero-count groups (preallocation) are filtered the way
  // a client must.
  const globalShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    groupBy: 'postId',
    aggregate: { type: 'count' },
    limit: 100,
  };
  const global = await readback(() => ctx.sdk.documents.ranked(globalShape));
  const valueOf = (page, id) => page.entries.find((entry) => entry.groupValue === id)?.value;
  const nonZero = (page) => page.entries.filter((entry) => entry.value > 0n).map((entry) => entry.groupValue);
  /**
   * The battery re-runs against a long-lived shared contract, so a bounded
   * top-K page eventually fills with older groups and this run's count-1
   * groups may legitimately fall off it. Page presence is therefore asserted
   * only while the page has room (not full ⇒ our group MUST be there with the
   * exact count); the exact per-post value is always proved separately via the
   * countable index (`countBy`), which is accumulation-immune.
   */
  const onPageOk = (page, id, expected, limit) => {
    const value = valueOf(page, id);
    if (value !== undefined) return value === expected;
    return page.entries.length >= limit; // absent is only legal off a full page
  };
  const provedCounts = {};
  for (const key of ['postT1', 'postT2', 'postU', 'postX']) {
    provedCounts[key] = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx[key]);
  }
  check(
    'b7a global ranked (byPost): the 3 liked posts rank at count 1 (proved counts agree)',
    provedCounts.postT1 === 1 && provedCounts.postT2 === 1 && provedCounts.postU === 1 &&
      onPageOk(global, ctx.postT1, 1n, 100) && onPageOk(global, ctx.postT2, 1n, 100) && onPageOk(global, ctx.postU, 1n, 100),
    `proved T1=${provedCounts.postT1} T2=${provedCounts.postT2} U=${provedCounts.postU} page=[T1=${valueOf(global, ctx.postT1)} T2=${valueOf(global, ctx.postT2)} U=${valueOf(global, ctx.postU)}] entries=${global.entries.length}`
  );
  check(
    'b7b the never-liked postX is a ZERO-COUNT group (proved count 0) and never survives the zero-filter',
    provedCounts.postX === 0 && !nonZero(global).includes(ctx.postX),
    `provedX=${provedCounts.postX} pageX=${valueOf(global, ctx.postX) ?? 'not on page'}`
  );
  workingShapes.push({ label: 'global top-K posts by like count (byPost ranked)', shape: { ...globalShape, dataContractId: '<contractId>' } });

  // LIVE CALIBRATION (2026-08-31 wipe day): the single-level `{at: "hashtag"}`
  // form served ONLY the hashtag-level ranking — the router refused the
  // per-tag pin+group shape ("no ranked index covers `group_by = [postId]`
  // with pins on [hashtag] on the Count axis"), which would have silently
  // killed the tag page's Top toggle. The contract was re-cut the same hour to
  // the multi-at form `{at: ["hashtag", "postId"]}` (terminal name folds to
  // the boolean form), so BOTH levels are served: trending at the hashtag
  // level, per-tag Top at the terminal. This case asserts the per-tag shape
  // works again.
  const tagShape = { ...globalShape, where: [['hashtag', '==', ctx.tag]], limit: 10 };
  const perTag = await readback(() => ctx.sdk.documents.ranked(tagShape));
  const perTagIds = (perTag.entries ?? perTag ?? []).map((entry) => entry.groupValue ?? entry.key);
  check(
    'b7c per-tag pin+group ranked serves under the multi-at form (tag page Top toggle)',
    perTagIds.length > 0,
    `entries=${perTagIds.length}`
  );
  workingShapes.push({ label: 'per-tag top posts (byHashtagPost multi-at, tag pinned)', shape: { ...tagShape, dataContractId: '<contractId>' } });
  const trendShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    groupBy: 'hashtag',
    aggregate: { type: 'count' },
    limit: 100,
  };
  const trending = await readback(() => ctx.sdk.documents.ranked(trendShape));
  const tagTrendValue = trending.entries.find((entry) => entry.groupValue === ctx.tag)?.value;
  check(
    'b7c trending ranking (groupBy hashtag) carries the run tag at exactly its 2 tagged likes',
    tagTrendValue === 2n || (tagTrendValue === undefined && trending.entries.length >= 100),
    `tagValue=${tagTrendValue ?? 'not on page'} entries=${trending.entries.length}`
  );
  workingShapes.push({ label: 'trending hashtags (byHashtagPost {at:"hashtag"} ranked)', shape: { ...trendShape, dataContractId: '<contractId>' } });

  // v4's b7d ('' sentinel pin) died with the sentinel: there is no untagged
  // group in a skipIfAbsent index. Untagged coverage lives in c1.

  // Terminal-level ranking of the MERGED multi-at byAuthorPost index — the
  // profile Top tab read. c2 exercises the same index's prefix (leaderboard)
  // level; both levels serving from ONE index is the D-V5-1 resolution.
  const authorShape = { ...globalShape, where: [['postAuthor', '==', ctx.botB.ownerId]] };
  const author = await readback(() => ctx.sdk.documents.ranked(authorShape));
  check(
    "b7d author-pinned ranked (byAuthorPost terminal level): B's 3 liked posts rank at count 1",
    onPageOk(author, ctx.postT1, 1n, 100) && onPageOk(author, ctx.postT2, 1n, 100) && onPageOk(author, ctx.postU, 1n, 100),
    `page=[T1=${valueOf(author, ctx.postT1)} T2=${valueOf(author, ctx.postT2)} U=${valueOf(author, ctx.postU)}] entries=${author.entries.length}`
  );
  workingShapes.push({ label: "author-pinned top-K (byAuthorPost, '==' pin)", shape: { ...authorShape, where: [['postAuthor', '==', '<authorId>']], dataContractId: '<contractId>' } });
}

/**
 * Recovers the `$createdAt` of <owner>'s like on <postId> from the
 * byAuthorTimePost projection alone (postAuthor pin, time-ordered page,
 * client-side match on postId + $ownerId).
 */
async function recoverLikeCreatedAt(ctx, docType, authorField, authorId, idField, targetId, ownerId) {
  const page = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: docType,
      where: [[authorField, '==', authorId]],
      orderBy: [['$createdAt', 'desc']],
      limit: 100,
    })
  );
  for (const doc of page.values()) {
    const obj = doc.toObject();
    if (asBase58(obj?.[idField]) === targetId && asBase58(obj?.$ownerId) === ownerId) {
      return { createdAt: obj?.$createdAt, projection: obj };
    }
  }
  return { createdAt: undefined, projection: null };
}

async function caseB8Unlike(ctx) {
  console.log('\n--- b8. unlike: full tuple recovery from queries, delete-by-values, re-like ---');
  if (!(await ensureLike(ctx, 'postT1', ctx.tag))) {
    check('b8 unlike', false, 'no accepted like on postT1');
    return;
  }
  // NOTHING from the create call is used here — the create-returned Document
  // is unreliable for indexOnly types (may be absent entirely after a 504 or
  // the known post-broadcast throw). Every tuple value comes from queries.

  // (1) postId ← byLiker (my likes).
  const byLikerShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    where: [['$ownerId', '==', ctx.botA.ownerId]],
    orderBy: [['postId', 'asc']],
    limit: 100,
  };
  const myLikes = await readback(() => ctx.sdk.documents.query(byLikerShape));
  const likedIds = [...myLikes.values()].map((doc) => asBase58(doc.toObject()?.postId)).filter(Boolean);
  check('b8a byLiker recovers the liked postId', likedIds.includes(ctx.postT1), `got ${likedIds.length} likes`);
  workingShapes.push({ label: 'my likes (byLiker)', shape: { ...byLikerShape, dataContractId: '<contractId>' } });

  // (2) $createdAt ← the byAuthorTimePost projection.
  const { createdAt, projection } = await recoverLikeCreatedAt(
    ctx, 'like', 'postAuthor', ctx.botB.ownerId, 'postId', ctx.postT1, ctx.botA.ownerId
  );
  check(
    'b8b byAuthorTimePost projection carries $createdAt (+ postId + $ownerId) for the notification/recovery read',
    createdAt !== undefined && createdAt !== null,
    `projection=${JSON.stringify(projection, (k, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 200)}`
  );

  // (3) hashtag + postAuthor ← the referenced post itself.
  const post = await fetchDocument(ctx.sdk, ctx.contractId, 'post', ctx.postT1);
  const postObj = post?.toObject();
  const recoveredHashtag = postObj?.hashtag;
  const recoveredAuthorB58 = asBase58(postObj?.author);
  check(
    'b8c the referenced post supplies hashtag + postAuthor',
    recoveredHashtag === ctx.tag && recoveredAuthorB58 === ctx.botB.ownerId,
    `hashtag=${recoveredHashtag} author=${recoveredAuthorB58}`
  );

  if (createdAt === undefined || createdAt === null || !recoveredAuthorB58) {
    check('b8d unlike with the recovered tuple', false, 'recovery incomplete — cannot attempt the delete');
    return;
  }

  const countBefore = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1);
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.botA.ownerId,
    data: {
      postId: bs58.decode(ctx.postT1),
      // Mirrors the post's absence: a tagged post yields a tagged tuple; an
      // untagged one would omit the property (that direction is c1's case).
      ...(recoveredHashtag === undefined ? {} : { hashtag: recoveredHashtag }),
      postAuthor: bs58.decode(recoveredAuthorB58),
    },
    entropy: randomIdBytes(),
    createdAt: BigInt(createdAt),
  });
  const deleted = await attemptDeleteByValues(ctx.sdk, ctx.botA, {
    document,
    accepted: async () => !(await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1, ctx.botA.ownerId)),
  });
  expectAccepted('b8d unlike with the query-recovered value tuple is accepted', deleted);
  if (!deleted.ok) return;
  ctx.likes.postT1 = false;

  const countAfter = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1);
  check(
    'b8e byPost count decrements after the unlike',
    countBefore >= 1 && countAfter === countBefore - 1,
    `before=${countBefore} after=${countAfter}`
  );

  const relike = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({
      postId: bs58.decode(ctx.postT1),
      hashtag: ctx.tag,
      postAuthor: bs58.decode(ctx.botB.ownerId),
    }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1, ctx.botA.ownerId),
  });
  expectAccepted('b8f re-like after the unlike is accepted (structural uniqueness cleared)', relike);
  if (relike.ok) ctx.likes.postT1 = true;
}

async function caseB9ForeignDelete(ctx) {
  console.log("\n--- b9. deleting someone ELSE'S like is refused (self-authorizing deletes) ---");
  if (!(await ensureLikeFixtures(ctx))) {
    check('b9 foreign delete', false, 'fixture posts unavailable');
    return;
  }
  // Bot B likes its own postT1 (self-likes carry no constraint) so a foreign
  // tuple exists for bot A to attack.
  const bLike = await attemptCreateIndexOnly(ctx.sdk, ctx.botB, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({
      postId: bs58.decode(ctx.postT1),
      hashtag: ctx.tag,
      postAuthor: bs58.decode(ctx.botB.ownerId),
    }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1, ctx.botB.ownerId),
  });
  if (!expectAccepted("b9a bot B's own like on postT1 is accepted (the victim tuple)", bLike).ok) return;
  // B's like survives the whole run (b9c proves it) — c3a counts it.
  ctx.bLikesT1 = true;

  const { createdAt } = await recoverLikeCreatedAt(
    ctx, 'like', 'postAuthor', ctx.botB.ownerId, 'postId', ctx.postT1, ctx.botB.ownerId
  );
  if (createdAt === undefined || createdAt === null) {
    check('b9b foreign delete attempt', false, "could not recover B's like tuple to attack");
    return;
  }

  // Bot A signs a delete whose document carries $ownerId = B: the transition's
  // identity is B, the signature is A's — consensus must refuse it and B's
  // entry must survive.
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.botB.ownerId,
    data: {
      postId: bs58.decode(ctx.postT1),
      hashtag: ctx.tag,
      postAuthor: bs58.decode(ctx.botB.ownerId),
    },
    entropy: randomIdBytes(),
    createdAt: BigInt(createdAt),
  });
  expectRejected(
    "b9b bot A deleting bot B's like tuple is rejected",
    await attemptDeleteByValues(ctx.sdk, ctx.botA, {
      document,
      accepted: async () => !(await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1, ctx.botB.ownerId)),
    }),
    FOREIGN_DELETE
  );

  const survives = await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1, ctx.botB.ownerId);
  check("b9c bot B's like entry survives the attack", survives === true);
}

async function caseB10LikeReply(ctx) {
  console.log('\n--- b10. likeReply mirror: agreement, ghost, duplicate, count, recovery unlike ---');
  if (!(await ensureLikeFixtures(ctx))) {
    check('b10 likeReply', false, 'fixture posts unavailable');
    return;
  }
  const b = bs58.decode(ctx.botB.ownerId);

  const reply = await attemptCreate(ctx.sdk, ctx.botB, {
    contractId: ctx.contractId,
    docType: 'reply',
    data: replyData({
      rootPostId: bs58.decode(ctx.postT1),
      parentOwnerId: b,
      author: b,
      content: 'reply to be liked',
    }),
    tokenCost: TOKEN_COST.reply,
  });
  if (!expectAccepted('b10a reply created for the likeReply cases', reply).ok) return;
  const replyId = reply.id;

  const ghost = randomIdBytes();
  const ghostB58 = bs58.encode(ghost);
  expectRejected(
    'b10b likeReply of a nonexistent reply is rejected (40120)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'likeReply',
      data: likeReplyData({ replyId: ghost, replyAuthor: b }),
      tokenCost: TOKEN_COST.likeReply,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', ghostB58, ctx.botA.ownerId),
    }),
    REFERENCE_NOT_FOUND
  );

  expectRejected(
    'b10c likeReply with the WRONG replyAuthor is rejected (40127)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'likeReply',
      data: likeReplyData({ replyId: bs58.decode(replyId), replyAuthor: bs58.decode(ctx.botA.ownerId) }),
      tokenCost: TOKEN_COST.likeReply,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId, ctx.botA.ownerId),
    }),
    PROPERTY_MISMATCH
  );

  const liked = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'likeReply',
    data: likeReplyData({ replyId: bs58.decode(replyId), replyAuthor: b }),
    tokenCost: TOKEN_COST.likeReply,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId, ctx.botA.ownerId),
  });
  if (!expectAccepted('b10d likeReply with the matching replyAuthor is accepted', liked).ok) return;

  expectRejected(
    'b10e liking the same reply twice is rejected (structural uniqueness, 40105)',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'likeReply',
      data: likeReplyData({ replyId: bs58.decode(replyId), replyAuthor: b }),
      tokenCost: TOKEN_COST.likeReply,
      accepted: async () => (await countBy(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId)) >= 2,
    }),
    DUPLICATE_UNIQUE
  );

  const count = await countBy(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId);
  check('b10f byReply countable sees exactly the one like', count === 1, `count=${count}`);

  // Recovery unlike, mirroring b8: replyId ← byLiker, $createdAt ←
  // byAuthorTimeReply, replyAuthor ← the reply document's author.
  const myLikes = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'likeReply',
      where: [['$ownerId', '==', ctx.botA.ownerId]],
      orderBy: [['replyId', 'asc']],
      limit: 100,
    })
  );
  const likedReplyIds = [...myLikes.values()].map((doc) => asBase58(doc.toObject()?.replyId)).filter(Boolean);
  const { createdAt } = await recoverLikeCreatedAt(
    ctx, 'likeReply', 'replyAuthor', ctx.botB.ownerId, 'replyId', replyId, ctx.botA.ownerId
  );
  const replyDoc = await fetchDocument(ctx.sdk, ctx.contractId, 'reply', replyId);
  const replyAuthorB58 = asBase58(replyDoc?.toObject()?.author);
  check(
    'b10g the full likeReply tuple is recoverable from queries alone',
    likedReplyIds.includes(replyId) && createdAt !== undefined && createdAt !== null && replyAuthorB58 === ctx.botB.ownerId,
    `byLiker=${likedReplyIds.includes(replyId)} createdAt=${createdAt} author=${replyAuthorB58}`
  );
  if (createdAt === undefined || createdAt === null || !replyAuthorB58) return;

  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'likeReply',
    ownerId: ctx.botA.ownerId,
    data: { replyId: bs58.decode(replyId), replyAuthor: bs58.decode(replyAuthorB58) },
    entropy: randomIdBytes(),
    createdAt: BigInt(createdAt),
  });
  const deleted = await attemptDeleteByValues(ctx.sdk, ctx.botA, {
    document,
    accepted: async () => !(await entryExists(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId, ctx.botA.ownerId)),
  });
  expectAccepted('b10h likeReply unlike with the query-recovered tuple is accepted', deleted);
  if (deleted.ok) {
    const after = await countBy(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId);
    check('b10i byReply count returns to 0 after the unlike', after === 0, `count=${after}`);
  }
}

async function caseB11TombstoneInterplay(ctx) {
  console.log('\n--- b11. tombstone interplay: the like OUTLIVES the tombstoned post ---');
  const b = bs58.decode(ctx.botB.ownerId);

  const post = await attemptCreate(ctx.sdk, ctx.botB, {
    contractId: ctx.contractId,
    docType: 'post',
    data: postData({ content: 'post to be liked then tombstoned', author: b }),
    tokenCost: TOKEN_COST.post,
  });
  if (!expectAccepted('b11a post created (bot B)', post).ok) return;

  const liked = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({ postId: bs58.decode(post.id), postAuthor: b }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', post.id, ctx.botA.ownerId),
  });
  if (!expectAccepted('b11b bot A likes the post', liked).ok) return;
  const countBefore = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', post.id);

  expectAccepted(
    'b11c the author tombstones the post (blank content + deleted:true replace)',
    await attemptReplace(ctx.sdk, ctx.botB, {
      contractId: ctx.contractId,
      docType: 'post',
      id: post.id,
      revision: 1n,
      data: postData({ content: '', author: b, deleted: true }),
    })
  );

  const stillThere = await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', post.id, ctx.botA.ownerId);
  const countAfter = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', post.id);
  check(
    'b11d the like REMAINS after the tombstone (entry present, byPost count unchanged)',
    stillThere === true && countAfter === countBefore && countBefore === 1,
    `entry=${stillThere} before=${countBefore} after=${countAfter}`
  );
  console.log(
    '     DOCUMENTED BEHAVIOR: tombstoning is an ordinary replace — the post document still exists,'
  );
  console.log(
    '     so its likes (and their counts, ranked groups and preallocated trees) are untouched, and'
  );
  console.log(
    '     nothing stops NEW likes on a tombstoned post. Clients must hide tombstoned posts (and'
  );
  console.log('     their like affordances) by the deleted flag, not expect the chain to cascade.');
}

async function caseB12TagListing(ctx) {
  console.log('\n--- b12. tag listing via post.tagAndTime ---');
  if (!(await ensureLikeFixtures(ctx))) {
    check('b12 tag listing', false, 'fixture posts unavailable');
    return;
  }
  const shape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'post',
    where: [['hashtag', '==', ctx.tag]],
    orderBy: [['$createdAt', 'asc']],
    limit: 100,
  };
  const page = await readback(() => ctx.sdk.documents.query(shape));
  const ids = [...page.values()].map((doc) => asBase58(doc.toObject()?.$id) ?? doc.id).map(String);
  check(
    "b12a tagAndTime (hashtag ==, orderBy $createdAt) returns exactly the run's tagged posts",
    page.size === 2 && ids.includes(ctx.postT1) && ids.includes(ctx.postT2),
    `size=${page.size} ids=[${ids.join(', ')}]`
  );
  workingShapes.push({ label: 'tag-page listing (post.tagAndTime)', shape: { ...shape, where: [['hashtag', '==', '<tag>']], dataContractId: '<contractId>' } });
}

// ---- C-cases: NEW v5 surfaces (dev.7 grammar) -------------------------------
//
// Everything below queries index shapes that only exist on the v5 contract
// (skipIfAbsent byHashtagPost, at-form rankings, ranked followerCount) and
// needs a dev.7+ wasm-sdk: the ranked picker/path modules are shared with the
// proof verifier, so a dev.5/dev.6 SDK fails inside proof verification, not
// with a clean "unsupported" error. If every c-case dies the same way inside
// verify, check the @dashevo/evo-sdk pin BEFORE suspecting the contract.

/** Shared ranked-page helpers (the b7 locals, hoisted for the c-cases). */
const groupValueOf = (page, id) => page.entries.find((entry) => entry.groupValue === id)?.value;
const nonZeroGroups = (page) => page.entries.filter((entry) => entry.value > 0n).map((entry) => entry.groupValue);
/**
 * A bounded top-K page on a long-lived contract eventually fills with older
 * groups: presence is only demanded while the page has room. Exact values are
 * always cross-checked through the countable index separately.
 */
const onRankedPage = (page, id, expected, limit) => {
  const value = groupValueOf(page, id);
  if (value !== undefined) return value === expected;
  return page.entries.length >= limit;
};

/** `documents.ranked` shape for a like index level (`groupBy` names the level). */
/** The daily grid every v6 windowed index shares (seconds, as the contract declares). */
const DAY_GRID = { range: 86400, step: 86400 };
/** `timeRange` member pinning the current UTC day on a v6 windowed index. */
const todayWindow = () => ({ timeRange: [{ field: '$createdAt', selector: 'newest', grid: DAY_GRID }] });
const likeRankedShape = (ctx, groupBy, where = undefined, limit = 100) => ({
  dataContractId: ctx.contractId,
  documentTypeName: 'like',
  groupBy,
  aggregate: { type: 'count' },
  ...(where ? { where } : {}),
  limit,
});

async function caseC1UntaggedLifecycle(ctx) {
  console.log('\n--- c1. untagged like lifecycle: skip semantics + hashtag-less delete tuple ---');
  if (!(await ensureLike(ctx, 'postU', undefined))) {
    check('c1 untagged lifecycle', false, 'no accepted untagged like on postU');
    return;
  }

  // The untagged like EXISTS on every non-skip surface…
  const inByPost = await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postU, ctx.botA.ownerId);
  check('c1a the untagged like exists in byPost (non-skip surfaces hold it)', inByPost === true);

  const byLiker = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [['$ownerId', '==', ctx.botA.ownerId]],
      orderBy: [['postId', 'asc']],
      limit: 100,
    })
  );
  const likedIds = [...byLiker.values()].map((doc) => asBase58(doc.toObject()?.postId)).filter(Boolean);
  check('c1b byLiker returns the untagged like', likedIds.includes(ctx.postU), `got ${likedIds.length} likes`);

  const { createdAt } = await recoverLikeCreatedAt(
    ctx, 'like', 'postAuthor', ctx.botB.ownerId, 'postId', ctx.postU, ctx.botA.ownerId
  );
  check(
    'c1c byAuthorTimePost (the PLAIN sibling) projects the untagged like with $createdAt',
    createdAt !== undefined && createdAt !== null,
    `createdAt=${createdAt}`
  );

  // …and in NO hashtag group: byHashtagPost is skipIfAbsent, so the write
  // never touched it. A hashtag-bound read (the only reads the router admits
  // on a skip index) can never see it, under any tag.
  const pinned = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [
        ['hashtag', '==', ctx.tag],
        ['postId', '==', ctx.postU],
      ],
    })
  );
  check('c1d hashtag-pinned reads never see the untagged like (no byHashtagPost entry)', pinned.size === 0, `size=${pinned.size}`);

  if (createdAt === undefined || createdAt === null) {
    check('c1e untagged unlike', false, 'no $createdAt recovered — cannot attempt the delete');
    return;
  }
  const countBefore = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postU);
  // The delete tuple mirrors the create: hashtag ABSENT (delete-by-values must
  // recompute the same skip — a tuple carrying a hashtag would hash into
  // different index entries and delete nothing).
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.botA.ownerId,
    data: {
      postId: bs58.decode(ctx.postU),
      postAuthor: bs58.decode(ctx.botB.ownerId),
    },
    entropy: randomIdBytes(),
    createdAt: BigInt(createdAt),
  });
  const deleted = await attemptDeleteByValues(ctx.sdk, ctx.botA, {
    document,
    accepted: async () => !(await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postU, ctx.botA.ownerId)),
  });
  expectAccepted('c1e unlike with the hashtag-ABSENT value tuple is accepted', deleted);
  if (!deleted.ok) return;
  ctx.likes.postU = false;

  const countAfter = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postU);
  check('c1f byPost count decrements after the untagged unlike', countBefore >= 1 && countAfter === countBefore - 1, `before=${countBefore} after=${countAfter}`);

  const relike = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({ postId: bs58.decode(ctx.postU), postAuthor: bs58.decode(ctx.botB.ownerId) }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postU, ctx.botA.ownerId),
  });
  expectAccepted('c1g untagged re-like is accepted (uniqueness cleared)', relike);
  if (relike.ok) ctx.likes.postU = true;
}

async function caseC2PrefixRanked(ctx) {
  console.log('\n--- c2. prefix ranked: top hashtags, preallocated-at-zero, drained group, leaderboard ---');
  const ready =
    (await ensureLike(ctx, 'postT1', ctx.tag)) &&
    (await ensureLike(ctx, 'postT2', ctx.tag)) &&
    (await ensureLike(ctx, 'postU', undefined));
  if (!ready) {
    check('c2 prefix ranked', false, 'like fixtures unavailable');
    return;
  }
  await settle();

  // Global top hashtags: the {at: "hashtag"} level of byHashtagPost. Three-path
  // agreement makes this exact even on a long-lived contract: ranked group
  // value == prefix-pinned count == pinned projection size, on a run-unique tag.
  const tagCount = await countBy(ctx.sdk, ctx.contractId, 'like', 'hashtag', ctx.tag);
  const pinnedPage = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [['hashtag', '==', ctx.tag]],
      orderBy: [['postId', 'asc']],
      limit: 100,
    })
  );
  const topTagsShape = likeRankedShape(ctx, 'hashtag');
  const topTags = await readback(() => ctx.sdk.documents.ranked(topTagsShape));
  check(
    'c2a top-hashtags ranking (at "hashtag"): run tag ranks with count == pinned count == projection size (>= the 2 tagged likes)',
    tagCount >= 2 && pinnedPage.size === tagCount && onRankedPage(topTags, ctx.tag, BigInt(tagCount), 100),
    `count=${tagCount} projection=${pinnedPage.size} page=${groupValueOf(topTags, ctx.tag) ?? 'not on page'} entries=${topTags.entries.length}`
  );
  workingShapes.push({ label: 'global top hashtags (byHashtagPost at-level ranking)', shape: { ...topTagsShape, dataContractId: '<contractId>' } });

  // Preallocated-at-zero: registering postTZ (tagged, never liked) preallocated
  // its (hashtag → postId) trees, so the tagZ GROUP exists at count 0 before
  // any like ever lands. Clients must zero-filter, exactly like v4's b7b.
  const zeroCount = await countBy(ctx.sdk, ctx.contractId, 'like', 'hashtag', ctx.tagZ);
  check(
    'c2b tagged-but-never-liked tag is a ZERO-COUNT group (preallocated) and never survives the zero-filter',
    zeroCount === 0 && !nonZeroGroups(topTags).includes(ctx.tagZ),
    `count=${zeroCount} page=${groupValueOf(topTags, ctx.tagZ) ?? 'not on page'}`
  );

  // Drain: like → unlike must return the group to 0 AND leave it queryable
  // (preallocated trees survive the last delete — "every entry insert costs
  // the same as the first" cuts both ways).
  const drainLike = await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({ postId: bs58.decode(ctx.postTZ), hashtag: ctx.tagZ, postAuthor: bs58.decode(ctx.botB.ownerId) }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postTZ, ctx.botA.ownerId),
  });
  if (expectAccepted('c2c like on the zero-group post is accepted (group leaves zero)', drainLike).ok) {
    const filled = await countBy(ctx.sdk, ctx.contractId, 'like', 'hashtag', ctx.tagZ);
    check('c2d the tag group counts 1 while the like stands', filled === 1, `count=${filled}`);

    const { createdAt } = await recoverLikeCreatedAt(
      ctx, 'like', 'postAuthor', ctx.botB.ownerId, 'postId', ctx.postTZ, ctx.botA.ownerId
    );
    if (createdAt === undefined || createdAt === null) {
      check('c2e drain unlike', false, 'no $createdAt recovered — cannot drain the group');
    } else {
      const { document } = buildDocument({
        contractId: ctx.contractId,
        docType: 'like',
        ownerId: ctx.botA.ownerId,
        data: {
          postId: bs58.decode(ctx.postTZ),
          hashtag: ctx.tagZ,
          postAuthor: bs58.decode(ctx.botB.ownerId),
        },
        entropy: randomIdBytes(),
        createdAt: BigInt(createdAt),
      });
      const drained = await attemptDeleteByValues(ctx.sdk, ctx.botA, {
        document,
        accepted: async () => !(await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postTZ, ctx.botA.ownerId)),
      });
      if (expectAccepted('c2e unlike drains the group', drained).ok) {
        const drainedCount = await countBy(ctx.sdk, ctx.contractId, 'like', 'hashtag', ctx.tagZ);
        const afterPage = await readback(() => ctx.sdk.documents.ranked(likeRankedShape(ctx, 'hashtag')));
        check(
          'c2f the DRAINED group answers 0 and stays queryable (count query serves, zero-filter drops it)',
          drainedCount === 0 && !nonZeroGroups(afterPage).includes(ctx.tagZ),
          `count=${drainedCount} page=${groupValueOf(afterPage, ctx.tagZ) ?? 'not on page'}`
        );
      }
    }
  }

  // Creator leaderboard: the postAuthor level of the multi-at byAuthorPost.
  // Accumulation-immune via cross-path agreement with the prefix-pinned count.
  const authorCount = await countBy(ctx.sdk, ctx.contractId, 'like', 'postAuthor', ctx.botB.ownerId);
  const leaderboardShape = likeRankedShape(ctx, 'postAuthor');
  const leaderboard = await readback(() => ctx.sdk.documents.ranked(leaderboardShape));
  check(
    "c2g creator leaderboard (at postAuthor): B ranks with value == prefix-pinned author count (>= the run's 3 standing likes)",
    authorCount >= 3 && onRankedPage(leaderboard, ctx.botB.ownerId, BigInt(authorCount), 100),
    `count=${authorCount} page=${groupValueOf(leaderboard, ctx.botB.ownerId) ?? 'not on page'} entries=${leaderboard.entries.length}`
  );
  workingShapes.push({ label: 'creator leaderboard (byAuthorPost at-level ranking)', shape: { ...leaderboardShape, dataContractId: '<contractId>' } });

  // Terminal level of the SAME index (the b7d read, repeated here so
  // `--only c2` proves both levels of one index serve together): per-author
  // top posts, cross-checked against the per-post countable.
  const perAuthorShape = likeRankedShape(ctx, 'postId', [['postAuthor', '==', ctx.botB.ownerId]], 100);
  const perAuthor = await readback(() => ctx.sdk.documents.ranked(perAuthorShape));
  const t1Count = await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', ctx.postT1);
  check(
    'c2h per-author top posts (terminal level of the SAME byAuthorPost index) agree with the per-post count',
    t1Count >= 1 && onRankedPage(perAuthor, ctx.postT1, BigInt(t1Count), 100),
    `t1Count=${t1Count} page=${groupValueOf(perAuthor, ctx.postT1) ?? 'not on page'} entries=${perAuthor.entries.length}`
  );
}

async function caseC3PrefixCounts(ctx) {
  console.log('\n--- c3. prefix-pinned counts (#4537): per-tag and per-author like totals ---');
  const ready =
    (await ensureLike(ctx, 'postT1', ctx.tag)) &&
    (await ensureLike(ctx, 'postT2', ctx.tag)) &&
    (await ensureLike(ctx, 'postU', undefined));
  if (!ready) {
    check('c3 prefix counts', false, 'like fixtures unavailable');
    return;
  }
  await settle();

  // Per-tag total: exact forever (run-unique tag), and the untagged like can
  // never leak into it (skipIfAbsent — c1d's other half).
  const tagCount = await countBy(ctx.sdk, ctx.contractId, 'like', 'hashtag', ctx.tag);
  const standingTagged = (ctx.likes.postT1 ? 1 : 0) + (ctx.likes.postT2 ? 1 : 0) + (ctx.bLikesT1 ? 1 : 0);
  check(
    "c3a count WHERE hashtag == <run tag> is exactly the run's standing tagged likes",
    tagCount === standingTagged,
    `count=${tagCount} expected=${standingTagged} (A:T1=${!!ctx.likes.postT1} A:T2=${!!ctx.likes.postT2} B:T1=${!!ctx.bLikesT1})`
  );
  workingShapes.push({
    label: 'per-tag like total (prefix-pinned count on byHashtagPost)',
    shape: { dataContractId: '<contractId>', documentTypeName: 'like', count: true, where: [['hashtag', '==', '<tag>']] },
  });

  // Per-author "likes received": accumulation-immune (>= this run's floor) and
  // path-consistent with the leaderboard level c2g reads.
  const authorCount = await countBy(ctx.sdk, ctx.contractId, 'like', 'postAuthor', ctx.botB.ownerId);
  const leaderboard = await readback(() => ctx.sdk.documents.ranked(likeRankedShape(ctx, 'postAuthor')));
  const boardValue = groupValueOf(leaderboard, ctx.botB.ownerId);
  check(
    'c3b count WHERE postAuthor == B >= 3 and agrees with the leaderboard group value',
    authorCount >= 3 && (boardValue === undefined ? leaderboard.entries.length >= 100 : boardValue === BigInt(authorCount)),
    `count=${authorCount} board=${boardValue ?? 'not on page'}`
  );
  workingShapes.push({
    label: 'per-author likes-received total (prefix-pinned count on byAuthorPost)',
    shape: { dataContractId: '<contractId>', documentTypeName: 'like', count: true, where: [['postAuthor', '==', '<authorId>']] },
  });

  // A preallocated-but-empty (or drained) group must answer 0, not error.
  const zeroCount = await countBy(ctx.sdk, ctx.contractId, 'like', 'hashtag', ctx.tagZ);
  check('c3c count WHERE hashtag == <never/no-longer-liked tag> answers 0', zeroCount === 0, `count=${zeroCount}`);
}

async function caseC4TimeWindow(ctx) {
  console.log('\n--- c4. byAuthorTimePost window read returns tagged AND untagged likes ---');
  const ready =
    (await ensureLike(ctx, 'postT1', ctx.tag)) &&
    (await ensureLike(ctx, 'postU', undefined));
  if (!ready) {
    check('c4 time window', false, 'like fixtures unavailable');
    return;
  }
  await settle();

  // The notification read: postAuthor pin + time window on the PLAIN sibling
  // index. Because byAuthorTimePost carries no skip flag it holds EVERY like —
  // this is the projection that proves tagged and untagged likes coexist in
  // one time-ordered stream (and the working proof of the #4543 sibling).
  const shape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'like',
    where: [
      ['postAuthor', '==', ctx.botB.ownerId],
      ['$createdAt', '>=', ctx.runStart],
    ],
    orderBy: [['$createdAt', 'asc']],
    limit: 100,
  };
  const page = await readback(() => ctx.sdk.documents.query(shape));
  const mine = [...page.values()]
    .map((doc) => doc.toObject())
    .filter((obj) => asBase58(obj?.$ownerId) === ctx.botA.ownerId)
    .map((obj) => asBase58(obj?.postId));
  check(
    "c4a the window returns bot A's tagged (postT1) AND untagged (postU) likes in one stream",
    mine.includes(ctx.postT1) && mine.includes(ctx.postU),
    `got ${mine.length} of A's likes in window: tagged=${mine.includes(ctx.postT1)} untagged=${mine.includes(ctx.postU)}`
  );
  const ordered = [...page.values()].map((doc) => doc.toObject()?.$createdAt).filter((t) => t !== undefined);
  check(
    'c4b the window is $createdAt-ordered and starts at/after the run start',
    ordered.every((t, i) => (i === 0 || ordered[i - 1] <= t) && BigInt(t) >= BigInt(ctx.runStart)),
    `first=${ordered[0]} last=${ordered[ordered.length - 1]} runStart=${ctx.runStart}`
  );
  workingShapes.push({ label: 'like-notification window (byAuthorTimePost)', shape: { ...shape, where: [['postAuthor', '==', '<authorId>'], ['$createdAt', '>=', '<sinceMs>']], dataContractId: '<contractId>' } });
}

async function caseC5FollowRanked(ctx) {
  console.log('\n--- c5. follow rankings: O(1) follower count + most-followed leaderboard ---');
  const b = bs58.decode(ctx.botB.ownerId);

  // Sweep a leftover follow (unique ownerAndFollowing outlives re-runs; a5
  // also sweeps, but c5 must be self-sufficient under --only).
  const existing = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'follow',
      where: [
        ['$ownerId', '==', ctx.botA.ownerId],
        ['followingId', '==', ctx.botB.ownerId],
      ],
    })
  );
  for (const doc of existing.values()) {
    const staleId = asBase58(doc.toObject()?.$id) ?? doc.id;
    console.log(`     (sweeping leftover follow ${staleId})`);
    await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'follow', id: String(staleId) });
  }

  const before = await countBy(ctx.sdk, ctx.contractId, 'follow', 'followingId', ctx.botB.ownerId);
  const follow = expectAccepted(
    'c5a follow A→B is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'follow',
      data: followData({ followingId: b }),
    })
  );
  if (!follow.ok) return;
  await settle();

  const after = await countBy(ctx.sdk, ctx.contractId, 'follow', 'followingId', ctx.botB.ownerId);
  check(
    "c5b O(1) follower count (upgraded followerCount index): B's count incremented by exactly 1",
    after === before + 1,
    `before=${before} after=${after}`
  );

  const boardShape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'follow',
    groupBy: 'followingId',
    aggregate: { type: 'count' },
    limit: 100,
  };
  const board = await readback(() => ctx.sdk.documents.ranked(boardShape));
  check(
    'c5c most-followed leaderboard (ranked followerCount): B ranks with value == the follower count',
    onRankedPage(board, ctx.botB.ownerId, BigInt(after), 100),
    `count=${after} page=${groupValueOf(board, ctx.botB.ownerId) ?? 'not on page'} entries=${board.entries.length}`
  );
  workingShapes.push({ label: 'most-followed leaderboard (follow.followerCount ranking)', shape: { ...boardShape, dataContractId: '<contractId>' } });

  // Cleanup keeps a5b/c5a green on the next run.
  await attemptDelete(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'follow', id: follow.id });
}

// ---- D-cases: v6 daily-windowed rankings (dev.8, contract v6) ----------------

async function caseD1WindowedLike(ctx) {
  console.log('\n--- d1. like.byDayPost / byDayAuthorPost: today\'s ranking is served, ordered, proved ---');
  const ready =
    (await ensureLike(ctx, 'postT1', ctx.tag)) &&
    (await ensureLike(ctx, 'postT2', ctx.tag)) &&
    (await ensureLike(ctx, 'postU', undefined));
  if (!ready) {
    check('d1 windowed like', false, 'like fixtures unavailable');
    return;
  }
  await settle();

  // Today's top posts (terminal level of byDayPost, bucket pinned by the node).
  const todayPosts = { ...likeRankedShape(ctx, 'postId'), ...todayWindow() };
  const page = await readback(() => ctx.sdk.documents.ranked(todayPosts));
  const ids = nonZeroGroups(page);
  // b9 leaves bot B's own (standing) like on postT1, so T1 counts 2 in a
  // full run and 1 under --only; T2/U carry bot A's like alone. This is the
  // GLOBAL today page on a populated (and concurrently seeded) network: a
  // single-like fixture can legitimately fall off a full 100-entry page, so
  // presence is demanded only while the page has room (onRankedPage); the
  // exact per-fixture counts are pinned by d1c on the author-pinned level.
  const expectT1 = 1n + (ctx.bLikesT1 ? 1n : 0n);
  check(
    'd1a today\'s top posts (like.byDayPost, newest bucket) is served and ranks the fixtures with their standing counts (or the page is full)',
    onRankedPage(page, ctx.postT1, expectT1, 100) && onRankedPage(page, ctx.postT2, 1n, 100) && onRankedPage(page, ctx.postU, 1n, 100),
    `page=${ids.length} T1=${groupValueOf(page, ctx.postT1)} (expected ${expectT1}) T2=${groupValueOf(page, ctx.postT2)} U=${groupValueOf(page, ctx.postU)}`
  );
  workingShapes.push({ label: "today's top posts (like.byDayPost, newest)", shape: { ...todayPosts, dataContractId: '<contractId>' } });

  // Today's top creators (prefix level of byDayAuthorPost).
  const todayCreators = { ...likeRankedShape(ctx, 'postAuthor'), ...todayWindow() };
  const creators = await readback(() => ctx.sdk.documents.ranked(todayCreators));
  const bCount = groupValueOf(creators, ctx.botB.ownerId);
  check(
    'd1b today\'s top creators (like.byDayAuthorPost at postAuthor) credits bot B with >= 3 likes received today',
    bCount !== undefined && bCount >= 3n,
    `B=${bCount}`
  );
  workingShapes.push({ label: "today's top creators (like.byDayAuthorPost at postAuthor, newest)", shape: { ...todayCreators, dataContractId: '<contractId>' } });

  // Today's top posts BY bot B (terminal level, author pinned + bucket pinned).
  const todayByAuthor = { ...likeRankedShape(ctx, 'postId', [['postAuthor', '==', ctx.botB.ownerId]]), ...todayWindow() };
  const byAuthor = await readback(() => ctx.sdk.documents.ranked(todayByAuthor));
  check(
    'd1c today\'s top posts by one author (bucket + postAuthor pinned, rank postId) lists the fixtures',
    groupValueOf(byAuthor, ctx.postT1) === expectT1 && groupValueOf(byAuthor, ctx.postT2) === 1n && groupValueOf(byAuthor, ctx.postU) === 1n,
    `entries=${byAuthor.entries.length} T1=${groupValueOf(byAuthor, ctx.postT1)} T2=${groupValueOf(byAuthor, ctx.postT2)} U=${groupValueOf(byAuthor, ctx.postU)}`
  );
  workingShapes.push({ label: "today's top posts by author (byDayAuthorPost terminal, newest)", shape: { ...todayByAuthor, dataContractId: '<contractId>', where: [['postAuthor', '==', '<authorId>']] } });

  // Cross-check: the all-time twin agrees on today's counts (the run is minutes old).
  const allTime = await readback(() => ctx.sdk.documents.ranked(likeRankedShape(ctx, 'postId')));
  check(
    'd1d all-time byPost and today\'s byDayPost agree on every fixture (both pages are top-100 of a populated network, so absent-on-both also agrees)',
    [ctx.postT1, ctx.postT2, ctx.postU].every((id) => groupValueOf(allTime, id) === groupValueOf(page, id)),
    [ctx.postT1, ctx.postT2, ctx.postU].map((id) => `${id.slice(0, 6)}: all=${groupValueOf(allTime, id)} today=${groupValueOf(page, id)}`).join(' ')
  );
}

async function caseD2WindowedBeat(ctx) {
  console.log('\n--- d2. beat: today\'s trending hashtags + per-tag top, propertyAgreement on hashtag ---');
  const ready = (await ensureBeat(ctx, 'postT1', ctx.tag)) && (await ensureBeat(ctx, 'postT2', ctx.tag));
  if (!ready) {
    check('d2 windowed beat', false, 'beat fixtures unavailable');
    return;
  }
  await settle();

  const beatShape = (groupBy, where) => ({
    dataContractId: ctx.contractId,
    documentTypeName: 'beat',
    groupBy,
    aggregate: { type: 'count' },
    ...(where ? { where } : {}),
    limit: 100,
    ...todayWindow(),
  });
  const trending = await readback(() => ctx.sdk.documents.ranked(beatShape('hashtag')));
  check(
    'd2a today\'s trending hashtags (beat.byDayHashtagPost at hashtag, newest) ranks the run tag at 2',
    groupValueOf(trending, ctx.tag) === 2n,
    `tag=${groupValueOf(trending, ctx.tag)} entries=${trending.entries.length}`
  );
  workingShapes.push({ label: "today's trending hashtags (beat.byDayHashtagPost at hashtag, newest)", shape: { ...beatShape('hashtag'), dataContractId: '<contractId>' } });

  const perTag = await readback(() => ctx.sdk.documents.ranked(beatShape('postId', [['hashtag', '==', ctx.tag]])));
  check(
    'd2b today\'s top posts for #tag (bucket + hashtag pinned, rank postId) lists both tagged fixtures at 1',
    groupValueOf(perTag, ctx.postT1) === 1n && groupValueOf(perTag, ctx.postT2) === 1n,
    `T1=${groupValueOf(perTag, ctx.postT1)} T2=${groupValueOf(perTag, ctx.postT2)}`
  );
  workingShapes.push({ label: "today's top posts for #tag (beat.byDayHashtagPost terminal, newest)", shape: { ...beatShape('postId', [['hashtag', '==', '<tag>']]), dataContractId: '<contractId>' } });

  // The rolling k=4 grid on the same doctype: the bare selector is ambiguous
  // (two grids on $createdAt) and must be refused; naming the grid serves.
  let ambiguous = null;
  try {
    await ctx.sdk.documents.ranked({ ...beatShape('hashtag'), timeRange: [{ field: '$createdAt', selector: 'newest' }] });
  } catch (e) { ambiguous = describeErr(e); }
  check(
    'd2c a bare `newest` on beat is refused (two grids bucket $createdAt) — the grid must be named',
    ambiguous !== null && /grid/i.test(ambiguous),
    (ambiguous ?? 'served without a grid').slice(0, 160)
  );
  const rolling = await readback(() => ctx.sdk.documents.ranked({ ...beatShape('hashtag'), timeRange: [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 21600 } }] }));
  check(
    'd2d the overlapping k=4 grid (byRollingHashtagPost) ranks the run tag at 2 in its newest window too',
    groupValueOf(rolling, ctx.tag) === 2n,
    `tag=${groupValueOf(rolling, ctx.tag)}`
  );

  // propertyAgreement: a beat whose hashtag disagrees with the post is refused.
  const wrong = await attemptCreateIndexOnly(ctx.sdk, ctx.botB, {
    contractId: ctx.contractId,
    docType: 'beat',
    data: { postId: bs58.decode(ctx.postT1), hashtag: 'wrong_tag' },
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'beat', 'postId', ctx.postT1, ctx.botB.ownerId),
  });
  check(
    'd2e a beat whose hashtag mismatches the post is rejected (40127 propertyAgreement)',
    !wrong.ok && /40127|agreement|mismatch/i.test(wrong.error ?? ''),
    (wrong.error ?? 'accepted').slice(0, 160)
  );
  if (!wrong.ok) capturedErrors.push({ label: 'd2e beat hashtag mismatch', message: wrong.error ?? '' });
}

async function caseD3ColdBucket(ctx) {
  console.log('\n--- d3. cold bucket: yesterday has no entries (byStart) — the dev.8 proof edge ---');
  const now = Date.now();
  const todayStart = now - (now % 86_400_000);
  const yesterdayStart = todayStart - 86_400_000;
  let error = null;
  let entries = null;
  try {
    const page = await ctx.sdk.documents.ranked({ ...likeRankedShape(ctx, 'postId', undefined, 10), timeRange: [{ field: '$createdAt', selector: 'byStart', startMs: yesterdayStart, grid: DAY_GRID }] });
    entries = page.entries.length;
  } catch (e) { error = describeErr(e); }
  // Either outcome is recorded verbatim: an empty page is the ideal; the known
  // dev.8 behaviour is a proof-generation refusal on a never-populated bucket,
  // which the client maps to "empty". Anything else is a real failure.
  const knownEdge = error !== null && /single-path axis read must produce exactly one axis descent/i.test(error);
  check(
    'd3a yesterday\'s bucket (byStart, no entries ever) is either a proved empty page or the known cold-bucket refusal',
    entries === 0 || knownEdge,
    error ? error.slice(0, 160) : `entries=${entries}`
  );
  if (knownEdge) capturedErrors.push({ label: 'd3a cold bucket (dev.8 edge, mapped to empty by the client)', message: error });
}

const CASES = new Map([
  ['a1', caseA1ReplyLinkage],
  ['a2', caseA2Quotes],
  ['a3', caseA3PostsOnly],
  ['a4', caseA4Permanence],
  ['a5', caseA5IdentityRefs],
  // a6 late on purpose: it asserts totals a1/a2/a4 produced.
  ['a6', caseA6CountTrees],
  ['b1', caseB1LikeCreate],
  ['b2', caseB2AgreementViolations],
  ['b3', caseB3GhostPost],
  ['b4', caseB4Duplicate],
  ['b5', caseB5TrapGuard],
  ['b6', caseB6BatchedMembership],
  ['b7', caseB7Ranked],
  ['b8', caseB8Unlike],
  ['b9', caseB9ForeignDelete],
  ['b10', caseB10LikeReply],
  ['b11', caseB11TombstoneInterplay],
  ['b12', caseB12TagListing],
  ['c1', caseC1UntaggedLifecycle],
  ['c2', caseC2PrefixRanked],
  ['c3', caseC3PrefixCounts],
  ['c4', caseC4TimeWindow],
  ['c5', caseC5FollowRanked],
  ['d1', caseD1WindowedLike],
  ['d2', caseD2WindowedBeat],
  ['d3', caseD3ColdBucket],
]);

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    contract: process.env.V5_CONTRACT_ID?.trim() || null,
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
  for (const [flag, value] of [['--bot', args.botIndex], ['--bot2', args.bot2Index]]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} takes a non-negative integer index`);
  }
  if (args.botIndex === args.bot2Index) {
    throw new Error('--bot and --bot2 must be different identities');
  }
  if (args.only !== null) {
    args.only = args.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (args.only.length === 0) throw new Error('--only takes a comma-separated list of case keys');
    const unknown = args.only.filter((key) => !CASES.has(key));
    if (unknown.length > 0) throw new Error(`--only: unknown case(s) ${unknown.join(', ')}`);
  }
  if (!args.contract && !args.dryRun) {
    throw new Error(
      'No contract id: v5 has no default (it only exists after wipe-day registration). Pass --contract <id> or set V5_CONTRACT_ID.'
    );
  }
  return args;
}

function selectedCases(args) {
  return [...CASES.keys()].filter((key) => !args.only || args.only.includes(key));
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

  /** `[label, docType, data, createdAt]` — every shape the live battery writes. */
  const shapes = [
    ['post (untagged)', 'post', postData({ author: someId() }), undefined],
    ['post (tagged)', 'post', postData({ author: someId(), hashtag: 'v5tag' }), undefined],
    ['post (quote of post)', 'post', postData({ author: someId(), quotedPostId: someId() }), undefined],
    ['post (quote of reply)', 'post', postData({ author: someId(), quotedReplyId: someId() }), undefined],
    ['post (both quotes)', 'post', postData({ author: someId(), quotedPostId: someId(), quotedReplyId: someId() }), undefined],
    ['post (tombstone)', 'post', postData({ content: '', author: someId(), deleted: true }), undefined],
    ['reply (flat)', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId(), author: someId() }), undefined],
    ['reply (nested)', 'reply', replyData({ rootPostId: someId(), replyToReplyId: someId(), parentOwnerId: someId(), author: someId() }), undefined],
    ['reply (tombstone)', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId(), author: someId(), content: '', deleted: true }), undefined],
    ['like (tagged)', 'like', likeData({ postId: someId(), hashtag: 'v5tag', postAuthor: someId() }), undefined],
    ['like (hashtag absent)', 'like', likeData({ postId: someId(), postAuthor: someId() }), undefined],
    ['like (delete tuple)', 'like', likeData({ postId: someId(), hashtag: 'v5tag', postAuthor: someId() }), BigInt(Date.now())],
    ['like (absent delete tuple)', 'like', likeData({ postId: someId(), postAuthor: someId() }), BigInt(Date.now())],
    ['likeReply', 'likeReply', likeReplyData({ replyId: someId(), replyAuthor: someId() }), undefined],
    ['likeReply (delete tuple)', 'likeReply', likeReplyData({ replyId: someId(), replyAuthor: someId() }), BigInt(Date.now())],
    ['repost', 'repost', repostData({ postId: someId(), postOwnerId: someId() }), undefined],
    ['bookmark', 'bookmark', bookmarkData({ postId: someId() }), undefined],
    ['follow', 'follow', followData({ followingId: someId() }), undefined],
    ['postMention', 'postMention', postMentionData({ postId: someId(), mentionedUserId: someId() }), undefined],
  ];
  for (const [label, docType, data, createdAt] of shapes) {
    const { id } = buildDocument({ contractId, docType, ownerId, data, entropy: randomIdBytes(), createdAt });
    console.log(`document shape ok: ${label.padEnd(26)} (${docType}) → ${id}`);
  }
  buildDocument({
    contractId,
    docType: 'post',
    ownerId,
    data: postData({ content: '', author: randomIdBytes(), deleted: true }),
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
  console.error('Usage: node scripts/verify-v5.mjs --contract <id> [--bot <n>] [--bot2 <n>]');
  console.error('       [--owner <id>] [--owner2 <id>] [--only a1,c2] [--dry-run]');
  process.exit(1);
}

try {
  await ensureInitialized();

  if (args.dryRun) {
    dryRun(args);
    process.exit(0);
  }

  reconnectContractId = args.contract;
  const { sdk: firstSdk, devnetName, addresses, protocolVersion } = await buildConnectedSdk(args.contract);
  activeSdk = firstSdk;
  const sdk = sdkHandle;
  console.log(`protocol version ratcheted via epoch query: PV${protocolVersion ?? '?'}`);
  const botA = await botSigner(sdk, args.botIndex, args.ownerId);
  const botB = await botSigner(sdk, args.bot2Index, args.owner2Id);
  console.log(`connected to devnet "${devnetName}" (${addresses.length} addresses)`);
  console.log(`v5 contract: ${args.contract}`);
  console.log(`A=${botA.label}  B=${botB.label}`);
  console.log('YAPP balances:');
  await requireYapp(sdk, args.contract, [botA, botB]);

  const ctx = {
    sdk,
    contractId: args.contract,
    botA,
    botB,
    /** Run-unique lowercase hashtags: per-tag assertions stay exact across re-runs. */
    tag: `v5b${Date.now().toString(36)}`,
    /** Second run-unique tag, only ever liked inside c2's drain sub-case. */
    tagZ: `v5z${Date.now().toString(36)}`,
    /** Window floor for c4's byAuthorTimePost read (ms, matches $createdAt). */
    runStart: Date.now(),
    anchorPostId: null,
    anchorReplyId: null,
    /** Every reply written into the anchor post's thread, for the byRoot total. */
    threadReplyIds: [],
    nestedUnder: null,
    nestedCount: 0,
    postQuotes: 0,
    replyQuotes: 0,
    postT1: null,
    postT2: null,
    postU: null,
    postX: null,
    postTZ: null,
    /** Which fixture posts bot A currently likes (drives lazy ensures). */
    likes: {},
    /** Which tagged fixture posts bot A has written a v6 `beat` for. */
    beats: {},
    /** Whether b9 left bot B's own (standing) like on postT1 — c3a counts it. */
    bLikesT1: false,
  };
  console.log(`run tag: #${ctx.tag}`);

  for (const key of selectedCases(args)) {
    try {
      await CASES.get(key)(ctx);
    } catch (e) {
      check(`${key} completed`, false, `aborted: ${describeErr(e).slice(0, 220)}`);
    }
  }

  if (capturedErrors.length > 0) {
    console.log('\n--- captured rejection texts (verbatim) ---');
    for (const { label, message } of capturedErrors) {
      console.log(`\n[${label}]\n${message}`);
    }
  }

  if (workingShapes.length > 0) {
    console.log('\n--- working query shapes ---');
    for (const { label, shape } of workingShapes) {
      console.log(`\n# ${label}\n${JSON.stringify(shape, null, 2)}`);
    }
  }

  console.log('');
  console.log(`anchor post: ${ctx.anchorPostId ?? 'none'}  tagged posts: ${ctx.postT1 ?? 'none'}, ${ctx.postT2 ?? 'none'}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
