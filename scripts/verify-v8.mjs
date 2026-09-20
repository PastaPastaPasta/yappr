/**
 * Registration-day battery for **contract v8**
 * (`contracts/yappr-social-contract-v8.json`, docs/SOCIAL_V8.md): the
 * 4.2.0-beta.3 grammar Yappr adopted, exercised against a freshly registered
 * contract on a beta.3 devnet. The machinery is {@link file://./verify-lib.mjs};
 * this file is the v8 cases only, because v8's query surface is v7's.
 *
 * There is NO default contract id. Pass `--contract` or set `V8_CONTRACT_ID`.
 *
 * ## Two things this battery does that the v7 one did not
 *
 * 1. **Document ids commit to the identity contract nonce** (#4859). The
 *    post/reply creates here are manual batches — they must carry an
 *    `$actionFeeAgreement` (40132 without), which `sdk.documents.create` has no
 *    option for — so they set the document's v1 id themselves:
 *    `dsha256("dash:document-id:v1" ‖ contract ‖ owner ‖ type ‖ entropy ‖ nonce
 *    u64 BE)`, and the id the proof result returns is compared against it
 *    (case a3): the live proof of the derivation the client needs.
 *
 *    Every OTHER create goes through verify-lib's `attemptCreate`, which on
 *    this branch still probes the pre-beta.3 `Document.generateId` id. Those
 *    cases (m1, m2, t2, a1 and the blog/storefront moderated cases) score
 *    correctly only once `beta3/sdk-and-ids` (PR A) has taught verify-lib to
 *    read the id off the create RESULT — run this battery after that merge.
 *
 * 2. **A moderator signs.** The contract owner (`--moderator maker`, the
 *    default) or an appointed moderator (`--moderator bot:2`) bans, suspends,
 *    deletes and claims; it needs its CRITICAL auth key WITHOUT contract bounds.
 *
 * ## Cases
 *
 *   m1  ban: bot B is banned (reason recorded and readable) → B's follow create
 *       is refused 41107 → B's follow DELETE still lands → unban → create lands
 *   m2  suspend: B suspended ~25 s → create refused 41108 → lapses → accepted
 *   m3  moderator delete: B's post P is deleted → fetch absent, removal record
 *       carries the reason; A's like on P refused 40120; A's tombstone of a post
 *       Q quoting P that KEEPS quotedPostId refused 40120; one CLEARING it lands
 *   t1  optional token cost: A's like WITHOUT payment info lands and charges
 *       credits, no YAPP; WITH payment info charges 1 YAPP and the contract
 *       owner's credit balance moves (gas sponsorship, PreferContractOwner)
 *   t2  insufficient YAPP with payment info is refused 40700 (needs a bot with
 *       no YAPP: `--poor <index>`, default 2; skipped when it holds YAPP)
 *   a1  post create without an agreement → 40132
 *   a2  post create with a mismatched agreement → 40133
 *   a3  correct agreement lands, the derived v1 id matches Platform's, the
 *       moderators pot grows by 80M × multiplier ‰; reply.create by 16M
 *   a4  claimFees by the moderator pays the team; a second claim → 41111
 *   g1  oncePerIdentity: first claim lands (+100 YAPP) or was claimed in an
 *       earlier run; a further claim → 40722
 *   l1  first like on a fresh post lands and counts to 1 without preallocation
 *
 * ## Run
 *
 *   node scripts/verify-v8.mjs --self-test
 *   NETWORK=devnet node scripts/verify-v8.mjs --contract <freshV8Id> \
 *        [--bot 0] [--bot2 1] [--poor 2] [--moderator maker|bot:<n>] [--only m1,a3]
 *
 * Both bots need YAPP on the contract under test (funded by the registration
 * script's `--fund`) AND credits (posts on v8 also cost a credit action fee).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import {
  BatchTransition,
  BatchedTransition,
  DocumentActionFeeAgreement,
  DocumentCreateTransition,
  PrivateKey,
  TokenPaymentInfo,
} from '@dashevo/evo-sdk';
import { criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import {
  TOKEN_COST,
  attemptCreate,
  attemptCreateIndexOnly,
  attemptReplace,
  buildDocument,
  check,
  countBy,
  entryExists,
  expectAccepted,
  expectRejected,
  fetchDocument,
  followData,
  likeData,
  randomIdBytes,
  readback,
  runBattery,
} from './verify-lib.mjs';

// ---- v8 numbers (pinned by build-v8-contract.py --self-test) ----------------

const POST_FEE = 80_000_000n;
const REPLY_FEE = 16_000_000n;
const STARTER_GRANT = 100n;
const YAPP_POSITION = 0;
const PREFER_CONTRACT_OWNER = 2;
const INCREASE_TOLERANCE_PERCENT = 20;
/** Long enough for the refused write to run, short enough to wait out. */
const SUSPENSION_MS = 25_000;
const SETTLE_MS = 3000;
const settle = (ms = SETTLE_MS) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `action` and answers the described error, or null when it landed — the
 * half of a battery outcome the cases that bypass verify-lib's `attemptCreate`
 * have to assemble themselves.
 */
async function errorOf(action) {
  try {
    await action();
    return null;
  } catch (e) {
    return describeErr(e);
  }
}

// ---- Expected rejections (code-anchored, see verify-lib) ---------------------

const BANNED = /\bcode"?\s*[=:]\s*41107\b|contractuserbanned|is banned/i;
const SUSPENDED = /\bcode"?\s*[=:]\s*41108\b|contractusersuspended|is suspended/i;
const REFERENCE_NOT_FOUND = /\bcode"?\s*[=:]\s*40120\b|referenced .{0,60}not found|referencedentitynotfound/i;
const INSUFFICIENT_TOKENS = /\bcode"?\s*[=:]\s*40700\b|not have enough token|insufficient token|identitydoesnothaveenoughtokenbalance/i;
const AGREEMENT_NOT_SET = /\bcode"?\s*[=:]\s*40132\b|fee agreement.{0,40}not set|actionfeeagreementnotset/i;
const AGREEMENT_MISMATCH = /\bcode"?\s*[=:]\s*40133\b|fee agreement.{0,40}mismatch|actionfeeagreementmismatch/i;
const ALREADY_CLAIMED_EPOCH = /\bcode"?\s*[=:]\s*41111\b|already.{0,30}claimed.{0,30}epoch|alreadyclaimedthisepoch/i;
const GRANT_ALREADY_CLAIMED = /\bcode"?\s*[=:]\s*40722\b|onceperidentity.{0,60}already|already claimed/i;

// ---- Battery-only flags, stripped before verify-lib parses argv --------------
//
// runBattery refuses flags it does not know, so the two this battery adds are
// taken out of process.argv here. `--poor` is a bot index holding NO YAPP (t2);
// `--moderator` names who signs the moderation transitions.

function takeFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const [, value] = process.argv.splice(index, 2);
  if (value === undefined) throw new Error(`${name} takes a value`);
  return value;
}
const POOR_BOT_INDEX = Number(takeFlag('--poor', '2'));
const MODERATOR_SPEC = takeFlag('--moderator', 'maker');

// ---- v8 document shapes -------------------------------------------------------

const postData = ({ content = 'v8 battery post', hashtag, quotedPostId, quotedPostOwnerId, deleted } = {}) => ({
  content,
  language: 'en',
  ...(hashtag === undefined ? {} : { hashtag }),
  ...(quotedPostId ? { quotedPostId } : {}),
  ...(quotedPostOwnerId ? { quotedPostOwnerId } : {}),
  ...(deleted === undefined ? {} : { deleted }),
});
const replyData = ({ content = 'v8 battery reply', rootPostId, parentOwnerId }) => ({ content, rootPostId, parentOwnerId });

// ---- Nonce-committed ids and the manual batch ---------------------------------

const ID_V1_DOMAIN = new TextEncoder().encode('dash:document-id:v1');

/** `dsha256(tag ‖ contract ‖ owner ‖ type ‖ entropy ‖ nonce BE)` — the id consensus recomputes (#4859). */
export function documentIdV1({ contractId, ownerId, docType, entropy, nonce }) {
  const type = new TextEncoder().encode(docType);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
  const payload = new Uint8Array(ID_V1_DOMAIN.length + 64 + type.length + entropy.length + 8);
  let offset = 0;
  for (const part of [ID_V1_DOMAIN, bs58.decode(contractId), bs58.decode(ownerId), type, entropy, nonceBytes]) {
    payload.set(part, offset);
    offset += part.length;
  }
  return sha256(sha256(payload));
}

/** An id as base58, whichever of the three shapes the SDK handed back. */
function idOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.toBase58 === 'function') return value.toBase58();
  return bs58.encode(Uint8Array.from(value));
}

/**
 * A create built by hand so it can carry `$actionFeeAgreement` (and, when the
 * caller pays in YAPP, `$tokenPaymentInfo` with a gas offer). Returns the id
 * the PROOF RESULT names, plus the id derived locally so a3 can compare them.
 * Acceptance is decided by reading the result id back; when the broadcast
 * threw before a result existed (a gateway 504 on the wait), the derived id is
 * probed instead and the outcome says so.
 */
async function manualCreate(ctx, who, { docType, data, agreement, payment }) {
  const { sdk, contractId } = ctx;
  const nonce = ((await readback(() => sdk.identities.contractNonce(who.ownerId, contractId))) ?? 0n) + 1n;
  const entropy = randomIdBytes();
  const derivedId = documentIdV1({ contractId, ownerId: who.ownerId, docType, entropy, nonce });
  const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy, id: derivedId });
  const transition = new DocumentCreateTransition({
    document,
    identityContractNonce: nonce,
    ...(payment ? { tokenPaymentInfo: payment } : {}),
    ...(agreement ? { actionFeeAgreement: agreement } : {}),
  });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(transition.toDocumentTransition())], who.ownerId, 0);
  const stateTransition = batch.toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);
  stateTransition.sign(PrivateKey.fromWIF(who.wif), who.identityKey);

  let error = null;
  let resultId = null;
  try {
    const result = await sdk.stateTransitions.broadcastAndWait(stateTransition);
    const documents = result?.documents;
    if (documents instanceof Map) for (const key of documents.keys()) resultId = idOf(key);
  } catch (e) {
    error = describeErr(e);
  }
  const probeId = resultId ?? bs58.encode(derivedId);
  for (let poll = 0; poll < 3; poll++) {
    await settle();
    if ((await fetchDocument(sdk, contractId, docType, probeId)) !== null) {
      return { ok: true, error: null, id: probeId, derivedId: bs58.encode(derivedId), resultId, fromResult: resultId !== null };
    }
  }
  return { ok: false, error: error ?? 'the SDK reported no error, but the write is not on chain', id: probeId, derivedId: bs58.encode(derivedId), resultId };
}

/** The agreement a post/reply create must carry: the declared fee at the multiplier the signer read. */
async function feeAgreement(ctx, moderators) {
  const epoch = await readback(() => ctx.sdk.epoch.current());
  const knownPermille = BigInt(epoch.feeMultiplierPermille);
  return { agreement: new DocumentActionFeeAgreement({ moderators, feeMultiplier: { knownPermille, increaseTolerancePercent: INCREASE_TOLERANCE_PERCENT } }), knownPermille };
}

/** YAPP payment with the contract owner asked to pay the gas when able. */
const yappPayment = (maximumTokenCost) => new TokenPaymentInfo({
  tokenContractPosition: YAPP_POSITION,
  maximumTokenCost: BigInt(maximumTokenCost),
  gasFeesPaidBy: PREFER_CONTRACT_OWNER,
});

/** A post by `who`, paid in credits, with the correct agreement: the fixture path. */
async function createPost(ctx, who, data, label) {
  const { agreement } = await feeAgreement(ctx, POST_FEE);
  const created = await manualCreate(ctx, who, { docType: 'post', data, agreement });
  if (!created.ok) console.log(`     (could not create ${label}: ${(created.error ?? '').slice(0, 200)})`);
  return created.ok ? created.id : null;
}

// ---- Reads -------------------------------------------------------------------------

const creditsOf = async (ctx, ownerId) => (await readback(() => ctx.sdk.identities.balance(ownerId))) ?? 0n;
async function yappOf(ctx, ownerId) {
  const balances = await readback(() => ctx.sdk.tokens.balances([ownerId], ctx.tokenId));
  return (balances instanceof Map ? balances.get(ownerId) : undefined) ?? 0n;
}
const moderatorsPot = async (ctx) => (await readback(() => ctx.sdk.contracts.feePots(ctx.contractId))).moderators;
async function standingOf(ctx, identityId) {
  return readback(() => ctx.sdk.contracts.moderationStatus({ contractId: ctx.contractId, identityId, lists: ['banlist', 'suspensions'] }));
}

// ---- Cases -------------------------------------------------------------------------

/** B follows A: the one cheap, unpriced, deletable document the ban cases need. */
async function followAsB(ctx) {
  return attemptCreate(ctx.sdk, ctx.botB, { contractId: ctx.contractId, docType: 'follow', data: followData({ followingId: bs58.decode(ctx.botA.ownerId) }) });
}

async function caseM1Ban(ctx) {
  const { sdk, contractId, botB, moderator } = ctx;
  console.log('\n--- m1. ban: writes refused (41107), deletes allowed, unban restores ---');
  const existing = await followAsB(ctx);
  expectAccepted('m1a B follows A before the ban', existing);
  // The create path assigns the id; only the RETURNED document knows it.
  const followId = existing.id;
  // The probe run before and after the ban: a DIFFERENT unpriced create from
  // the follow above, which B already holds (`follow` is unique per pair).
  const bookmarkFixture = () => attemptCreate(sdk, botB, { contractId, docType: 'bookmark', data: { postId: bs58.decode(ctx.posts.fixture) } });

  try {
    await sdk.contracts.banUser({ identity: moderator.identity, contractId, identityId: botB.ownerId, reason: { text: 'v8 battery ban' }, signer: moderator.signer });
    check('m1b moderator bans B', true);
  } catch (e) {
    check('m1b moderator bans B', false, describeErr(e).slice(0, 220));
    return;
  }
  try {
    await settle();
    const status = await standingOf(ctx, botB.ownerId);
    check('m1c moderationStatus proves the ban with its reason', status.banned === true && status.banReason?.text === 'v8 battery ban', JSON.stringify(status));
    const entries = await readback(() => sdk.contracts.moderationEntries({ contractId, list: 'banlist' }));
    check('m1d the banlist page lists B', entries.entries.some((entry) => entry.identityId === botB.ownerId), `entries=${entries.entries.length}`);

    expectRejected('m1e B\'s create while banned is refused (41107)', await bookmarkFixture(), BANNED);

    if (followId) {
      let deleteError = null;
      try {
        await sdk.documents.delete({ document: { id: followId, ownerId: botB.ownerId, dataContractId: contractId, documentTypeName: 'follow' }, identityKey: botB.identityKey, signer: botB.signer, settings: { identityNonceStaleTimeS: 0 } });
      } catch (e) {
        deleteError = describeErr(e);
      }
      await settle();
      const gone = (await fetchDocument(sdk, contractId, 'follow', followId)) === null;
      check('m1f B\'s DELETE while banned still lands (a ban bars writes, not exits)', gone, gone ? '' : `still present; ${(deleteError ?? '').slice(0, 160)}`);
    }
  } finally {
    // A ban outlives the run: whatever the probes did, B is unbanned.
    try {
      await sdk.contracts.unbanUser({ identity: moderator.identity, contractId, identityId: botB.ownerId, signer: moderator.signer });
      check('m1g moderator unbans B', true);
    } catch (e) {
      check('m1g moderator unbans B', false, `${describeErr(e).slice(0, 200)} — B MAY STILL BE BANNED; unban by hand`);
    }
  }
  await settle();
  const after = await standingOf(ctx, botB.ownerId);
  check('m1h moderationStatus proves B is no longer banned', after.banned === false, JSON.stringify(after));
  expectAccepted('m1i B\'s create lands again after the unban', await bookmarkFixture());
}

async function caseM2Suspend(ctx) {
  const { sdk, contractId, botB, moderator } = ctx;
  console.log('\n--- m2. suspend: refused (41108) until the block time lapses ---');
  const until = Date.now() + SUSPENSION_MS;
  try {
    await sdk.contracts.suspendUser({ identity: moderator.identity, contractId, identityId: botB.ownerId, until: BigInt(until), reason: { text: 'v8 battery suspension' }, signer: moderator.signer });
    check('m2a moderator suspends B for ~25 s', true);
  } catch (e) {
    check('m2a moderator suspends B for ~25 s', false, describeErr(e).slice(0, 220));
    return;
  }
  const status = await standingOf(ctx, botB.ownerId);
  check('m2b moderationStatus proves the suspension and its end', status.suspendedUntil !== undefined && Number(status.suspendedUntil) === until, JSON.stringify(status));
  const { agreement } = await feeAgreement(ctx, POST_FEE);
  expectRejected('m2c B\'s post while suspended is refused (41108)', await manualCreate(ctx, botB, { docType: 'post', data: postData({ content: 'suspended post' }), agreement }), SUSPENDED);
  // `bookmark.ownerAndPost` is unique and m1i already bookmarked the fixture, so
  // the unpriced probes here target a post of their own (A's, so B may bookmark it).
  const target = ctx.posts.m2 ?? (ctx.posts.m2 = await createPost(ctx, ctx.botA, postData({ content: 'm2 bookmark target' }), 'the m2 target'));
  const bookmarkTarget = () => attemptCreate(sdk, botB, { contractId, docType: 'bookmark', data: { postId: bs58.decode(target) } });
  if (target) {
    expectRejected('m2d …and so is an unpriced create, for the same reason', await bookmarkTarget(), SUSPENDED);
  }
  const remaining = until - Date.now() + 8000;
  console.log(`     (waiting ${Math.ceil(remaining / 1000)} s for the suspension to lapse)`);
  await settle(Math.max(remaining, 0));
  // The lapsed entry is swept by B's first transition at or after `until`.
  if (target) expectAccepted('m2e B\'s create lands once the suspension lapsed', await bookmarkTarget());
  const swept = await standingOf(ctx, botB.ownerId);
  check('m2f the lapsed suspension was swept by that write', swept.suspendedUntil === undefined, JSON.stringify(swept));
}

async function caseM3ModeratorDelete(ctx) {
  const { sdk, contractId, botA, botB, moderator } = ctx;
  console.log('\n--- m3. moderator delete: absent post, removal record, dangling references ---');
  const removed = await createPost(ctx, botB, postData({ content: 'to be removed' }), 'the post to remove');
  const quoting = removed && await createPost(ctx, botA, postData({ content: 'quoting the doomed post', quotedPostId: bs58.decode(removed), quotedPostOwnerId: bs58.decode(botB.ownerId) }), 'the quoting post');
  if (!removed || !quoting) { check('m3 fixtures', false, 'could not create the fixture posts'); return; }

  try {
    const result = await sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: 'post', documentId: removed, reason: { text: 'v8 battery takedown' }, signer: moderator.signer });
    check('m3a moderator deletes B\'s post; the proof names B as its owner', idOf(result.documentOwnerId) === botB.ownerId, `owner=${idOf(result.documentOwnerId)} removedAt=${result.removedAt}`);
  } catch (e) {
    check('m3a moderator deletes B\'s post', false, describeErr(e).slice(0, 220));
    return;
  }
  await settle();
  check('m3b the post no longer fetches', (await fetchDocument(sdk, contractId, 'post', removed)) === null);
  const removals = await readback(() => sdk.contracts.documentRemovals({ contractId, documentTypeName: 'post', documentIds: [removed] }));
  const record = removals.removals.find((entry) => entry.documentId === removed);
  check('m3c documentRemovals carries the record with the reason', record?.reason?.text === 'v8 battery takedown' && record?.documentOwnerId === botB.ownerId, JSON.stringify(record ?? removals));

  const like = await attemptCreateIndexOnly(sdk, botA, {
    contractId, docType: 'like',
    data: likeData({ postId: bs58.decode(removed), postAuthor: bs58.decode(botB.ownerId) }),
    accepted: () => entryExists(sdk, contractId, 'like', 'postId', removed, botA.ownerId),
  });
  expectRejected('m3d a like on the removed post is refused (40120)', like, REFERENCE_NOT_FOUND);

  const stored = await fetchDocument(sdk, contractId, 'post', quoting);
  const revision = BigInt(stored?.revision ?? 1);
  const keepsRef = await attemptReplace(sdk, botA, { contractId, docType: 'post', id: quoting, revision, data: postData({ content: '', quotedPostId: bs58.decode(removed), quotedPostOwnerId: bs58.decode(botB.ownerId), deleted: true }) });
  expectRejected('m3e a tombstone that KEEPS the dead quotedPostId is refused (40120: deletable refs are re-validated)', keepsRef, REFERENCE_NOT_FOUND);
  const clearsRef = await attemptReplace(sdk, botA, { contractId, docType: 'post', id: quoting, revision, data: postData({ content: '', quotedPostOwnerId: bs58.decode(botB.ownerId), deleted: true }) });
  expectAccepted('m3f a tombstone that CLEARS the dead quotedPostId lands (the one change immutable allows)', clearsRef);
  ctx.removedPostId = removed;
}

async function caseT1OptionalTokenCost(ctx) {
  const { sdk, contractId, botA, botB, ownerId } = ctx;
  console.log('\n--- t1. optional token cost: credits without payment info, YAPP + sponsored gas with it ---');
  const targets = [];
  for (const label of ['credits-paid like target', 'yapp-paid like target']) {
    const id = await createPost(ctx, botB, postData({ content: label }), label);
    if (id) targets.push(id);
  }
  if (targets.length < 2) { check('t1 fixtures', false, 'could not create the target posts'); return; }
  const likeOn = (postId, options) => attemptCreateIndexOnly(sdk, botA, {
    contractId, docType: 'like',
    data: likeData({ postId: bs58.decode(postId), postAuthor: bs58.decode(botB.ownerId) }),
    accepted: () => entryExists(sdk, contractId, 'like', 'postId', postId, botA.ownerId),
    ...options,
  });

  const [creditsBefore, yappBefore] = await Promise.all([creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  // verify-lib attaches payment info only when `tokenCost` is passed; omitting it is the credits path.
  expectAccepted('t1a like WITHOUT payment info lands', await likeOn(targets[0], {}));
  await settle();
  const [creditsAfter, yappAfter] = await Promise.all([creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  check('t1b …charging credits and no YAPP', creditsAfter < creditsBefore && yappAfter === yappBefore, `credits ${creditsBefore}→${creditsAfter} yapp ${yappBefore}→${yappAfter}`);

  const [ownerBefore, aCreditsBefore, aYappBefore] = await Promise.all([creditsOf(ctx, ownerId), creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  // verify-lib's payment info carries no gas offer, so the paid like is sent
  // by hand through the same SDK call it wraps, with PreferContractOwner.
  const paidError = await errorOf(async () => {
    const { document } = buildDocument({ contractId, docType: 'like', ownerId: botA.ownerId, data: likeData({ postId: bs58.decode(targets[1]), postAuthor: bs58.decode(botB.ownerId) }), entropy: randomIdBytes() });
    await sdk.documents.create({ document, identityKey: botA.identityKey, signer: botA.signer, tokenPaymentInfo: yappPayment(TOKEN_COST.like), settings: { identityNonceStaleTimeS: 0 } });
  });
  await settle();
  const landed = await entryExists(sdk, contractId, 'like', 'postId', targets[1], botA.ownerId);
  check('t1c like WITH payment info (PreferContractOwner gas) lands', landed, landed ? '' : (paidError ?? '').slice(0, 220));
  const [ownerAfter, aCreditsAfter, aYappAfter] = await Promise.all([creditsOf(ctx, ownerId), creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  check('t1d …charging exactly 1 YAPP', aYappBefore - aYappAfter === 1n, `yapp ${aYappBefore}→${aYappAfter}`);
  check('t1e …and the contract OWNER paid the gas (its credits moved, A\'s did not)', ownerAfter < ownerBefore && aCreditsAfter === aCreditsBefore, `owner ${ownerBefore}→${ownerAfter} A ${aCreditsBefore}→${aCreditsAfter}`);
}

async function caseT2InsufficientYapp(ctx) {
  const { sdk, contractId, botB, poor } = ctx;
  console.log('\n--- t2. payment info with insufficient YAPP is a refusal (40700), never a credits fallback ---');
  if (!poor) { console.log('SKIP  t2 needs a bot with no YAPP (--poor <index>); none resolved'); return; }
  const balance = await yappOf(ctx, poor.ownerId);
  if (balance > 0n) { console.log(`SKIP  t2: ${poor.label} holds ${balance} YAPP; pick a --poor bot with none`); return; }
  const target = await createPost(ctx, botB, postData({ content: 'poor bot target' }), 'the poor bot\'s target');
  if (!target) { check('t2 fixture', false, 'no target post'); return; }
  const error = await errorOf(async () => {
    const { document } = buildDocument({ contractId, docType: 'like', ownerId: poor.ownerId, data: likeData({ postId: bs58.decode(target), postAuthor: bs58.decode(botB.ownerId) }), entropy: randomIdBytes() });
    await sdk.documents.create({ document, identityKey: poor.identityKey, signer: poor.signer, tokenPaymentInfo: yappPayment(TOKEN_COST.like) });
  });
  await settle();
  const landed = await entryExists(sdk, contractId, 'like', 'postId', target, poor.ownerId);
  expectRejected('t2a like with payment info and 0 YAPP is refused (40700)', { ok: landed, error }, INSUFFICIENT_TOKENS);
}

async function caseA1NoAgreement(ctx) {
  console.log('\n--- a1. post create without an action fee agreement → 40132 ---');
  // sdk.documents.create has no agreement option, so this is exactly what an
  // un-upgraded client sends.
  const outcome = await attemptCreate(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'post', data: postData({ content: 'no agreement' }) });
  expectRejected('a1a post without $actionFeeAgreement is refused (40132)', outcome, AGREEMENT_NOT_SET);
}

async function caseA2MismatchedAgreement(ctx) {
  console.log('\n--- a2. post create with a mismatched agreement → 40133 ---');
  const { knownPermille } = await feeAgreement(ctx, POST_FEE);
  const wrong = new DocumentActionFeeAgreement({ moderators: 1n, feeMultiplier: { knownPermille, increaseTolerancePercent: INCREASE_TOLERANCE_PERCENT } });
  expectRejected('a2a agreement naming the wrong moderators amount is refused (40133)', await manualCreate(ctx, ctx.botA, { docType: 'post', data: postData({ content: 'wrong fee' }), agreement: wrong }), AGREEMENT_MISMATCH);
  const fixed = new DocumentActionFeeAgreement({ moderators: POST_FEE });
  expectRejected('a2b agreement to FIXED pricing on a feeMultiplier fee is the same mismatch (40133)', await manualCreate(ctx, ctx.botA, { docType: 'post', data: postData({ content: 'fixed pricing' }), agreement: fixed }), AGREEMENT_MISMATCH);
}

async function caseA3AgreedFee(ctx) {
  const { botA } = ctx;
  console.log('\n--- a3. the agreed fee lands, the derived id matches, the moderators pot grows ---');
  const potBefore = (await moderatorsPot(ctx)).credits;
  const { agreement, knownPermille } = await feeAgreement(ctx, POST_FEE);
  const post = await manualCreate(ctx, botA, { docType: 'post', data: postData({ content: 'agreed fee', hashtag: ctx.tag }), agreement });
  expectAccepted('a3a post with the declared agreement lands', post);
  if (!post.ok) return;
  ctx.posts.agreed = post.id;
  check('a3b the nonce-committed v1 id derived locally is the id Platform stored', post.fromResult && post.resultId === post.derivedId, `derived=${post.derivedId} result=${post.resultId ?? '(no result: broadcast wait threw)'}`);
  await settle();
  const potAfterPost = (await moderatorsPot(ctx)).credits;
  const expectedPostFee = (POST_FEE * knownPermille) / 1000n;
  check('a3c the moderators pot grew by 80M credits × the epoch multiplier', potAfterPost - potBefore === expectedPostFee, `pot ${potBefore}→${potAfterPost} (Δ${potAfterPost - potBefore}, expected ${expectedPostFee} at ${knownPermille}‰)`);

  const { agreement: replyAgreement } = await feeAgreement(ctx, REPLY_FEE);
  const reply = await manualCreate(ctx, botA, { docType: 'reply', data: replyData({ rootPostId: bs58.decode(post.id), parentOwnerId: bs58.decode(botA.ownerId) }), agreement: replyAgreement });
  expectAccepted('a3d reply with its own declared agreement lands', reply);
  await settle();
  const potAfterReply = (await moderatorsPot(ctx)).credits;
  check('a3e …growing the pot by 16M × multiplier', reply.ok && potAfterReply - potAfterPost === (REPLY_FEE * knownPermille) / 1000n, `Δ${potAfterReply - potAfterPost}`);
}

async function caseA4Claim(ctx) {
  const { sdk, contractId, moderator } = ctx;
  console.log('\n--- a4. claimFees pays the moderators pot to the team; once per epoch ---');
  const pot = await moderatorsPot(ctx);
  const before = await creditsOf(ctx, moderator.ownerId);
  if (pot.credits === 0n) { check('a4 pot is funded by a3', false, 'the moderators pot is empty'); return; }
  try {
    const result = await sdk.contracts.claimFees({ identity: moderator.identity, contractId, pot: 'moderators', signer: moderator.signer });
    const paid = result.balances instanceof Map ? result.balances.get(moderator.ownerId) : undefined;
    check('a4a a moderator claims the pot', true, `remaining=${result.remainingCredits} epoch=${result.lastClaimEpoch} paid=${paid}`);
    check('a4b what is left is less than one share (an equal split\'s remainder)', result.remainingCredits < pot.credits, `pot ${pot.credits} → ${result.remainingCredits}`);
  } catch (e) {
    const reason = describeErr(e);
    // A claim this epoch from an earlier run leaves nothing to prove but the refusal.
    if (ALREADY_CLAIMED_EPOCH.test(reason)) { check('a4a the pot was already claimed this epoch (an earlier run); refusal is 41111', true, reason.slice(0, 160)); return; }
    check('a4a a moderator claims the pot', false, reason.slice(0, 220));
    return;
  }
  await settle();
  const after = await creditsOf(ctx, moderator.ownerId);
  check('a4c the claimant\'s credits rose (net of the claim\'s own fee)', after > before, `${before}→${after}`);
  const second = await errorOf(() => sdk.contracts.claimFees({ identity: moderator.identity, contractId, pot: 'moderators', signer: moderator.signer }));
  expectRejected('a4d a second claim in the same epoch is refused (41111)', { ok: second === null, error: second }, ALREADY_CLAIMED_EPOCH);
}

async function caseG1StarterGrant(ctx) {
  const { sdk, contractId, botA } = ctx;
  console.log('\n--- g1. oncePerIdentity: one grant per identity (40722 after) ---');
  const claim = () => errorOf(() => sdk.tokens.claim({ dataContractId: contractId, tokenPosition: YAPP_POSITION, identityId: botA.ownerId, distributionType: 'oncePerIdentity', identityKey: botA.identityKey, signer: botA.signer }));
  const before = await yappOf(ctx, botA.ownerId);
  const first = await claim();
  await settle();
  const after = await yappOf(ctx, botA.ownerId);
  if (first === null) {
    check('g1a first claim lands and pays exactly 100 YAPP', after - before === STARTER_GRANT, `${before}→${after}`);
  } else {
    expectRejected('g1a A already claimed its grant in an earlier run (40722)', { ok: false, error: first }, GRANT_ALREADY_CLAIMED);
  }
  const again = await claim();
  expectRejected('g1b a further claim is refused (40722)', { ok: again === null, error: again }, GRANT_ALREADY_CLAIMED);
}

async function caseL1FirstLikeCounts(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- l1. the first like on a fresh post counts to 1 without a preallocated tree ---');
  const post = await createPost(ctx, botB, postData({ content: 'first like target', hashtag: ctx.tag }), 'the first-like target');
  if (!post) { check('l1 fixture', false, 'no post'); return; }
  check('l1a a fresh post has NO count entry yet (nothing preallocated it)', (await countBy(sdk, contractId, 'like', 'postId', post)) === 0);
  const like = await attemptCreateIndexOnly(sdk, botA, {
    contractId, docType: 'like',
    data: likeData({ postId: bs58.decode(post), hashtag: ctx.tag, postAuthor: bs58.decode(botB.ownerId) }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(sdk, contractId, 'like', 'postId', post, botA.ownerId),
  });
  expectAccepted('l1b the first like lands', like);
  await settle();
  check('l1c byPost counts exactly 1', (await countBy(sdk, contractId, 'like', 'postId', post)) === 1);
  const ranked = await readback(() => sdk.documents.ranked({ dataContractId: contractId, documentTypeName: 'like', groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 100 }));
  const entry = ranked.entries.find((e) => e.groupValue === post);
  check('l1d the ranked byPost axis carries the post at 1 (and no zero-count groups)', Number(entry?.value ?? -1) === 1 && ranked.entries.every((e) => Number(e.value) !== 0), `groups=${ranked.entries.length}`);
}

// ---- Registry ------------------------------------------------------------------------

/**
 * Per-run setup the cases share (contract owner, moderator signer, YAPP token
 * id, one fixture post). verify-lib has no hook between connect and the first
 * case, so the first case to run performs it; a failure aborts that case and
 * every later one sees the same error.
 */
async function ensurePrepared(ctx) {
  if (ctx.prepared === true) return;
  if (ctx.prepared instanceof Error) throw ctx.prepared;
  try {
    await prepare(ctx);
    ctx.prepared = true;
  } catch (e) {
    ctx.prepared = e instanceof Error ? e : new Error(String(e));
    throw ctx.prepared;
  }
}

async function prepare(ctx) {
  const contract = await readback(() => ctx.sdk.contracts.fetch(ctx.contractId));
  ctx.ownerId = contract.ownerId.toBase58();
  ctx.tokenId = await readback(() => ctx.sdk.tokens.calculateId(ctx.contractId, YAPP_POSITION));
  ctx.moderator = await resolveModerator(ctx.sdk);
  ctx.poor = await resolvePoorBot(ctx.sdk);
  console.log(`contract owner: ${ctx.ownerId}; moderator: ${ctx.moderator.label}; poor bot: ${ctx.poor?.label ?? 'none'}`);
  const moderation = contract.config.moderation;
  check('the contract declares banlist + suspensions moderation', moderation?.banlist === true && moderation?.suspensions === true, JSON.stringify(moderation));
  // One fixture post by B that the ban/suspend probes bookmark.
  ctx.posts.fixture = await createPost(ctx, ctx.botB, postData({ content: 'v8 battery fixture' }), 'the fixture post');
  if (!ctx.posts.fixture) throw new Error('could not create the fixture post (does B hold credits, and did the agreement match?)');
}

const prepared = (run) => async (ctx) => { await ensurePrepared(ctx); return run(ctx); };

const CASES = new Map([
  ['m1', prepared(caseM1Ban)],
  ['m2', prepared(caseM2Suspend)],
  ['m3', prepared(caseM3ModeratorDelete)],
  ['t1', prepared(caseT1OptionalTokenCost)],
  ['t2', prepared(caseT2InsufficientYapp)],
  ['a1', prepared(caseA1NoAgreement)],
  ['a2', prepared(caseA2MismatchedAgreement)],
  ['a3', prepared(caseA3AgreedFee)],
  ['a4', prepared(caseA4Claim)],
  ['g1', prepared(caseG1StarterGrant)],
  ['l1', prepared(caseL1FirstLikeCounts)],
]);

/** The WIF a bot signs manual batches with: the same CRITICAL key verify-lib's signer holds. */
function wifForBot(index) {
  return criticalAuthKey(deriveIdentityKeys(index)).wif;
}

/** The moderating identity, its signer and (fetched) Identity, from `--moderator`. */
async function resolveModerator(sdk) {
  const owner = MODERATOR_SPEC === 'maker'
    ? resolveOwner({ maker: true })
    : resolveOwner({ botIndex: Number(MODERATOR_SPEC.replace(/^bot:/, '')) });
  const { identityKey, signer } = await signerFor(sdk, owner);
  const identity = await sdk.identities.fetch(owner.ownerId);
  return { ownerId: owner.ownerId, identity, identityKey, signer, label: owner.label };
}

async function resolvePoorBot(sdk) {
  const ownerId = loadIdentityIds()[POOR_BOT_INDEX];
  if (!ownerId) return null;
  try {
    const owner = resolveOwner({ botIndex: POOR_BOT_INDEX, ownerId });
    const { identityKey, signer } = await signerFor(sdk, owner);
    return { ownerId, identityKey, signer, label: owner.label };
  } catch (e) {
    console.log(`     (no poor bot: ${describeErr(e).slice(0, 120)})`);
    return null;
  }
}

const someId = randomIdBytes;
const botIndexArg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i === -1 ? fallback : Number(process.argv[i + 1]); };

if (process.argv.includes('--self-test') || process.argv.includes('--dry-run')) {
  // The id derivation is pure; prove it is deterministic and nonce-sensitive
  // before any shape is built.
  const fixed = { contractId: bs58.encode(new Uint8Array(32).fill(1)), ownerId: bs58.encode(new Uint8Array(32).fill(2)), docType: 'note', entropy: new Uint8Array(32).fill(7) };
  const a = bs58.encode(documentIdV1({ ...fixed, nonce: 1n }));
  const b = bs58.encode(documentIdV1({ ...fixed, nonce: 1n }));
  const c = bs58.encode(documentIdV1({ ...fixed, nonce: 2n }));
  console.log(`v1 id derivation: deterministic=${a === b} nonce-sensitive=${a !== c} (${a})`);
  if (a !== b || a === c) { console.error('FAIL  v1 id derivation'); process.exit(1); }
}

await runBattery({
  name: 'v8',
  contractEnvVar: 'V8_CONTRACT_ID',
  usage:
    'Usage: node scripts/verify-v8.mjs --contract <id> [--bot <n>] [--bot2 <n>] [--poor <n>]\n' +
    '       [--moderator maker|bot:<n>] [--owner <id>] [--owner2 <id>] [--only m1,a3] [--dry-run|--self-test]',
  cases: CASES,
  shapes: [
    ['post (credits, agreed fee)', 'post', postData()],
    ['post (quote)', 'post', postData({ quotedPostId: someId(), quotedPostOwnerId: someId() })],
    ['reply', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId() })],
    ['like', 'like', likeData({ postId: someId(), postAuthor: someId() })],
    ['like (tagged)', 'like', likeData({ postId: someId(), hashtag: 'v8tag', postAuthor: someId() })],
    ['bookmark', 'bookmark', { postId: someId() }],
    ['follow', 'follow', followData({ followingId: someId() })],
  ],
  replaceShapes: [
    ['post (tombstone, dead quote cleared)', 'post', postData({ content: '', quotedPostOwnerId: someId(), deleted: true })],
  ],
  makeContext: ({ sdk, contractId, botA, botB }) => ({
    sdk,
    contractId,
    botA: { ...botA, wif: wifForBot(botIndexArg('--bot', 0)) },
    botB: { ...botB, wif: wifForBot(botIndexArg('--bot2', 1)) },
    tag: `v8b${Date.now().toString(36)}`,
    posts: {},
    removedPostId: null,
    // Filled by `ensurePrepared` from the first case that runs.
    prepared: false,
    moderator: null,
    poor: null,
    ownerId: null,
    tokenId: null,
  }),
  summarize: (ctx) => {
    console.log(`run tag: #${ctx.tag}`);
    console.log(`fixture posts: ${JSON.stringify(ctx.posts)} removed: ${ctx.removedPostId}`);
  },
});
